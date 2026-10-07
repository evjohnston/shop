#!/usr/bin/env python3
"""
Export Fourthwall products to a Square item-library import CSV and download
the product photos.

Uses the Fourthwall Platform (Open) API with your shop's Open API user:
  Fourthwall dashboard > Settings > For Developers > Open API > Create API User

Usage:
  pip install requests
  export FOURTHWALL_USER="..."   # Open API username
  export FOURTHWALL_PASS="..."   # Open API password
  python fourthwall_export.py --out fourthwall_export --shop-url https://yourshop.com

Re-running is cheap: photos already in <out>/assets are found first and only
missing ones are downloaded. Add --from-json to skip the Fourthwall API
entirely and rebuild the CSV from the products.json saved by the last run.

Output:
  square_import.csv     one row per variant, Square column layout
  checkout_links.csv    one row per variant: product, variant, direct checkout link
  products.json         raw Fourthwall data (kept for re-runs and checking)
  shop.json             shop info from the API (used to find the shop address)
  assets/<product>/     photos, named by a hash of their URL
  assets_manifest.csv   which photo came from which product and URL
"""

import argparse
import csv
import hashlib
import json
import mimetypes
import os
import re
import sys
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

import requests

BASE = "https://api.fourthwall.com/open-api/v1.0"
PAGE_SIZE = 100          # API caps page size at 100
MIN_INTERVAL = 0.12      # documented limit is 100 requests / 10 s per shop
DEFAULT_LOCATION = "Association of Internet Researchers"


def square_columns(location):
    return [
        "Reference Handle", "Token", "Item Name", "Customer-facing Name",
        "Variation Name", "SKU", "Description", "Categories", "Reporting Category",
        "GTIN", "Item Type", "Weight (lb)", "Social Media Link Title",
        "Social Media Link Description", "Price", "Online Sale Price", "Archived",
        "Sellable", "Contains Alcohol", "Stockable", "Skip Detail Screen in POS",
        "Preselect First Variation", "Option Name 1", "Option Value 1",
        f"Current Quantity {location}", f"New Quantity {location}",
        f"Stock Alert Enabled {location}", f"Stock Alert Count {location}",
    ]


# ---------------------------------------------------------------- API calls

_last_call = 0.0


