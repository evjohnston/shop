#!/usr/bin/env python3
"""
Build the iPad kiosk storefront from the Fourthwall export.

Reads fourthwall_export/ (products.json, checkout_links.csv, assets/) and
writes a self-contained static site to site/ that needs no server-side code
and no network once loaded:

  site/index.html      copied from site_src/
  site/app.js          copied from site_src/
  site/styles.css      copied from site_src/
  site/data.json       catalog + a QR module matrix per variant
  site/img/*.webp      resized photos

Every variant carries its checkout QR as a base64 module matrix (~230 bytes)
that the browser draws on a canvas, so there is no QR library to load and the
codes are identical to the printed ones in qr_codes/.

Usage:
  pip install "qrcode[pil]" pillow
  python build_site.py
  python build_site.py --no-images     # rebuild data.json only (fast)
"""

import argparse
import base64
import csv
import hashlib
import html
import json
import re
import shutil
import sys
from pathlib import Path

import qrcode
from qrcode.constants import ERROR_CORRECT_M
from PIL import Image

# ---------------------------------------------------------------- catalog fixes
# Two products share the name "AoIRchive Hooded Sweatshirt w/ Full Design" with
# different SKUs and photos. The "-2" slug was created 19s earlier, so the plain
# slug is the newer one and the one we show.
HIDE_SLUGS = {"aoirchive-hooded-sweatshirt-w-full-design-2"}
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

COLLECTIONS = [
    ("aoir2026",  "AoIR 2026 Regenerations", r"aoir2026|regenerations|cdmx"),
    ("aoirchive", "AoIRchive",               r"^aoirchive"),
    ("slogans",   "Slogan Tees",             r"^'|influencer|listserv|baud|wifi|karaoke|parasocial|h-index|reply-all|aspirational|impact factor|context collapse|went viral|brand deals|tiktoks|tech support|inbox overload|online trust|online safety|platform engagement|i survived"),
    ("essentials","AoIR Essentials",         r"^aoir (unisex|tote|classic|ceramic|branded|white|logo|executive)"),
]

SIZE_ORDER = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL",
              "11oz", "15oz", "One size"]

CARD_W, DETAIL_W = 560, 1100
MAX_IMAGES_PER_COLOR = 4


def classify(name, table, default=None):
    low = name.lower()
    for cid, label, pat in table:
        if re.search(pat, low):
            return cid
    return default


def collections_for(name):
    low = name.lower()
    return [cid for cid, label, pat in COLLECTIONS if re.search(pat, low)]


def size_key(s):
    try:
        return (0, SIZE_ORDER.index(s))
    except ValueError:
        return (1, s)


def qr_payload(url):
    """Base64 module matrix. The browser redraws this; no QR library needed."""
    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_M, border=0, box_size=1)
    qr.add_data(url)
    qr.make(fit=True)
    n = qr.modules_count
    m = qr.get_matrix()
    bits = "".join("1" if m[r][c] else "0" for r in range(n) for c in range(n))
    bits += "0" * (-len(bits) % 8)
    packed = bytes(int(bits[i:i + 8], 2) for i in range(0, len(bits), 8))
    return n, base64.b64encode(packed).decode()


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

        bg = "#1a1a1a"
        try:
            with Image.open(src) as im:
                im = im.convert("RGB")
                if im.width > width:
                    h = round(im.height * width / im.width)
                    im = im.resize((width, h), Image.LANCZOS)
                bg = self._backdrop(im)
                if self.enabled and not dest.exists():
                    im.save(dest, "WEBP", quality=78, method=5)
                    self.written += 1
        except Exception as e:
            print(f"  ! {local_rel}: {e}", file=sys.stderr)
            self.cache[key] = None
            return None

        out = {"src": rel, "bg": bg}
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
            n, matrix = qr_payload(url)
            variants.append({
                "color": cname,
                "size": sname,
                "price": round(float(v["unitPrice"]["value"]), 2),
                "sku": v.get("sku") or "",
                "url": url,
                "n": n,
                "qr": matrix,
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
            "collections": collections_for(name),
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
        },
        "categories": [{"id": c, "label": l, "count": counts.get(c, 0)}
                       for c, l, _ in CATEGORIES if counts.get(c)],
        "collections": [{"id": c, "label": l, "count": ccounts.get(c, 0)}
                        for c, l, _ in COLLECTIONS if ccounts.get(c)],
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
        for n in ("index.html", "app.js", "styles.css", "fonts.css", "data.json"):
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
