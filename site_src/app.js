/* AoIR kiosk storefront.

   No cart on the device and no checkout on the device: a shopper either scans
   one item's code, or builds a bag and scans a single code for the lot. Money
   is only ever handled on the shopper's own phone.

   Runs unattended in Guided Access, so it returns to the landing screen and
   empties the bag after 90s of no touch. */

(() => {
  "use strict";

  // AoIR2026 promotion. This only advertises the offer — the discount itself
  // has to be configured in Fourthwall's shipping settings, or the shopper
  // will be charged at checkout and we'll have lied to them.
  // Set THRESHOLD to null to take the whole thing down.
  const FREE_SHIP = {
    THRESHOLD: 75,
    SHORT: "Free worldwide shipping over $75",
    LONG:  "Free shipping on orders over $75 — anywhere in the world.",
  };

  const IDLE_MS  = 90 * 1000;   // total quiet time before the kiosk resets
  const WARN_MS  = 15 * 1000;   // how much of that is the "still there?" prompt
  const MAX_LINES = 15;         // keeps the bag's QR sparse enough to scan

  const $ = (id) => document.getElementById(id);
  const el = {
    landing: $("landing"), start: $("start"), shell: $("shell"),
    grid: $("grid"), menu: $("menu"), count: $("count"), scope: $("scope"),
    homeView: $("home-view"), gridView: $("grid-view"),
    heroArt: $("heroArt"), heroCta: $("heroCta"),
    featGrid: $("featGrid"), collCards: $("collCards"),
    empty: $("empty"), q: $("q"), clearQ: $("clearQ"), searchWrap: $("searchWrap"),
    sort: $("sort"), home: $("home"),
    sheet: $("sheet"), back: $("back"), sheetTitle: $("sheetTitle"), sheetBody: $("sheetBody"),
    galMain: $("galMain"), galStrip: $("galStrip"), galZoom: $("galZoom"),
    heroShip: $("heroShip"), landingShip: $("landingShip"), shipNote: $("shipNote"),
    ship: $("ship"), shipBar: $("shipBar"), shipMsg: $("shipMsg"),
    lightbox: $("lightbox"), lbStage: $("lbStage"), lbImg: $("lbImg"),
    lbClose: $("lbClose"), lbIn: $("lbIn"), lbOut: $("lbOut"),
    lbPct: $("lbPct"), lbTip: $("lbTip"),
    pName: $("pName"), pPrice: $("pPrice"), pSku: $("pSku"),
    pIdx: $("pIdx"), pCat: $("pCat"), pDetails: $("pDetails"),
    colorOpt: $("colorOpt"), colors: $("colors"), colorVal: $("colorVal"),
    sizeOpt: $("sizeOpt"), sizes: $("sizes"), sizeVal: $("sizeVal"),
    qr: $("qr"), qrVariant: $("qrVariant"), addBtn: $("addBtn"),
    bag: $("bag"), bagBtn: $("bagBtn"), bagBtn2: $("bagBtn2"),
    bagN: $("bagN"), bagN2: $("bagN2"), bagBack: $("bagBack"), bagClear: $("bagClear"),
    bagList: $("bagList"), bagQr: $("bagQr"), bagTotal: $("bagTotal"), bagCount: $("bagCount"),
    idle: $("idle"), idleN: $("idleN"), idleStay: $("idleStay"),
  };

  let DATA = null;
  let filter = "home";   // "home" = the featured front page
  let current = null, curColor = null, curSize = null;
  let bag = [];                       // [{id, qty, name, color, size, price, img}]
  const label = new Map();
  const catalogNo = new Map();
  const byId = new Map();             // variant id -> {product, variant}

  // If a photo ever fails to decode, show the empty plate rather than the
  // browser's broken-image glyph. Delegated so it covers images added later.
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (img && img.tagName === "IMG") img.style.visibility = "hidden";
  }, true);
  document.addEventListener("load", (e) => {
    const img = e.target;
    if (img && img.tagName === "IMG") img.style.visibility = "";
  }, true);

  const money = (n) =>
    "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const priceLabel = (p) =>
    p.priceMin === p.priceMax ? money(p.priceMin) : `${money(p.priceMin)} – ${money(p.priceMax)}`;

  /* ---------------------------------------------------------------- QR */

  // Codes are drawn here rather than precomputed because a bag is an arbitrary
  // combination of variants. qrcode.js (MIT) does the encoding.
  function drawQR(canvas, text) {
    const qr = qrcode(0, "M");        // 0 = smallest version that fits
    qr.addData(text);
    qr.make();

    const n = qr.getModuleCount();
    const quiet = 4;                  // the spec's minimum light border
    const total = n + quiet * 2;

    // Bigger payload -> more modules -> the code needs more room to stay
    // scannable, so grow the on-screen size with it rather than packing in.
    const css = Math.min(330, Math.max(210, Math.round(n * 3.6)));
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const scale = Math.max(1, Math.floor((css * dpr) / total));
    const px = total * scale;

    canvas.width = px;
    canvas.height = px;
    canvas.style.width = css + "px";
    canvas.style.height = css + "px";

    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = "#000";
    for (let r = 0; r < n; r++) {
      let run = 0;
      for (let c = 0; c <= n; c++) {
        const on = c < n && qr.isDark(r, c);
        if (on) { run++; continue; }
        if (run) {
          ctx.fillRect((c - run + quiet) * scale, (r + quiet) * scale, run * scale, scale);
          run = 0;
        }
      }
    }
  }

  /* --------------------------------------------------------------- bag */

  const bagCount = () => bag.reduce((n, l) => n + l.qty, 0);
  const bagTotal = () => bag.reduce((n, l) => n + l.qty * l.price, 0);
  const bagURL = () =>
    DATA.shop.checkout + bag.map((l) => `${l.id}:${l.qty}`).join(",");

  function addToBag(p, v) {
    const line = bag.find((l) => l.id === v.id);
    if (line) {
      line.qty++;
    } else {
      if (bag.length >= MAX_LINES) return false;
      const c = p.colors.find((x) => x.name === v.color) || p.colors[0];
      bag.push({
        id: v.id, qty: 1, price: v.price, name: p.name,
        color: v.color, size: v.size,
        img: (c.images && c.images[0]) || p.card || null,
      });
    }
    syncBagChrome();
    return true;
  }

  function syncBagChrome() {
    const n = bagCount();
    for (const [btn, num] of [[el.bagBtn, el.bagN], [el.bagBtn2, el.bagN2]]) {
      btn.hidden = n === 0;
      num.textContent = n;
    }
  }

  function renderBag() {
    el.bagList.innerHTML = "";
    if (!bag.length) {
      el.bagList.innerHTML = `<p class="bag-empty">Your bag is empty.</p>`;
      el.bagTotal.textContent = money(0);
      el.bagCount.textContent = "";
      el.bagQr.getContext("2d").clearRect(0, 0, el.bagQr.width, el.bagQr.height);
      el.bagQr.width = el.bagQr.height = 0;
      return;
    }

    for (const l of bag) {
      const row = document.createElement("div");
      row.className = "bagrow";
      const bits = [l.color === "Default" ? null : l.color,
                    l.size !== "One size" && l.size !== "Default" ? l.size : null]
                   .filter(Boolean).join(" / ");
      row.innerHTML =
        `<div class="plate sm">${l.img ? `<img src="${l.img.src}" alt="">` : ""}</div>` +
        `<div class="bagmeta"><div class="bagnm"></div><div class="bagvar">${bits}</div></div>` +
        `<div class="qtybox">` +
          `<button class="qty" data-d="-1" aria-label="One fewer">−</button>` +
          `<span class="qtyn">${l.qty}</span>` +
          `<button class="qty" data-d="1" aria-label="One more">+</button>` +
        `</div>` +
        `<div class="bagpr">${money(l.qty * l.price)}</div>`;
      row.querySelector(".bagnm").textContent = l.name;
      if (l.img && l.img.bg) row.querySelector(".plate").style.background = l.img.bg;
      row.querySelectorAll(".qty").forEach((b) =>
        b.addEventListener("click", () => {
          l.qty += Number(b.dataset.d);
          if (l.qty < 1) bag = bag.filter((x) => x !== l);
          syncBagChrome();
          renderBag();
        }));
      el.bagList.appendChild(row);
    }

    const n = bagCount();
    const total = bagTotal();
    el.bagTotal.textContent = money(total);
    el.bagCount.textContent = `${n} item${n === 1 ? "" : "s"} · ${bag.length} line${bag.length === 1 ? "" : "s"}`;
    renderShipping(total);
    drawQR(el.bagQr, bagURL());
  }

  function renderShipping(total) {
    const t = FREE_SHIP.THRESHOLD;
    if (!t) { el.ship.hidden = true; return; }
    el.ship.hidden = false;
    const done = total >= t;
    el.ship.classList.toggle("done", done);
    el.shipBar.style.width = Math.min(100, (total / t) * 100) + "%";
    if (done) {
      el.shipMsg.textContent = "Free shipping unlocked — anywhere in the world.";
    } else {
      el.shipMsg.innerHTML = "";
      el.shipMsg.append(
        document.createTextNode("Add "),
        Object.assign(document.createElement("b"), { textContent: money(t - total) }),
        document.createTextNode(" for free worldwide shipping."));
    }
  }

  const openBag = () => { renderBag(); el.bag.hidden = false; };
  const closeBag = () => { el.bag.hidden = true; };

  /* ------------------------------------------------------------ filter */

  function visible() {
    const term = el.q.value.trim().toLowerCase();
    let list = DATA.products.filter((p) => {
      if (filter !== "all" && filter !== "home") {
        if (!(p.category === filter || p.collections.includes(filter))) return false;
      }
      if (!term) return true;
      return p.name.toLowerCase().includes(term) ||
             p.colors.some((c) => c.name.toLowerCase().includes(term));
    });

    const s = el.sort.value;
    if (s === "featured") {
      const rank = (p) => (p.collections.includes("aoir2026") ? 0 : 1);
      return list.slice().sort((a, b) => rank(a) - rank(b));
    }
    const by = {
      "price-asc":  (a, b) => a.priceMin - b.priceMin,
      "price-desc": (a, b) => b.priceMax - a.priceMax,
      "name":       (a, b) => a.name.localeCompare(b.name),
      "new":        (a, b) => (b.created || "").localeCompare(a.created || ""),
    }[s];
    return by ? list.slice().sort(by) : list;
  }

  function render() {
    // Searching always means results, even from the front page.
    const searching = el.q.value.trim().length > 0;
    const home = filter === "home" && !searching;
    el.homeView.hidden = !home;
    el.gridView.hidden = home;
    if (home) {
      renderHome();
      window.scrollTo(0, 0);
      return;
    }

    const list = visible();
    el.grid.innerHTML = "";
    el.empty.hidden = list.length > 0;
    el.count.textContent = list.length ? `${list.length} item${list.length === 1 ? "" : "s"}` : "";
    const term = el.q.value.trim();
    el.scope.textContent = term ? `Search: ${term}`
      : (filter === "all" ? "All products" : (label.get(filter) || "All products"));

    const frag = document.createDocumentFragment();
    for (const p of list) frag.appendChild(card(p));
    el.grid.appendChild(frag);
    window.scrollTo(0, 0);
  }

  function card(p) {
    const b = document.createElement("button");
    b.className = "item";
    b.type = "button";
    const sw = p.colors.length > 1
      ? `<div class="sw">${p.colors.slice(0, 7).map((c) =>
          `<i style="background:${c.swatch || "#ddd"}"></i>`).join("")}` +
        `${p.colors.length > 7 ? `<b>+${p.colors.length - 7}</b>` : ""}</div>`
      : "";
    b.innerHTML =
      `<div class="plate"${p.card && p.card.bg ? ` style="background:${p.card.bg}"` : ""}>` +
        `${p.card ? `<img src="${p.card.src}" alt="" loading="lazy" decoding="async">` : ""}</div>` +
      `<div class="cap"><div class="idx">${catalogNo.get(p.id)}</div>` +
        `<div class="nm"></div><div class="pr">${priceLabel(p)}</div>${sw}</div>`;
    b.querySelector(".nm").textContent = p.name;   // names contain quotes
    b.addEventListener("click", () => openProduct(p));
    return b;
  }

  const inCollection = (id) => DATA.products.filter((p) => p.collections.includes(id));

  /* --------------------------------------------------------- home view */

  function renderHome() {
    const feat = inCollection("aoir2026");

    // Three of the 2026 shots, stacked and tilted behind the headline.
    el.heroArt.innerHTML = "";
    const wearable = feat.filter((p) => p.sizes.length > 1);
    for (const p of (wearable.length >= 3 ? wearable : feat).slice(0, 3)) {
      const im = (p.colors[0].images && p.colors[0].images[0]) || p.card;
      if (!im) continue;
      const img = document.createElement("img");
      img.src = im.src;
      img.alt = "";
      img.loading = "eager";
      el.heroArt.appendChild(img);
    }

    el.featGrid.innerHTML = "";
    for (const p of feat) el.featGrid.appendChild(card(p));

    el.collCards.innerHTML = "";
    for (const c of DATA.collections) {
      if (c.id === "aoir2026") continue;
      const items = inCollection(c.id);
      const hero = items.find((p) => p.card) || items[0];
      const b = document.createElement("button");
      b.className = "collcard";
      b.type = "button";
      b.innerHTML =
        `${hero && hero.card ? `<img class="cc-art" src="${hero.card.src}" alt="" loading="lazy">` : ""}` +
        `<div class="cc-n">${c.count} item${c.count === 1 ? "" : "s"}</div>` +
        `<div class="cc-t"></div>`;
      b.querySelector(".cc-t").textContent = c.label;
      b.addEventListener("click", () => select(c.id));
      el.collCards.appendChild(b);
    }
  }

  function select(id) {
    filter = id;
    // The 2026 collection carries the CDMX pink; everything else is indigo.
    document.body.dataset.accent = id === "aoir2026" ? "pink" : "";
    buildMenu();
    render();
  }

  function buildMenu() {
    const mk = (id, text, n) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-pressed", String(filter === id));
      const nm = document.createElement("span");
      nm.textContent = text;
      const ct = document.createElement("span");
      ct.className = "n";
      ct.textContent = n;
      b.append(nm, ct);
      b.addEventListener("click", () => select(id));
      return b;
    };
    const grp = (t) => {
      const d = document.createElement("div");
      d.className = "grp";
      d.textContent = t;
      return d;
    };
    el.menu.innerHTML = "";
    el.menu.append(grp("Shop"), mk("home", "Featured", DATA.collections
      .reduce((n, c) => (c.id === "aoir2026" ? c.count : n), 0)));
    el.menu.appendChild(grp("Collections"));
    for (const c of DATA.collections) el.menu.appendChild(mk(c.id, c.label, c.count));
    if (DATA.categories.length) {
      el.menu.appendChild(grp("Browse by type"));
      for (const c of DATA.categories) el.menu.appendChild(mk(c.id, c.label, c.count));
    }
    // Everything-at-once is the fallback, so it sits at the bottom.
    el.menu.appendChild(grp(""));
    el.menu.appendChild(mk("all", "All products", DATA.products.length));
  }

  /* ----------------------------------------------------------- product */

  const variantFor = (p, color, size) =>
    p.variants.find((v) => v.color === color && v.size === size);
  const sizesForColor = (p, color) =>
    new Set(p.variants.filter((v) => v.color === color).map((v) => v.size));

  function openProduct(p) {
    current = p;
    curColor = p.colors[0].name;
    const avail = sizesForColor(p, curColor);
    curSize = p.sizes.find((s) => avail.has(s)) || p.sizes[0];

    el.pName.textContent = p.name;
    el.sheetTitle.textContent = p.name;
    el.pIdx.textContent = catalogNo.get(p.id);
    el.pCat.textContent = label.get(p.category) || "";
    el.colorOpt.hidden = p.colors.length < 2;
    el.sizeOpt.hidden = p.sizes.length < 2;

    el.pDetails.innerHTML = "";
    for (const d of p.details || []) {
      const li = document.createElement("li");
      li.textContent = d;
      el.pDetails.appendChild(li);
    }

    renderColors();
    renderSizes();
    syncVariant();
    el.sheet.hidden = false;
    el.sheetBody.scrollTop = 0;
    document.body.style.overflow = "hidden";
  }

  function closeProduct() {
    closeZoom();
    el.sheet.hidden = true;
    current = null;
    document.body.style.overflow = "";
  }

  function renderColors() {
    el.colors.innerHTML = "";
    const named = current.colors.some((c) => !c.swatch);
    for (const c of current.colors) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-pressed", String(c.name === curColor));
      b.setAttribute("aria-label", c.name);
      if (c.swatch && !named) b.style.background = c.swatch;
      else { b.className = "named"; b.textContent = c.name; }
      b.addEventListener("click", () => {
        curColor = c.name;
        const avail = sizesForColor(current, curColor);
        if (!avail.has(curSize)) curSize = current.sizes.find((s) => avail.has(s)) || curSize;
        renderColors(); renderSizes(); syncVariant();
      });
      el.colors.appendChild(b);
    }
  }

  function renderSizes() {
    const avail = sizesForColor(current, curColor);
    el.sizes.innerHTML = "";
    for (const s of current.sizes) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = s;
      b.disabled = !avail.has(s);
      b.setAttribute("aria-pressed", String(s === curSize));
      b.addEventListener("click", () => { curSize = s; renderSizes(); syncVariant(); });
      el.sizes.appendChild(b);
    }
  }

  function renderGallery() {
    const c = current.colors.find((x) => x.name === curColor) || current.colors[0];
    const imgs = (c.images && c.images.length) ? c.images : (current.card ? [current.card] : []);
    const show = (im) => {
      el.galMain.src = im.src;
      el.galMain.parentElement.style.background = im.bg || "";
    };
    if (imgs.length) show(imgs[0]);
    el.galMain.alt = `${current.name} — ${c.name}`;
    el.galStrip.innerHTML = "";
    if (imgs.length < 2) return;
    imgs.forEach((im, i) => {
      const b = document.createElement("button");
      b.type = "button";
      if (im.bg) b.style.background = im.bg;
      b.setAttribute("aria-pressed", String(i === 0));
      // Strip uses the small file: the browser decodes what you give it, not
      // what you display, and full-size here is what broke iPad rendering.
      b.innerHTML = `<img src="${im.thumb || im.src}" alt="" loading="lazy" decoding="async">`;
      b.addEventListener("click", () => {
        show(im);
        [...el.galStrip.children].forEach((x, j) => x.setAttribute("aria-pressed", String(i === j)));
      });
      el.galStrip.appendChild(b);
    });
  }

  function syncVariant() {
    renderGallery();
    const v = variantFor(current, curColor, curSize);
    const realSize = curSize && curSize !== "One size" && curSize !== "Default";
    el.colorVal.textContent = curColor === "Default" ? "" : curColor;
    el.sizeVal.textContent = current.sizes.length > 1 ? curSize : "";

    const clearQR = () => {
      el.qr.getContext("2d").clearRect(0, 0, el.qr.width, el.qr.height);
      el.qr.width = el.qr.height = 0;
    };

    if (!v) {
      el.pPrice.textContent = priceLabel(current);
      el.qrVariant.textContent = "This combination isn't available.";
      el.pSku.textContent = "";
      el.addBtn.disabled = true;
      clearQR();
      return;
    }
    el.addBtn.disabled = false;
    el.addBtn.textContent = "Add to bag instead";
    el.pPrice.textContent = money(v.price);
    const bits = [curColor === "Default" ? null : curColor, realSize ? curSize : null].filter(Boolean);
    el.qrVariant.textContent =
      (bits.length ? bits.join(" / ") : current.name) + "  —  " + money(v.price);
    el.pSku.textContent = v.sku ? `SKU ${v.sku}` : "";
    drawQR(el.qr, v.url);
  }

  /* -------------------------------------------------------------- zoom */

  // A pinch/pan viewer rather than native page zoom: the kiosk runs with
  // user-scalable=no so the layout can't be wrecked, which also rules out
  // pinching the page. This keeps the gesture but confines it to the photo.
  const MIN_Z = 1, MAX_Z = 4;
  let z = 1, tx = 0, ty = 0;
  const pointers = new Map();
  let pinchStart = 0, zStart = 1, panFrom = null, lastTap = 0;

  function clampPan() {
    // Don't let the photo be dragged off into empty space.
    const r = el.lbImg.getBoundingClientRect();
    const w = r.width / z, h = r.height / z;         // unscaled size on screen
    const maxX = Math.max(0, (w * z - Math.min(w * z, window.innerWidth)) / 2);
    const maxY = Math.max(0, (h * z - Math.min(h * z, window.innerHeight)) / 2);
    tx = Math.max(-maxX, Math.min(maxX, tx));
    ty = Math.max(-maxY, Math.min(maxY, ty));
  }

  function applyZoom(smooth) {
    if (z <= MIN_Z) { z = MIN_Z; tx = ty = 0; }
    clampPan();
    el.lbStage.classList.toggle("smooth", !!smooth);
    el.lbImg.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
    el.lbPct.textContent = Math.round(z * 100) + "%";
    el.lbIn.disabled = z >= MAX_Z - 0.001;
    el.lbOut.disabled = z <= MIN_Z + 0.001;
    el.lbStage.style.cursor = z > 1 ? "grab" : "zoom-out";
    if (smooth) setTimeout(() => el.lbStage.classList.remove("smooth"), 240);
  }

  function zoomAt(next, cx, cy) {
    next = Math.max(MIN_Z, Math.min(MAX_Z, next));
    const r = el.lbStage.getBoundingClientRect();
    const ox = (cx ?? r.width / 2) - r.width / 2;
    const oy = (cy ?? r.height / 2) - r.height / 2;
    // Keep the point under the fingers pinned while the scale changes.
    tx = ox - ((ox - tx) * next) / z;
    ty = oy - ((oy - ty) * next) / z;
    z = next;
  }

  function openZoom() {
    if (!el.galMain.src) return;
    el.lbImg.src = el.galMain.src;
    el.lbImg.alt = el.galMain.alt;
    z = 1; tx = ty = 0;
    applyZoom(false);
    el.lbTip.classList.remove("gone");
    setTimeout(() => el.lbTip.classList.add("gone"), 3200);
    el.lightbox.hidden = false;
  }
  const closeZoom = () => { el.lightbox.hidden = true; pointers.clear(); };

  function wireZoom() {
    el.galZoom.addEventListener("click", openZoom);
    el.lbClose.addEventListener("click", closeZoom);
    el.lbIn.addEventListener("click", () => { zoomAt(z * 1.6); applyZoom(true); });
    el.lbOut.addEventListener("click", () => { zoomAt(z / 1.6); applyZoom(true); });

    el.lbStage.addEventListener("pointerdown", (e) => {
      el.lbStage.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
        zStart = z;
        panFrom = null;
      } else if (pointers.size === 1) {
        panFrom = { x: e.clientX, y: e.clientY, tx, ty };
      }
    });

    el.lbStage.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 2 && pinchStart) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const r = el.lbStage.getBoundingClientRect();
        zoomAt(zStart * (d / pinchStart),
               (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
        applyZoom(false);
      } else if (pointers.size === 1 && panFrom && z > 1) {
        el.lbStage.classList.add("panning");
        tx = panFrom.tx + (e.clientX - panFrom.x);
        ty = panFrom.ty + (e.clientY - panFrom.y);
        applyZoom(false);
      }
    });

    const release = (e) => {
      pointers.delete(e.pointerId);
      el.lbStage.classList.remove("panning");
      if (pointers.size < 2) pinchStart = 0;
      if (pointers.size === 0) panFrom = null;
    };
    el.lbStage.addEventListener("pointerup", release);
    el.lbStage.addEventListener("pointercancel", release);

    // double-tap toggles between fit and 2.5x, tap on the backdrop closes
    el.lbStage.addEventListener("click", (e) => {
      const now = Date.now();
      const dbl = now - lastTap < 320;
      lastTap = now;
      const r = el.lbStage.getBoundingClientRect();
      const onImage = e.target === el.lbImg;
      if (dbl) {
        zoomAt(z > 1.05 ? 1 : 2.5, e.clientX - r.left, e.clientY - r.top);
        applyZoom(true);
      } else if (!onImage && z <= 1.05) {
        closeZoom();
      }
    });

    el.lbStage.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = el.lbStage.getBoundingClientRect();
      zoomAt(z * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX - r.left, e.clientY - r.top);
      applyZoom(false);
    }, { passive: false });
  }

  /* ---------------------------------------------------- kiosk lifecycle */

  function toLanding() {
    closeZoom();
    closeProduct();
    closeBag();
    el.idle.hidden = true;
    el.shell.hidden = true;
    el.landing.hidden = false;
    bag = [];
    syncBagChrome();
    filter = "home";
    el.q.value = "";
    el.searchWrap.classList.remove("has-value");
    el.sort.value = "featured";
    document.body.dataset.accent = "";
    document.body.style.overflow = "";
    if (DATA) { buildMenu(); render(); }
  }

  function toStore() {
    el.landing.hidden = true;
    el.shell.hidden = false;
    resetIdle();
  }

  let idleTimer = null, warnTimer = null, tick = null;
  function clearIdle() {
    clearTimeout(idleTimer); clearTimeout(warnTimer); clearInterval(tick);
  }
  function resetIdle() {
    clearIdle();
    el.idle.hidden = true;
    if (!el.landing.hidden) return;      // the landing screen never times out
    warnTimer = setTimeout(() => {
      let left = Math.round(WARN_MS / 1000);
      el.idleN.textContent = left;
      el.idle.hidden = false;
      tick = setInterval(() => {
        el.idleN.textContent = Math.max(0, --left);
      }, 1000);
    }, IDLE_MS - WARN_MS);
    idleTimer = setTimeout(toLanding, IDLE_MS);
  }

  /* ------------------------------------------------------------- wire */

  function wire() {
    el.start.addEventListener("click", toStore);
    el.landing.addEventListener("click", toStore);
    el.idleStay.addEventListener("click", (e) => { e.stopPropagation(); resetIdle(); });

    let t = null;
    el.q.addEventListener("input", () => {
      el.searchWrap.classList.toggle("has-value", el.q.value.length > 0);
      clearTimeout(t);
      t = setTimeout(render, 120);
    });
    el.q.addEventListener("keydown", (e) => { if (e.key === "Enter") el.q.blur(); });
    el.clearQ.addEventListener("click", () => {
      el.q.value = "";
      el.searchWrap.classList.remove("has-value");
      render(); el.q.focus();
    });
    wireZoom();
    el.sort.addEventListener("change", render);
    el.back.addEventListener("click", closeProduct);
    el.home.addEventListener("click", () => {
      closeProduct();
      el.q.value = "";
      el.searchWrap.classList.remove("has-value");
      select("home");
    });
    el.heroCta.addEventListener("click", () => select("aoir2026"));
    document.querySelectorAll("[data-goto]").forEach((b) =>
      b.addEventListener("click", () => select(b.dataset.goto)));

    el.addBtn.addEventListener("click", () => {
      const v = variantFor(current, curColor, curSize);
      if (!v) return;
      if (addToBag(current, v)) {
        el.addBtn.textContent = "Added ✓";
        setTimeout(() => { if (current) el.addBtn.textContent = "Add to bag instead"; }, 1200);
      } else {
        el.addBtn.textContent = `Bag is full (${MAX_LINES} lines)`;
      }
    });
    el.bagBtn.addEventListener("click", openBag);
    el.bagBtn2.addEventListener("click", openBag);
    el.bagBack.addEventListener("click", closeBag);
    el.bagClear.addEventListener("click", () => { bag = []; syncBagChrome(); renderBag(); });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!el.lightbox.hidden) closeZoom();
      else if (!el.bag.hidden) closeBag();
      else if (!el.sheet.hidden) closeProduct();
    });
    document.addEventListener("gesturestart", (e) => e.preventDefault());
    for (const ev of ["pointerdown", "keydown", "wheel", "touchstart"]) {
      document.addEventListener(ev, resetIdle, { passive: true });
    }
    window.addEventListener("resize", () => {
      if (!el.sheet.hidden && current) {
        const v = variantFor(current, curColor, curSize);
        if (v) drawQR(el.qr, v.url);
      }
      if (!el.bag.hidden && bag.length) drawQR(el.bagQr, bagURL());
    });
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  fetch("data.json")
    .then((r) => { if (!r.ok) throw new Error(`data.json ${r.status}`); return r.json(); })
    .then((d) => {
      DATA = d;
      document.title = `${d.shop.name} — Shop`;
      for (const c of [...d.categories, ...d.collections]) label.set(c.id, c.label);
      d.products.forEach((p, i) => {
        catalogNo.set(p.id, String(i + 1).padStart(3, "0"));
        for (const v of p.variants) byId.set(v.id, { p, v });
      });
      if (FREE_SHIP.THRESHOLD) {
        el.heroShip.textContent = FREE_SHIP.SHORT;
        el.shipNote.textContent = FREE_SHIP.LONG;
        el.landingShip.innerHTML = "";
        el.landingShip.append(
          Object.assign(document.createElement("b"), { textContent: "Free shipping" }),
          document.createTextNode(` on orders over $${FREE_SHIP.THRESHOLD}, worldwide`));
      }
      buildMenu();
      render();
      wire();
      syncBagChrome();
    })
    .catch((err) => {
      el.landing.hidden = true;
      el.shell.hidden = false;
      el.empty.hidden = false;
      el.empty.innerHTML =
        `<h2>Couldn't load the catalogue</h2><p>${err.message}</p>` +
        `<p>If you opened index.html directly, serve the folder instead:<br>` +
        `<code>python3 -m http.server -d site 8000</code></p>`;
    });
})();