def api_get(session, path, params=None, retries=5):
    """GET with throttling and backoff on 429/5xx."""
    global _last_call
    url = f"{BASE}{path}"
    for attempt in range(retries):
        wait = MIN_INTERVAL - (time.time() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.time()

        r = session.get(url, params=params, timeout=60)
        if r.status_code == 429 or r.status_code >= 500:
            delay = float(r.headers.get("Retry-After", 2 ** attempt))
            print(f"  {r.status_code} on {path}, retrying in {delay:.0f}s", file=sys.stderr)
            time.sleep(delay)
            continue
        if r.status_code == 401:
            sys.exit("401 Unauthorized: check FOURTHWALL_USER / FOURTHWALL_PASS")
        r.raise_for_status()
        return r.json()
    raise RuntimeError(f"Gave up on {path} after {retries} attempts")


def list_paged(session, path, label):
    """Page through a list endpoint (zero-based page, size<=100)."""
    items, page = [], 0
    while True:
        data = api_get(session, path, {"page": page, "size": PAGE_SIZE})
        batch = data.get("results", []) if isinstance(data, dict) else (data or [])
        items.extend(batch)
        total_pages = data.get("totalPages") if isinstance(data, dict) else None
        page += 1
        if not batch:
            break
        if total_pages is not None and page >= total_pages:
            break
        if total_pages is None and len(batch) < PAGE_SIZE:
            break
    print(f"  {label}: {len(items)}")
    return items


def stock_info(variant):
    """('UNLIMITED', None), ('LIMITED', n), or (None, None) if the variant doesn't say."""
    s = variant.get("stock")
    if isinstance(s, dict):
        if str(s.get("type", "")).upper() == "UNLIMITED":
            return "UNLIMITED", None
        for k in ("inStock", "quantity", "available"):
            val = s.get(k)
            if isinstance(val, (int, float)) and not isinstance(val, bool):
                return "LIMITED", int(val)
    return None, None


def fetch_products(api, args):
    print("Listing products...")
    products = list_paged(api, "/products", "products")
    products = list({p["id"]: p for p in products if p.get("id")}.values())

    # Only call the per-product endpoint when the list data is missing pieces.
    need_detail = [p for p in products
                   if args.full_detail or not (p.get("variants") and "images" in p)]
    if need_detail:
        print(f"Fetching detail for {len(need_detail)} products...")
    for i, p in enumerate(need_detail, 1):
        try:
            p.update(api_get(api, f"/products/{p['id']}"))
        except Exception as e:
            print(f"  detail failed for {p['id']}: {e}", file=sys.stderr)
        if i % 25 == 0:
            print(f"  {i}/{len(need_detail)}")

    if not args.no_inventory:
        need_inv = [p for p in products
                    if any(stock_info(v)[0] is None for v in p.get("variants") or [])]
        if need_inv:
            print(f"Fetching inventory for {len(need_inv)} products...")
        for p in need_inv:
            try:
                p["_inventory"] = api_get(api, f"/products/{p['id']}/inventory")
            except Exception as e:
                p["_inventory_error"] = str(e)
    return products


def fetch_categories(api):
    """Map product id -> list of collection names (skips the built-in 'all')."""
    mapping = {}
    print("Listing collections...")
    try:
        collections = list_paged(api, "/collections", "collections")
    except Exception as e:
        print(f"  collections failed: {e}", file=sys.stderr)
        return mapping
    for c in collections:
        name = c.get("name") or c.get("slug") or ""
        if (c.get("slug") or "").lower() == "all" or name.lower() == "all":
            continue
        try:
            prods = list_paged(api, f"/collections/{c['id']}/products", f"collection '{name}'")
        except Exception as e:
            print(f"  collection {name} failed: {e}", file=sys.stderr)
            continue
        for pr in prods:
            pid = pr.get("id") or (pr.get("offer") or {}).get("id")
            if pid and name not in mapping.setdefault(pid, []):
                mapping[pid].append(name)
    return mapping


# ------------------------------------------------------- field conversions

class _HTMLText(HTMLParser):
    BLOCK = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr"}

    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == "li":
            self.parts.append("\n- ")
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.BLOCK and tag not in ("br", "li"):
            self.parts.append("\n")

    def handle_data(self, data):
        self.parts.append(data)


def html_to_text(s):
    if not s:
        return ""
    p = _HTMLText()
    p.feed(s)
    p.close()
    text = re.sub(r"[ \t]+", " ", "".join(p.parts))
    text = re.sub(r" *\n *", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def amount(m):
    if isinstance(m, dict):
        m = m.get("value", m.get("amount"))
    try:
        return f"{float(m):.2f}"
    except (TypeError, ValueError):
        return ""


def variant_price(v):
    for k in ("unitPrice", "price", "sellingPrice", "retailPrice"):
        a = amount(v.get(k))
        if a:
            return a
    return ""


LB_PER_UNIT = {"LB": 1.0, "POUND": 1.0, "OZ": 1 / 16, "OUNCE": 1 / 16,
               "KG": 2.20462, "KILOGRAM": 2.20462, "G": 0.00220462, "GRAM": 0.00220462}


def weight_lb(*objs):
    """Variant weight first, then product weight. Blank if no unit is given."""
    for o in objs:
        w = (o or {}).get("weight")
        if isinstance(w, dict):
            unit = str(w.get("unit", "")).upper()
            unit = {"LBS": "LB", "POUNDS": "POUND", "OUNCES": "OUNCE",
                    "KILOGRAMS": "KILOGRAM", "GRAMS": "GRAM"}.get(unit, unit)
            val = w.get("value")
            if isinstance(val, (int, float)) and unit in LB_PER_UNIT:
                return f"{val * LB_PER_UNIT[unit]:.3f}".rstrip("0").rstrip(".")
    return ""


def gtin(v):
    for k in ("gtin", "upc", "ean", "barcode"):
        if v.get(k):
            return str(v[k])
    return ""


def variant_attrs(v):
    a = v.get("attributes") or {}

    def name_of(x):
        return x.get("name") if isinstance(x, dict) else x

    return name_of(a.get("color")), name_of(a.get("size")), a.get("description")


def is_archived(p):
    return "ARCHIV" in json.dumps([p.get("state"), p.get("status")]).upper()


def is_unbuyable(p):
    """Fourthwall refuses checkout for SOLD_OUT products: /cart/checkout will
    not create a session and bounces to ?error_message=Checkout unknown error.
    A link for one is dead on arrival, and one in a multi-item cart kills the
    whole cart, so don't mint links or print QR cards for them."""
    state = ((p.get("state") or {}).get("type") or "").upper()
    return is_archived(p) or state == "SOLD_OUT"


def is_digital(p):
    return any("DIGITAL" in str(p.get(k, "")).upper()
               for k in ("type", "productType", "offerType", "kind"))


def inventory_lookup(inv, variant_id):
    """Find a stock count for variant_id anywhere in an /inventory response."""
    found = None

    def walk(o):
        nonlocal found
        if found is not None:
            return
        if isinstance(o, dict):
            if variant_id in (o.get("id"), o.get("variantId"), o.get("offerVariantId")):
                for k in ("inStock", "quantity", "available", "stock", "count"):
                    val = o.get(k)
                    if isinstance(val, dict):
                        if str(val.get("type", "")).upper() == "UNLIMITED":
                            found = "UNLIMITED"
                            return
                        val = val.get("inStock", val.get("quantity"))
                    if isinstance(val, (int, float)) and not isinstance(val, bool):
                        found = int(val)
                        return
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(inv)
    return found


def option_for_item(variants):
    """
    Square has one option column here, so pick what actually varies.
    Returns (option_name, [value per variant]) or ("", [...]) for single-variant items.
    """
    if len(variants) <= 1:
        return "", [""] * len(variants)
    attrs = [variant_attrs(v) for v in variants]
    colors = {c for c, _, _ in attrs if c}
    sizes = {s for _, s, _ in attrs if s}

    if len(colors) > 1 and len(sizes) > 1:
        name, vals = "Color / Size", [f"{c} / {s}" if c and s else "" for c, s, _ in attrs]
    elif len(sizes) > 1:
        name, vals = "Size", [s or "" for _, s, _ in attrs]
    elif len(colors) > 1:
        name, vals = "Color", [c or "" for c, _, _ in attrs]
    else:
        name, vals = "Style", [""] * len(attrs)

    # Square rejects blank or repeated values within an item; fall back to the
    # variant's own description/name in that case.
    if "" in vals or len(set(vals)) < len(vals):
        name = "Style"
        vals = [d or v.get("name") or v.get("sku") or v.get("id") or f"Option {i + 1}"
                for i, ((_, _, d), v) in enumerate(zip(attrs, variants))]
        if len(set(vals)) < len(vals):
            vals = [f"{val} ({v.get('sku') or v.get('id')})" for val, v in zip(vals, variants)]
    return name, vals


def build_square_rows(products, args, categories):
    loc = args.location
    cols = square_columns(loc)
    name_counts = Counter((p.get("name") or "").strip() for p in products)
    rows = []

    for p in products:
        archived = is_archived(p)
        if archived and args.skip_archived:
            continue

        variants = p.get("variants") or [{}]
        display_name = (p.get("name") or p.get("slug") or p.get("id") or "").strip()
        # Square groups rows by item, so two Fourthwall products with the same
        # name would merge into one item. Disambiguate the internal name.
        item_name = display_name
        if name_counts[display_name] > 1:
            item_name = f"{display_name} ({p.get('slug') or p.get('id')})"

        desc = p.get("description") or ""
        if not args.keep_html:
            desc = html_to_text(desc)

        cats = categories.get(p.get("id")) or ([args.category] if args.category else [])
        digital = is_digital(p)
        opt_name, opt_vals = option_for_item(variants)
        multi = len(variants) > 1

        for v, opt_val in zip(variants, opt_vals):
            kind, qty = stock_info(v)
            if kind is None and "_inventory" in p:
                found = inventory_lookup(p["_inventory"], v.get("id"))
                if isinstance(found, int):
                    kind, qty = "LIMITED", found
            qty_str = str(qty) if kind == "LIMITED" and qty is not None else ""

            row = dict.fromkeys(cols, "")
            row.update({
                "Item Name": item_name,
                "Customer-facing Name": display_name,
                "Variation Name": opt_val if multi else "Regular",
                "SKU": v.get("sku") or "",
                "Description": desc,
                "Categories": ", ".join(cats),
                "Reporting Category": cats[0] if cats else "",
                "GTIN": gtin(v),
                "Item Type": "Digital" if digital else "Physical good",
                "Weight (lb)": "" if digital else weight_lb(v, p),
                "Price": variant_price(v),
                "Archived": "Y" if archived else "N",
                "Sellable": "Y",
                "Contains Alcohol": "N",
                "Stockable": "N" if digital else "Y",
                "Skip Detail Screen in POS": "N" if multi else "Y",
                "Preselect First Variation": "N",
                "Option Name 1": opt_name if multi else "",
                "Option Value 1": opt_val if multi else "",
                f"Stock Alert Enabled {loc}": "N",
            })
            if qty_str and args.stock != "none":
                row[f"{args.stock.capitalize()} Quantity {loc}"] = qty_str
            rows.append(row)
    return cols, rows


# ----------------------------------------------------------- checkout links

def shop_url_from(shop):
    """Best guess at the shop's public address from /shops/current.

    `domain` is often Fourthwall's internal shop slug ("my-shop-name"), not a
    hostname, so only accept a candidate that actually looks like one. A bare
    slug falls back to the <slug>.fourthwall.com address Fourthwall gives every
    shop, which always resolves even without a custom domain.
    """
    shop = shop or {}
    keys = ("publicDomain", "customDomain", "primaryDomain", "publicUrl", "url", "domain")

    for k in keys:
        val = (shop.get(k) or "").strip() if isinstance(shop.get(k), str) else ""
        if not val:
            continue
        host = val.split("://", 1)[-1].split("/", 1)[0]
        if "." in host:  # a real hostname, e.g. shop.aoir.org
            return val

    for k in keys:
        val = (shop.get(k) or "").strip() if isinstance(shop.get(k), str) else ""
        if val and "." not in val and "/" not in val:
            return f"{val}.fourthwall.com"
    return ""


def variant_label(v):
    color, size, desc = variant_attrs(v)
    parts = [x for x in (color, size) if x]
    return " / ".join(parts) or desc or v.get("name") or ""


def write_links_csv(products, out, shop_url):
    """One row per variant with a link that adds it to the cart and opens checkout."""
    base = shop_url.strip().rstrip("/")
    if not base.startswith(("http://", "https://")):
        base = "https://" + base

    count = 0
    with open(out / "checkout_links.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Product", "Variant", "Checkout Link"])
        skipped = 0
        for p in products:
            if is_unbuyable(p):   # no checkout session is possible, so no link
                skipped += 1
                continue
            name = (p.get("name") or p.get("slug") or "").strip()
            for v in p.get("variants") or []:
                vid = v.get("id")
                if not vid:
                    continue
                w.writerow([name, variant_label(v), f"{base}/cart/checkout?products={vid}:1"])
                count += 1
    print(f"Wrote checkout_links.csv: {count} links"
          + (f" ({skipped} products skipped: archived or sold out)" if skipped else ""))


# ------------------------------------------------------------------ images

IMAGE_EXT = re.compile(r"\.(png|jpe?g|webp|gif|avif|svg)(\?|$)", re.I)
RESIZED_COPY_KEYS = {"transformedurl", "thumbnailurl"}  # resized versions of `url`


def find_image_urls(obj, path=""):
    """Yield (json_path, url) for anything that looks like an image URL."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k.lower() in RESIZED_COPY_KEYS and isinstance(obj.get("url"), str):
                continue
            yield from find_image_urls(v, f"{path}.{k}" if path else k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from find_image_urls(v, f"{path}[{i}]")
    elif isinstance(obj, str) and obj.startswith(("http://", "https://")):
        key = path.lower()
        if (IMAGE_EXT.search(obj) or "image" in key or "thumbnail" in key
                or "cdn.fourthwall.com" in obj):
            yield path, obj


def url_stem(url):
    return hashlib.sha1(url.encode()).hexdigest()[:16]


def scan_existing(out):
    """Photos already on disk from earlier runs, keyed by URL hash."""
    have = {}
    assets = out / "assets"
    if assets.exists():
        for f in assets.rglob("*"):
            if f.is_file() and f.suffix != ".part" and f.stat().st_size > 0:
                have.setdefault(f.stem, f.relative_to(out).as_posix())
    return have


_tls = threading.local()


def download(url, dest_dir):
    """Download to a .part file and rename, so an interrupted run never leaves
    a half-written photo that the next run would mistake for a finished one."""
    if not hasattr(_tls, "session"):
        _tls.session = requests.Session()  # no Fourthwall auth sent to the CDN
    dest_dir.mkdir(parents=True, exist_ok=True)
    r = _tls.session.get(url, timeout=120, stream=True)
    r.raise_for_status()
    ext = Path(urlparse(url).path).suffix.lower()
    if not ext or len(ext) > 6:
        ext = mimetypes.guess_extension(r.headers.get("Content-Type", "").split(";")[0]) or ".bin"
    target = dest_dir / f"{url_stem(url)}{ext}"
    tmp = target.with_name(target.name + ".part")
    with open(tmp, "wb") as f:
        for chunk in r.iter_content(65536):
            f.write(chunk)
    tmp.replace(target)
    return target


def safe_name(s, fallback="item"):
    s = re.sub(r"[^\w\-.]+", "_", str(s or "")).strip("._")
    return s[:80] or fallback


def download_images(products, media, out, have, workers):
    jobs = {}  # url -> (folder, product_id, product_name, json_path)
    for p in products:
        folder = out / "assets" / safe_name(p.get("slug") or p.get("name"), p.get("id", "product"))
        for jp, url in find_image_urls(p):
            jobs.setdefault(url, (folder, p.get("id"), p.get("name"), jp))
    for jp, url in find_image_urls(media):
        jobs.setdefault(url, (out / "assets" / "_media_library", "", "media library", jp))

    results = {u: ("already had", have[url_stem(u)]) for u in jobs if url_stem(u) in have}
    todo = [u for u in jobs if u not in results]
    print(f"Photos: {len(jobs)} referenced, {len(results)} already downloaded, {len(todo)} to fetch")

    if todo:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futures = {ex.submit(download, u, jobs[u][0]): u for u in todo}
            for i, fut in enumerate(as_completed(futures), 1):
                u = futures[fut]
                try:
                    results[u] = ("downloaded", fut.result().relative_to(out).as_posix())
                except Exception as e:
                    results[u] = ("error", str(e))
                    print(f"  failed: {u} ({e})", file=sys.stderr)
                if i % 50 == 0 or i == len(todo):
                    print(f"  {i}/{len(todo)}")

    with open(out / "assets_manifest.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["product_id", "product_name", "json_path", "url", "status", "file"])
        for u, (folder, pid, pname, jp) in jobs.items():
            status, file = results[u]
            w.writerow([pid, pname, jp, u, status, file if status != "error" else ""])
    errors = sum(1 for s, _ in results.values() if s == "error")
    if errors:
        print(f"  {errors} photos failed; re-run to retry just those")


# -------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="fourthwall_export")
    ap.add_argument("--location", default=DEFAULT_LOCATION,
                    help="Square location name used in the quantity column headers")
    ap.add_argument("--shop-url", default="",
                    help="your shop's address, e.g. https://yourshop.com, for checkout_links.csv")
    ap.add_argument("--from-json", action="store_true",
                    help="skip the API and reuse <out>/products.json from the last run")
    ap.add_argument("--full-detail", action="store_true",
                    help="always fetch each product individually, even if the list looks complete")
    ap.add_argument("--no-inventory", action="store_true")
    ap.add_argument("--no-media", action="store_true", help="skip the shop media library")
    ap.add_argument("--no-download", action="store_true", help="CSV only, no photos")
    ap.add_argument("--workers", type=int, default=8, help="parallel photo downloads")
    ap.add_argument("--categories-from-collections", action="store_true",
                    help="fill Categories with each product's Fourthwall collection names")
    ap.add_argument("--category", default="", help="category to use when none is found")
    ap.add_argument("--skip-archived", action="store_true")
    ap.add_argument("--keep-html", action="store_true",
                    help="keep HTML tags in descriptions instead of converting to plain text")
    ap.add_argument("--stock", choices=["new", "current", "none"], default="new",
                    help="which Square quantity column gets Fourthwall's stock count")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    # Check what's already been received before asking Fourthwall for anything.
    have = scan_existing(out)
    print(f"Found {len(have)} photos already in {out / 'assets'}")

    products_path = out / "products.json"
    cats_path = out / "categories.json"
    media_path = out / "media_library.json"
    shop_path = out / "shop.json"
    categories, media, shop = {}, [], {}

    if args.from_json:
        if not products_path.exists():
            sys.exit(f"--from-json: {products_path} not found; run once without it first")
        products = json.loads(products_path.read_text())
        if cats_path.exists():
            categories = json.loads(cats_path.read_text())
        if media_path.exists() and not args.no_media:
            media = json.loads(media_path.read_text())
        if shop_path.exists():
            shop = json.loads(shop_path.read_text())
        print(f"Loaded {len(products)} products from {products_path}")
    else:
        user, pw = os.environ.get("FOURTHWALL_USER"), os.environ.get("FOURTHWALL_PASS")
        if not user or not pw:
            sys.exit("Set FOURTHWALL_USER and FOURTHWALL_PASS (Open API user credentials).")
        api = requests.Session()
        api.auth = (user, pw)
        api.headers["Accept"] = "application/json"

        shop = api_get(api, "/shops/current")
        shop_path.write_text(json.dumps(shop, indent=2, ensure_ascii=False))
        print(f"Shop: {shop.get('name')} ({shop.get('id')})")

        products = fetch_products(api, args)
        products_path.write_text(json.dumps(products, indent=2, ensure_ascii=False))

        if args.categories_from_collections:
            categories = fetch_categories(api)
            cats_path.write_text(json.dumps(categories, indent=2, ensure_ascii=False))

        if not args.no_media and not args.no_download:
            try:
                media = api_get(api, "/media/images")
                media_path.write_text(json.dumps(media, indent=2, ensure_ascii=False))
            except Exception as e:
                print(f"Media library fetch failed: {e}", file=sys.stderr)

    cols, rows = build_square_rows(products, args, categories)
    with open(out / "square_import.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    print(f"Wrote square_import.csv: {len(rows)} rows from {len(products)} products")

    shop_url = args.shop_url or shop_url_from(shop)
    if shop_url:
        write_links_csv(products, out, shop_url)
    else:
        print("Skipped checkout_links.csv: couldn't find your shop address. "
              "Re-run with --shop-url https://yourshop.com", file=sys.stderr)

    if not args.no_download:
        download_images(products, media, out, have, args.workers)

    print(f"Done. Output in {out.resolve()}")


if __name__ == "__main__":
    main()