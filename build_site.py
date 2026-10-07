#!/usr/bin/env python3
"""
Build the iPad kiosk storefront from the Fourthwall export.

Reads fourthwall_export/ (products.json, checkout_links.csv, assets/) and
writes a self-contained static site to site/ that needs no server-side code
and no network once loaded:

  site/index.html      copied from site_src/
  site/app.js          copied from site_src/
  site/styles.css      copied from site_src/
  site/data.json       catalog: products, variants, checkout links
  site/img/*.webp      resized photos

QR codes are generated in the browser (site_src/qrcode.js, MIT), because a
cart is an arbitrary combination of variants and cannot be precomputed.

Usage:
  pip install "qrcode[pil]" pillow
  python build_site.py
  python build_site.py --no-images     # rebuild data.json only (fast)
"""

import argparse
import csv
import hashlib
import html
import json
import re
import shutil
import sys
from pathlib import Path

from PIL import Image

# ---------------------------------------------------------------- catalog fixes
# Two products share the name "AoIRchive Hooded Sweatshirt w/ Full Design" with
# different SKUs and photos. The "-2" slug was created 19s earlier, so the plain
# slug is the newer one and the one we show.
HIDE_SLUGS = {"aoirchive-hooded-sweatshirt-w-full-design-2"}
# Fourthwall ENFORCES state=SOLD_OUT at checkout: /cart/checkout refuses to
# create a session and bounces to ?error_message=Checkout unknown error. Tested
# 5/5 sold-out products fail, 3/3 available ones succeed, and one in a bag kills
# the whole cart. These are discontinued, so they are dropped from the shop
# entirely. Set a product available again in Fourthwall and it comes straight
# back on the next build.
# "Copy of X" products are accidental Fourthwall duplicates of a product we
# already list. Drop them so the same shirt doesn't appear twice.
HIDE_NAME_PREFIXES = ("copy of",)

CATEGORIES = [
    ("tees",       "T-Shirts",            r"\btee\b|t-shirt|tshirt|long sleeve"),
    ("hoodies",    "Hoodies & Outerwear", r"hooded sweatshirt|hoodie|crewneck|zip up|jacket"),
    ("jerseys",    "Jerseys & Polos",     r"baseball jersey|polo"),
    ("hats",       "Hats",                r"\bcap\b|\bhat\b"),
    ("bags",       "Bags",                r"tote|backpack|laptop sleeve"),
    ("drinkware",  "Drinkware",           r"mug"),
    ("stickers",   "Stickers & Patches",  r"sticker|patch|cdmx logo"),
    ("desk",       "Desk",                r"mousepad|mouse pad|notebook"),
]

# The shop's actual Fourthwall collections. Membership is by exact product name
# because the list endpoint doesn't return collections; run
#   python3 main.py --categories-from-collections
# to write fourthwall_export/categories.json and this is replaced by the real
# mapping from the API.
COLLECTIONS = [
    ("aoir2026", "AoIR2026 Collection", [
        "AoIR CDMX Logo Sticker - Pink",
        "AoIR CDMX Logo - Orange",
        "AoIR2026 Regenerations Unisex Conference Tee 'se habla español' - Orange",
        "AoIR2026 Regenerations Unisex Conference Tee 'se habla español' - Pink",
        "AoIR2026 Regenerations Unisex Conference Tee - Pink",
        "AoIR2026 Regenerations Unisex Conference Tee - Orange",
        "AoIR2026 Regenerations Unisex Conference Hoodie - Pink",
        "AoIR2026 Regenerations Unisex Conference Hoodie - Orange",
        "AoIR2026 Conference Patch - CDMX",
    ]),
    ("aoirchive", "AoIRchive Collection", "^aoirchive"),          # a prefix rule, not a list
    ("seriousness", "'In All Seriousness' Collection", [
        "'Tech Support' Unisex Tee",
        "'I Survived the Listserv' Unisex Tee",
        "'Online Safety' Unisex Tee",
        "'AIR-L Inbox Overload' Unisex Tee",
        "'Conference Wifi' Unisex Tee",
        "'Reply-all Disasters' Unisex Tee",
        "'Platform Engagement' Unisex Tee",
        "'AoIR Karaoke' Unisex Tee",
        "'14.4 Baud' Unisex Tee",
    ]),
    ("influencer", "Influencers Collection", [
        "'Influencer?' Tenure Version - Unisex Tee",
        "'I coded 2000 tiktoks...' - Unisex Tee",
        "'Context collapse...' - Unisex Tee",
        "'Impact factor is just engagement...' - Unisex Tee",
        "'I am an AoIR Influencer' V2 - Unisex Tee",
        "'I am an AoIR Influencer' V1 Unisex Tee",
        '\'Parasocial with Everyone..." - Unisex Tee',
        "'I do aspirational labor' - Unisex Tee",
        "'Brand deals and grants' - Unisex Tee",
        "'Yes, Internet Influencer is a Job' - Unisex Tee",
        "'Influencer?' Dissertation Version - Unisex Tee",
        "'My H-Index is higher' - Unisex Tee",
        "'My paper went viral' - Unisex Tee",
    ]),
]

