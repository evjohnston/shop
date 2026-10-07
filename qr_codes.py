#!/usr/bin/env python3
"""
Make a QR code PNG for every row in checkout_links.csv.

Usage:
  pip install "qrcode[pil]"
  python make_qr_codes.py --csv fourthwall_export/checkout_links.csv --out qr_codes

Each PNG has the product and variant printed under the code so printed codes
are easy to tell apart. Add --no-label for a bare code.
"""

import argparse
import csv
import re
import sys
from pathlib import Path

import qrcode
from qrcode.constants import ERROR_CORRECT_M
from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    "DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "C:/Windows/Fonts/arial.ttf",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    try:
        return ImageFont.load_default(size=size)  # Pillow 10.1+
    except TypeError:
        return ImageFont.load_default()           # older Pillow: small fixed font


def safe_name(s):
    s = re.sub(r"[^\w\-]+", "_", s).strip("_")
    return s[:100] or "qr"


def wrap(draw, text, font, max_width):
    lines, line = [], ""
    for word in text.split():
        test = f"{line} {word}".strip()
        if not line or draw.textlength(test, font=font) <= max_width:
            line = test
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def make_qr(url, box_size, border):
    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_M, box_size=box_size, border=border)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    img = img.get_image() if hasattr(img, "get_image") else img
    return img.convert("RGB")


def add_label(img, texts):
    """Put the label text below the code, outside the white border the scanner needs."""
    font_size = max(16, img.width // 16)
    font = load_font(font_size)
    pad = font_size // 2
    probe = ImageDraw.Draw(img)

    lines = []
    for t in texts:
        if t:
            lines += wrap(probe, t, font, img.width - 2 * pad)
    if not lines:
        return img

    line_h = int(font_size * 1.3)
    canvas = Image.new("RGB", (img.width, img.height + line_h * len(lines) + pad), "white")
    canvas.paste(img, (0, 0))
    draw = ImageDraw.Draw(canvas)
    y = img.height
    for line in lines:
        w = draw.textlength(line, font=font)
        draw.text(((canvas.width - w) / 2, y), line, fill="black", font=font)
        y += line_h
    return canvas


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", default="fourthwall_export/checkout_links.csv")
    ap.add_argument("--out", default="qr_codes")
    ap.add_argument("--box-size", type=int, default=12,
                    help="pixels per QR square; raise it for bigger prints")
    ap.add_argument("--border", type=int, default=4,
                    help="white margin in QR squares (4 is the standard minimum)")
    ap.add_argument("--no-label", action="store_true", help="skip the text under each code")
    args = ap.parse_args()

    csv_path = Path(args.csv)
    if not csv_path.exists():
        sys.exit(f"{csv_path} not found. Run fourthwall_export.py first, or pass --csv.")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        needed = {"Product", "Variant", "Checkout Link"}
        if not needed.issubset(reader.fieldnames or []):
            sys.exit(f"{csv_path} needs columns: {', '.join(sorted(needed))}")
        rows = list(reader)

    used, made = set(), 0
    for row in rows:
        url = (row.get("Checkout Link") or "").strip()
        if not url:
            continue
        product = (row.get("Product") or "").strip()
        variant = (row.get("Variant") or "").strip()

        # Unique file name per variant, e.g. Logo_Tee_Black_M.png
        base = safe_name(f"{product} {variant}")
        name, n = base, 2
        while name in used:
            name, n = f"{base}_{n}", n + 1
        used.add(name)

        img = make_qr(url, args.box_size, args.border)
        if not args.no_label:
            img = add_label(img, [product, variant])
        img.save(out / f"{name}.png")
        made += 1

    print(f"Made {made} QR codes in {out.resolve()}")


if __name__ == "__main__":
    main()