/* AoIR kiosk storefront.

   No cart on the device and no checkout on the device: a shopper either scans
   one item's code, or builds a bag and scans a single code for the lot. Money
   is only ever handled on the shopper's own phone.

   Runs unattended in Guided Access, so it returns to the landing screen and
   empties the bag after 90s of no touch. */

(() => {
  "use strict";

  const IDLE_MS  = 90 * 1000;   // total quiet time before the kiosk resets
  const WARN_MS  = 15 * 1000;   // how much of that is the "still there?" prompt
  const MAX_LINES = 15;         // keeps the bag's QR sparse enough to scan

  const $ = (id) => document.getElementById(id);
  const el = {
    landing: $("landing"), start: $("start"), shell: $("shell"),
    grid: $("grid"), menu: $("menu"), count: $("count"), scope: $("scope"),
    empty: $("empty"), q: $("q"), clearQ: $("clearQ"), searchWrap: $("searchWrap"),
    sort: $("sort"), home: $("home"),
    sheet: $("sheet"), back: $("back"), sheetTitle: $("sheetTitle"), sheetBody: $("sheetBody"),
    galMain: $("galMain"), galStrip: $("galStrip"),
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
  let filter = "all";
  let current = null, curColor = null, curSize = null;
  let bag = [];                       // [{id, qty, name, color, size, price, img}]
  const label = new Map();
  const catalogNo = new Map();
  const byId = new Map();             // variant id -> {product, variant}

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
    el.bagTotal.textContent = money(bagTotal());
    el.bagCount.textContent = `${n} item${n === 1 ? "" : "s"} · ${bag.length} line${bag.length === 1 ? "" : "s"}`;
    drawQR(el.bagQr, bagURL());
  }

  const openBag = () => { renderBag(); el.bag.hidden = false; };
  const closeBag = () => { el.bag.hidden = true; };

  /* ------------------------------------------------------------ filter */

  function visible() {
    const term = el.q.value.trim().toLowerCase();
    let list = DATA.products.filter((p) => {
      if (filter !== "all") {
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
    const list = visible();
    el.grid.innerHTML = "";
    el.empty.hidden = list.length > 0;
    el.count.textContent = list.length ? `${list.length} item${list.length === 1 ? "" : "s"}` : "";
    const term = el.q.value.trim();
    el.scope.textContent = term ? `Search: ${term}`
      : (filter === "all" ? "All products" : (label.get(filter) || ""));

    const frag = document.createDocumentFragment();
    for (const p of list) {
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
      frag.appendChild(b);
    }
    el.grid.appendChild(frag);
    window.scrollTo(0, 0);
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
      b.addEventListener("click", () => {
        filter = id;
        document.body.dataset.accent = id === "aoir2026" ? "pink" : "";
        buildMenu();
        render();
      });
      return b;
    };
    const grp = (t) => {
      const d = document.createElement("div");
      d.className = "grp";
      d.textContent = t;
      return d;
    };
    el.menu.innerHTML = "";
    el.menu.append(grp("Collections"), mk("all", "All products", DATA.products.length));
    for (const c of DATA.collections) el.menu.appendChild(mk(c.id, c.label, c.count));
    if (DATA.categories.length) {
      el.menu.appendChild(grp("Browse by type"));
      for (const c of DATA.categories) el.menu.appendChild(mk(c.id, c.label, c.count));
    }
    el.menu.scrollTop = 0;
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
      b.innerHTML = `<img src="${im.src}" alt="" loading="lazy" decoding="async">`;
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

  /* ---------------------------------------------------- kiosk lifecycle */

  function toLanding() {
    closeProduct();
    closeBag();
    el.idle.hidden = true;
    el.shell.hidden = true;
    el.landing.hidden = false;
    bag = [];
    syncBagChrome();
    filter = "all";
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
    el.sort.addEventListener("change", render);
    el.back.addEventListener("click", closeProduct);
    el.home.addEventListener("click", () => {
      closeProduct();
      filter = "all";
      el.q.value = "";
      el.searchWrap.classList.remove("has-value");
      document.body.dataset.accent = "";
      buildMenu(); render();
    });

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
      if (!el.bag.hidden) closeBag();
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
