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

A static site with **no cart and no on-device checkout**. Shoppers browse, pick
a color and size, and the page shows the QR code for that exact variant; they
scan it with their own phone and check out there. Nothing is typed on the iPad.

- 68 products, 481 variants, ~12 MB total
- Per-product fabric and fit specs, pulled from `products.csv`
- Each variant's QR ships as a ~230-byte module matrix that the browser draws on
  a canvas — no QR library, and the codes are identical to the printed ones
- Categories, cross-cutting collections, search, and five sort orders
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