SIZE_ORDER = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL",
              "11oz", "15oz", "One size"]

CARD_W, DETAIL_W = 560, 1100
MAX_IMAGES_PER_COLOR = 4


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "x"


def classify(name, table, default=None):
    low = name.lower()
    for cid, label, pat in table:
        if re.search(pat, low):
            return cid
    return default


def collections_for(name, api_map=None):
    """API collection names when we have them, else the rules above."""
    if api_map is not None:
        return api_map
    out = []
    for cid, label, rule in COLLECTIONS:
        if isinstance(rule, str):
            if re.search(rule, name.lower()):
                out.append(cid)
        elif name in rule:
            out.append(cid)
    return out


def size_key(s):
    try:
        return (0, SIZE_ORDER.index(s))
    except ValueError:
        return (1, s)


class Images:
    """Resize once, reuse everywhere, keyed by source file + width."""

    def __init__(self, root, outdir, enabled=True):
        self.root, self.outdir, self.enabled = root, outdir, enabled
        self.cache, self.written = {}, 0
        if enabled:
            outdir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _backdrop(im):
        """Average the four corners. Product shots sit on a flat background, so
        this is the colour to letterbox against when the photo doesn't fill its
        box - the image then looks like it floats, at any aspect ratio."""
        im = im.convert("RGB")
        w, h = im.size
        pts = [im.getpixel((1, 1)), im.getpixel((w - 2, 1)),
               im.getpixel((1, h - 2)), im.getpixel((w - 2, h - 2))]
        return "#%02x%02x%02x" % tuple(sum(c[i] for c in pts) // 4 for i in range(3))

    def get(self, local_rel, width):
        """-> {"src":..., "bg":...} or None"""
        if not local_rel:
            return None
        key = (local_rel, width)
        if key in self.cache:
            return self.cache[key]

        src = self.root / local_rel
        if not src.exists():
            self.cache[key] = None
            return None

        digest = hashlib.sha1(f"{local_rel}|{width}".encode()).hexdigest()[:14]
        name = f"{digest}.webp"
        dest = self.outdir / name
        rel = f"img/{name}"

        bg, alpha = "", False
        try:
            with Image.open(src) as im:
                # Most of these shots are cut-outs with a real alpha channel.
                # Flattening them (im.convert("RGB")) paints the product onto
                # black, which is wrong on any page. Keep the alpha and let CSS
                # decide the backdrop.
                has_alpha = im.mode in ("RGBA", "LA", "P") and (
                    im.mode != "P" or "transparency" in im.info
                )
                im = im.convert("RGBA" if has_alpha else "RGB")
                if has_alpha:
                    lo, _ = im.getchannel("A").getextrema()
                    alpha = lo < 250
                    if not alpha:
                        im = im.convert("RGB")
                if im.width > width:
                    h = round(im.height * width / im.width)
                    im = im.resize((width, h), Image.LANCZOS)
                if not alpha:
                    bg = self._backdrop(im)
                if self.enabled and not dest.exists():
                    im.save(dest, "WEBP", quality=80, method=5)
                    self.written += 1
        except Exception as e:
            print(f"  ! {local_rel}: {e}", file=sys.stderr)
            self.cache[key] = None
            return None

        out = {"src": rel}
        if bg:
            out["bg"] = bg
        self.cache[key] = out
        return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--export", default="fourthwall_export")
    ap.add_argument("--src", default="site_src")
    ap.add_argument("--out", default="site")
    ap.add_argument("--no-images", action="store_true", help="skip photo resizing")
    args = ap.parse_args()

    exp, out, src = Path(args.export), Path(args.out), Path(args.src)
    products = json.loads((exp / "products.json").read_text())
    cats_path = exp / "categories.json"
    api_cats = json.loads(cats_path.read_text()) if cats_path.exists() else None
    if api_cats:
        print("using real collections from categories.json")
    shop = json.loads((exp / "shop.json").read_text()) if (exp / "shop.json").exists() else {}

    url_by_vid = {}
    with open(exp / "checkout_links.csv", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            link = (row.get("Checkout Link") or "").strip()
            m = re.search(r"products=([0-9a-f-]+):", link)
            if m:
                url_by_vid[m.group(1)] = link

    # The list endpoint omits additionalInformation, but the CSV export has it.
    # These are the fabric/fit specs people actually ask about at a booth.
    details_by_id = {}
    pcsv = exp / "products.csv"
    if pcsv.exists():
        with open(pcsv, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                items = []
                for key in ("additionalInformation.moreDetails",
                            "additionalInformation.sizeAndFit"):
                    for li in re.findall(r"<li>(.*?)</li>", row.get(key) or "", re.S):
                        txt = re.sub(r"<[^>]+>", "", li)
                        txt = html.unescape(txt).strip()
                        if txt and txt not in items:
                            items.append(txt)
                if items:
                    details_by_id[row["id"]] = items[:6]

    file_by_url = {}
    with open(exp / "assets_manifest.csv", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row.get("file"):
                file_by_url[row["url"]] = row["file"]

    out.mkdir(parents=True, exist_ok=True)
    imgs = Images(exp, out / "img", enabled=not args.no_images)

    def local(img_obj):
        return file_by_url.get((img_obj or {}).get("url", ""))

    kept, skipped, no_link = [], [], 0
    for p in products:
        name = (p.get("name") or "").strip()
        if p.get("slug") in HIDE_SLUGS or name.lower().startswith(HIDE_NAME_PREFIXES):
            skipped.append(name)
            continue
        if (p.get("state") or {}).get("type") == "SOLD_OUT":
            skipped.append(f"{name} (sold out — no checkout possible)")
            continue

        # Group variants by colour: Fourthwall gives every variant of a colour
        # the same photo set, so the gallery is per colour, not per size.
        colors, order = {}, []
        variants = []
        for v in p.get("variants") or []:
            vid = v.get("id")
            url = url_by_vid.get(vid)
            if not url:
                no_link += 1
                continue
            attrs = v.get("attributes") or {}
            cname = ((attrs.get("color") or {}).get("name") or "").strip() or "Default"
            sname = ((attrs.get("size") or {}).get("name") or "").strip() or "One size"
            if cname not in colors:
                order.append(cname)
                gallery, seen = [], set()
                for im in (v.get("images") or [])[:MAX_IMAGES_PER_COLOR]:
                    r = imgs.get(local(im), DETAIL_W)
                    if r and r["src"] not in seen:
                        seen.add(r["src"])
                        gallery.append(r)
                colors[cname] = {
                    "name": cname,
                    "swatch": (attrs.get("color") or {}).get("swatch") or "",
                    "images": gallery,
                    "thumb": imgs.get(local(v.get("thumbnailImage")), CARD_W),
                }
            variants.append({
                "color": cname,
                "size": sname,
                "price": round(float(v["unitPrice"]["value"]), 2),
                "sku": v.get("sku") or "",
                "id": vid,
                "url": url,
            })

        if not variants:
            skipped.append(f"{name} (no checkout links)")
            continue

        prices = [v["price"] for v in variants]
        card = imgs.get(local(p.get("thumbnailImage")), CARD_W)
        if not card:
            for c in order:
                if colors[c]["thumb"]:
                    card = colors[c]["thumb"]
                    break

        kept.append({
            "id": p["id"],
            "slug": p.get("slug") or "",
            "name": name,
            "category": classify(name, CATEGORIES, "desk"),
            "collections": collections_for(
                name,
                [slugify(c) for c in api_cats[p["id"]]] if api_cats and p["id"] in api_cats else None),
            "priceMin": min(prices),
            "priceMax": max(prices),
            "card": card,
            "created": p.get("createdAt", ""),
            "details": details_by_id.get(p["id"], []),
            "colors": [colors[c] for c in order],
            "sizes": sorted({v["size"] for v in variants}, key=size_key),
            "variants": variants,
        })

    counts = {}
    for p in kept:
        counts[p["category"]] = counts.get(p["category"], 0) + 1
    ccounts = {}
    for p in kept:
        for c in p["collections"]:
            ccounts[c] = ccounts.get(c, 0) + 1

    data = {
        "shop": {
            "name": shop.get("name") or "Shop",
            "url": "https://" + (shop.get("publicDomain") or "shop.aoir.org"),
            # Verified: ?products=id:qty,id:qty builds a real multi-item cart.
            "checkout": "https://" + (shop.get("publicDomain") or "shop.aoir.org")
                        + "/cart/checkout?products=",
        },
        "categories": [{"id": c, "label": l, "count": counts.get(c, 0)}
                       for c, l, _ in CATEGORIES if counts.get(c)],
        "collections": ([{"id": c, "label": l, "count": ccounts.get(c, 0)}
                         for c, l, _ in COLLECTIONS if ccounts.get(c)]
                        if not api_cats else
                        [{"id": slugify(n), "label": n, "count": k}
                         for n, k in sorted(
                             {n: sum(1 for pr in kept if slugify(n) in pr["collections"])
                              for ns in api_cats.values() for n in ns}.items(),
                             key=lambda x: -x[1]) if k]),
        "products": kept,
    }

    if src.exists():
        for f in src.iterdir():
            if f.is_file():
                shutil.copy2(f, out / f.name)
            elif f.is_dir():      # fonts/ and anything else alongside it
                shutil.copytree(f, out / f.name, dirs_exist_ok=True)

    (out / "data.json").write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))

    # Stamp the service worker with a hash of what we just built. Without this
    # a rebuilt catalogue keeps serving the previous app.js from the cache.
    sw = out / "sw.js"
    if sw.exists():
        h = hashlib.sha1()
        for n in ("index.html", "app.js", "qrcode.js", "styles.css", "fonts.css", "data.json"):
            f = out / n
            if f.exists():
                h.update(f.read_bytes())
        sw.write_text(sw.read_text().replace("__BUILD__", h.hexdigest()[:12]))

    nvar = sum(len(p["variants"]) for p in kept)
    size_mb = sum(f.stat().st_size for f in out.rglob("*") if f.is_file()) / 1e6
    print(f"products : {len(kept)} shown, {len(skipped)} hidden")
    for s in skipped:
        print(f"           - {s}")
    if no_link:
        print(f"variants without a checkout link: {no_link}")
    print(f"variants : {nvar}")
    print(f"images   : {imgs.written} written, {len([k for k in imgs.cache if imgs.cache[k]])} referenced")
    print(f"data.json: {(out / 'data.json').stat().st_size / 1024:.0f} KB")
    print(f"site     : {size_mb:.1f} MB in {out.resolve()}")


if __name__ == "__main__":
    main()
