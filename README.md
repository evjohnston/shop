# AoIR shop — export, QR codes, and the iPad kiosk

Three pieces:

| Script | What it does |
|---|---|
| `main.py` | Pulls the catalog from the Fourthwall API into `fourthwall_export/` (CSVs, JSON, photos, one direct checkout link per variant) |
| `qr_codes.py` | Turns every checkout link into a printable labelled PNG in `qr_codes/` |
| `build_site.py` | Builds `site/`, a static storefront for an iPad in Guided Access |
| `verify_qr.py` | Checks the codes actually scan and actually reach a checkout **before you print them** |

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install "qrcode[pil]" pillow requests zxing-cpp
```

## Rebuilding after a catalog change

```bash
python3 main.py                  # re-fetch from Fourthwall
python3 qr_codes.py              # regenerate printable codes
python3 verify_qr.py --live      # confirm before printing
python3 build_site.py            # rebuild the kiosk
```

`main.py --from-json --no-download` reuses the last pull if you only need to
regenerate CSVs offline.

## The shop address — read this before printing anything

Fourthwall's `/shops/current` returns two different things:

```
"domain":       "association-of-internet-researchers-shop"   <- internal slug, NOT a hostname
"publicDomain": "shop.aoir.org"                              <- the real address
```

An earlier run built all 519 checkout links on `domain`, which is not a
resolvable host, so every printed code scanned perfectly and landed on
`DNS_PROBE_FINISHED_NXDOMAIN`. `shop_url_from()` now rejects any candidate
without a dot in it and falls back to `<slug>.fourthwall.com`.

**Always run `verify_qr.py` before a print run.** Decoding a QR only proves the
image is readable; it says nothing about whether the URL works.

### `--live` creates real checkout sessions

Each live check hits `/cart/checkout`, which creates an actual checkout session
and counts against Fourthwall's rate limit. Checking all 519 at once gets the
whole shop 429'd for several minutes, which makes perfectly good links look
dead. `--live` samples 10 sequentially by default. That is deliberate.

```bash
python3 verify_qr.py                   # decode-only: free, instant, no side effects
python3 verify_qr.py --live            # + spot-check 10 links
python3 verify_qr.py --live --sample 30
```

## The kiosk (`site/`)

A static site with **no on-device checkout**. Shoppers browse, pick a color and
size, and either scan one item's code or build a bag and scan a single code for
the lot. Money is only ever handled on the shopper's own phone; nothing is typed
on the iPad.

It runs as an unattended kiosk: a landing screen, then **90 seconds** of no
touch returns it to that screen and empties the bag, with a "still shopping?"
prompt for the last 15. Both numbers are `IDLE_MS` / `WARN_MS` at the top of
`site_src/app.js`.

- 61 products, 440 variants, ~26 MB total
- Per-product fabric and fit specs, pulled from `products.csv`
- QR codes are generated in the browser (`site_src/qrcode.js`, MIT). A bag is an
  arbitrary combination of variants, so its code cannot be precomputed. The code
  grows on screen as the payload grows, so a full bag stays scannable.
- Categories, cross-cutting collections, search, and five sort orders
- Tap a product photo for a full-screen viewer: pinch, double-tap or the
  +/− buttons to zoom to 400%, drag to pan. Gallery images are 1400px so the
  zoom stays sharp; the kiosk disables page zoom, so this is its own viewer
  rather than native pinch
- **Works offline.** A service worker caches the shell, catalog, photos, and
  fonts, so a wifi drop mid-conference doesn't blank the screen. (Checkout
  happens on the shopper's phone, so it needs their connection, not yours.)
  Photos and fonts are cache-first; the shell and catalog are network-first, so
  a rebuild never leaves a stale page on the iPad.
- Resets to the home grid after 3 minutes idle (`IDLE_MS` in `app.js`)

### Hosting it

The site is fully static with relative paths, so anything works — Netlify drop,
Cloudflare Pages, GitHub Pages. **Serve it over HTTPS**: the offline cache is a
service worker, and those only run on HTTPS (or localhost).

Locally:

```bash
python3 -m http.server -d site 8000     # then http://localhost:8000
```

### On the iPad

1. Open the URL in Safari and let it load once fully (this fills the offline cache).
2. Share → **Add to Home Screen**, then launch from that icon for a chrome-free window.
3. Triple-click the side button → **Guided Access** to lock it to the one app.

### The design

A dark archival catalog rather than a conventional storefront. The reasoning:

- **Dark page.** 66 of the 68 products are photographed on pure `#000000`. On a
  light page they read as black holes punched in the layout; on a near-black
  page the garments float with no card chrome at all. The page black is
  `#0d0c0c`, warmed off AoIR's own `#060501`.
