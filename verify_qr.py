#!/usr/bin/env python3
"""
Check the QR codes before you print them.

Decodes every PNG in qr_codes/, confirms it matches checkout_links.csv, and
(with --live) actually fetches each URL to confirm it reaches a real checkout.

This exists because a bad shop address once produced 519 codes that scanned
fine and led nowhere. Decoding proves the image is readable; only --live
proves the link works.

CAUTION: every --live check creates a REAL checkout session on the shop and
counts against Fourthwall's rate limit. Checking all 519 at once gets the whole
shop 429'd for several minutes and makes good links look dead. So --live
samples 10 links sequentially by default. Only raise --sample if you mean it.

Usage:
  pip install zxing-cpp pillow
  python verify_qr.py                      # decode-only, free and instant
  python verify_qr.py --live               # + spot-check 10 links
  python verify_qr.py --live --sample 30
"""

import argparse
import csv
import random
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import zxingcpp
from PIL import Image

EXPECTED_PREFIX = "https://"


def decode_all(qr_dir):
    found, unreadable = {}, []
    for f in sorted(Path(qr_dir).glob("*.png")):
        res = zxingcpp.read_barcodes(Image.open(f))
        if res:
            found[f.name] = res[0].text
        else:
            unreadable.append(f.name)
    return found, unreadable


UA = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/605.1.15"


def live_check(url, timeout=30, retries=3):
    """Fetch one checkout link, backing off when the shop rate-limits us."""
    delay = 20
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                eff = r.geturl()
                if "error_message" in eff:
                    return False, r.status, eff
                return "/checkout/" in eff, r.status, eff
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            return False, e.code, "rate limited" if e.code == 429 else str(e)[:80]
        except Exception as e:
            return False, type(e).__name__, str(e)[:80]
    return False, 429, "rate limited"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", default="fourthwall_export/checkout_links.csv")
    ap.add_argument("--qr", default="qr_codes")
    ap.add_argument("--live", action="store_true",
                    help="spot-check links by fetching them (creates real checkout sessions)")
    ap.add_argument("--sample", type=int, default=10,
                    help="with --live, how many random links to test (0 = all; will get you rate limited)")
    ap.add_argument("--pause", type=float, default=3.0, help="seconds between --live requests")
    args = ap.parse_args()

    expected = {r["Checkout Link"].strip() for r in csv.DictReader(open(args.csv, encoding="utf-8")) if r.get("Checkout Link")}
    decoded, unreadable = decode_all(args.qr)
    got = set(decoded.values())

    problems = []
    print(f"PNGs decoded : {len(decoded)}")
    print(f"unreadable   : {len(unreadable)}")
    print(f"unique URLs  : {len(got)}   (csv: {len(expected)})")

    if unreadable:
        problems.append(f"{len(unreadable)} PNG(s) would not decode")
        for n in unreadable[:10]:
            print(f"  UNREADABLE {n}")

    # A bare slug with no dot is the exact bug that broke the first batch.
    hostless = {u for u in got if "." not in u.split("://", 1)[-1].split("/", 1)[0]}
    if hostless:
        problems.append(f"{len(hostless)} URL(s) have no real hostname")
        for u in list(hostless)[:5]:
            print(f"  NO HOSTNAME {u}")

    if got - expected:
        problems.append(f"{len(got - expected)} decoded URL(s) are not in the csv")
    if expected - got:
        problems.append(f"{len(expected - got)} csv link(s) have no QR code")

    print(f"decoded == csv: {got == expected}")

    if args.live:
        targets = sorted(got)
        if args.sample and args.sample < len(targets):
            random.seed()
            targets = random.sample(targets, args.sample)
        print(f"\nlive-checking {len(targets)} link(s), {args.pause}s apart "
              f"(each creates a real checkout session)...")

        dead, limited = [], 0
        for i, u in enumerate(targets):
            ok, code, eff = live_check(u)
            if not ok:
                if code == 429:
                    limited += 1
                dead.append((u, code, eff))
            if i < len(targets) - 1:
                time.sleep(args.pause)

        print(f"reached a checkout: {len(targets) - len(dead)}/{len(targets)}")
        for u, c, e in dead[:10]:
            print(f"  DEAD {c} {u}  {e}")

        if limited:
            problems.append(f"{limited} check(s) were rate limited - inconclusive, "
                            f"wait a few minutes and retry with a smaller --sample")
        if len(dead) - limited:
            problems.append(f"{len(dead) - limited} link(s) did not reach a checkout")

    print()
    if problems:
        print("FAILED:")
        for p in problems:
            print(f"  - {p}")
        sys.exit(1)
    print("All good. Safe to print.")


if __name__ == "__main__":
    main()