- **Per-photo backdrops.** `build_site.py` samples each image's corners and
  stores the result, so photos letterbox against their own background and are
  never cropped. That's what lets the plates hold any aspect ratio cleanly, and
  it handles the two light-background products without a special case.
- **The lockup.** Node, hairline, skewed `a(o).i.r`, divider, stacked
  letterspaced caps — built in CSS after the real mark, not an image.
- **Type.** Archivo (a grotesque close to the logo) for names and UI, IBM Plex
  Mono for metadata — catalog numbers, prices, sizes, SKUs. Both self-hosted in
  `site_src/fonts/`, because Google Fonts over the network would break offline.
- **Accent as information.** AoIR teal `#7EBEC5` normally; the whole interface
  switches to CDMX pink `#ed3193` while the 2026 Regenerations collection is
  selected.
- **Catalog numbers** (`001`…`068`) are fixed to the shop's own order, so an
  item keeps its number no matter how you sort or filter. They are reference
  codes, not a running count — that's why they look out of sequence when sorted.
- **The QR is a mounted plate**: white, crop-marked, the brightest thing on the
  page. It stays dark-on-light because inverted codes scan badly.

### Editing the look

`site_src/` holds the source (`index.html`, `styles.css`, `app.js`, `sw.js`,
`fonts.css`, `fonts/`); `build_site.py` copies it into `site/` alongside the
generated data. **Edit `site_src/`, never `site/`** — the latter is overwritten
on every build.

Colors, spacing, and both accents live in the `:root` block of
`site_src/styles.css`.

### Catalog decisions baked into the build

Both are constants at the top of `build_site.py`:

- `HIDE_SLUGS` drops `aoirchive-hooded-sweatshirt-w-full-design-2`. Two distinct
  products share that name with different SKUs and photos; this keeps the newer
  one (created 18:18:02 vs 18:17:43 — the `-2` slug is the *older* one).
- `HIDE_NAME_PREFIXES` drops `Copy of …` products, which are Fourthwall
  duplicates of items already listed.

Fourthwall marks five products `SOLD_OUT`; per AoIR that flag is wrong, so the
site ignores it and treats everything as available.


## Multi-item checkout

Fourthwall's checkout URL takes several variants at once:

```
https://shop.aoir.org/cart/checkout?products=<variantId>:<qty>,<variantId>:<qty>
```

Verified against the real checkout, reading the rendered totals rather than
trusting the redirect: one item $25, two items $55, three items $90, and
`:2` correctly gives quantity 2. An end-to-end run through the kiosk (bag of
4 items across 3 lines, $155.00) produced a checkout that also said $155.00
with the right quantities.

That is what the bag is built on. The kiosk caps the bag at 15 distinct lines,
because the URL grows ~38 characters per line and a denser QR gets harder to
scan.

## What reaches the booth, and what doesn't

Fourthwall's own `access.type` sorts the catalogue, so nothing here is keyed to
a product name:

| `access.type` | | Booth |
|---|---|---|
| `PUBLIC` | 62 | listed and buyable |
| `HIDDEN` | 4 | staff/committee merch — excluded |
| `ARCHIVED` | 5 | discontinued — excluded |

**`HIDDEN`** is how Fourthwall marks merch that is deliberately unlisted but
still buyable by direct link: the Executive Committee crewneck and the
Volunteers / Executive Staff / Executive Committee conference tees. Those links
work, which is exactly why they must not appear on a kiosk or on a printed card
at a public table.

**`ARCHIVED`** happens to be the same five products Fourthwall marks
`SOLD_OUT`, and those cannot be bought at all: `/cart/checkout` refuses to
create a session and bounces to `?error_message=Checkout unknown error`. Tested
one variant from each — 5/5 sold-out fail, 3/3 available succeed. Worse, **one
of them in a bag breaks the whole cart**, not just its own line.

Both are excluded at the source, so a dead or private link is never minted in
the first place:

- `main.py` `is_unbuyable()` skips them in `checkout_links.csv`, so `qr_codes.py`
  cannot print a card for one
- `build_site.py` leaves them out of the catalogue

That leaves **61 products / 440 variants** on the kiosk and **470 printable
cards**. Set `PUBLIC_ONLY = False` in `main.py` to print the hidden ones for
staff; flip a product back to public or available in Fourthwall and it returns
on the next `main.py` + `build_site.py` run.
