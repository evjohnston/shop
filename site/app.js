/* AoIR kiosk storefront.
   No cart and no on-device checkout: every purchase leaves via a QR code that
   the shopper scans with their own phone. Built to sit in Guided Access. */

(() => {
  "use strict";

  const IDLE_MS = 3 * 60 * 1000;   // return to the grid after this much silence

  const $ = (id) => document.getElementById(id);
  const el = {
    grid: $("grid"), chips: $("chips"), count: $("count"), scope: $("scope"),
    empty: $("empty"), q: $("q"), clearQ: $("clearQ"), searchWrap: $("searchWrap"),
    sort: $("sort"), home: $("home"), sheet: $("sheet"), back: $("back"),
    sheetTitle: $("sheetTitle"), sheetBody: $("sheetBody"),
    galMain: $("galMain"), galStrip: $("galStrip"),
    pName: $("pName"), pPrice: $("pPrice"), pSku: $("pSku"),
    pIdx: $("pIdx"), pCat: $("pCat"), pDetails: $("pDetails"),
    colorOpt: $("colorOpt"), colors: $("colors"), colorVal: $("colorVal"),
    sizeOpt: $("sizeOpt"), sizes: $("sizes"), sizeVal: $("sizeVal"),
    qr: $("qr"), qrVariant: $("qrVariant"),
  };

  let DATA = null;
  let filter = "all";
  let current = null, curColor = null, curSize = null;
  const label = new Map();          // filter id -> display label
  const catalogNo = new Map();      // product id -> stable index like "014"

  const money = (n) =>
    "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const priceLabel = (p) =>
    p.priceMin === p.priceMax ? money(p.priceMin) : `${money(p.priceMin)} – ${money(p.priceMax)}`;

  /* ---------------------------------------------------------------- QR draw */

  // data.json ships each variant's QR as a base64 module matrix; redraw it here
  // so the page carries no QR library and works with no network.
  function drawQR(canvas, b64, n) {
    const raw = atob(b64);
    const quiet = 4;                       // spec minimum light border
    const total = n + quiet * 2;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cssSize = canvas.clientWidth || 252;
    // Snap to a whole number of device pixels per module so the code stays sharp.
    const scale = Math.max(1, Math.floor((cssSize * dpr) / total));
    const px = total * scale;

    canvas.width = px;
    canvas.height = px;

    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = "#000000";

    for (let r = 0; r < n; r++) {
      let run = 0;
      for (let c = 0; c <= n; c++) {
        const i = r * n + c;
        const on = c < n && (raw.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1;
        if (on) { run++; continue; }
        if (run) {
          ctx.fillRect((c - run + quiet) * scale, (r + quiet) * scale, run * scale, scale);
          run = 0;
        }
      }
    }
  }

  /* ----------------------------------------------------------------- filter */

  function visible() {
    const term = el.q.value.trim().toLowerCase();
    let list = DATA.products.filter((p) => {
      if (filter !== "all") {
        const hit = p.category === filter || p.collections.includes(filter);
        if (!hit) return false;
      }
      if (!term) return true;
      return p.name.toLowerCase().includes(term) ||
             p.colors.some((c) => c.name.toLowerCase().includes(term));
    });

    const s = el.sort.value;
    if (s === "featured") {
      // This is a conference kiosk: lead with the current year's merch.
      const rank = (p) => (p.collections.includes("aoir2026") ? 0 : 1);
      return list.slice().sort((a, b) => rank(a) - rank(b));
    }
    const by = {
      "price-asc":  (a, b) => a.priceMin - b.priceMin,
      "price-desc": (a, b) => b.priceMax - a.priceMax,
      "name":       (a, b) => a.name.localeCompare(b.name),
      "new":        (a, b) => (b.created || "").localeCompare(a.created || ""),
    }[s];
    if (by) list = list.slice().sort(by);
    return list;
  }

  function render() {
    const list = visible();
    el.grid.innerHTML = "";
    el.empty.hidden = list.length > 0;
    el.count.textContent = list.length
      ? `${String(list.length).padStart(2, "0")} item${list.length === 1 ? "" : "s"}`
      : "No items";
    const term = el.q.value.trim();
    el.scope.textContent = term
      ? `"${term}"`
      : (filter === "all" ? "Complete catalog" : (label.get(filter) || ""));

    const frag = document.createDocumentFragment();
    for (const p of list) {
      const b = document.createElement("button");
      b.className = "item";
      b.type = "button";

      const swatches = p.colors.length > 1
        ? `<div class="sw">${p.colors.slice(0, 7).map((c) =>
            `<i style="background:${c.swatch || "#444"}"></i>`
          ).join("")}${p.colors.length > 7 ? `<b>+${p.colors.length - 7}</b>` : ""}</div>`
        : "";

      b.innerHTML =
        `<div class="plate"${p.card ? ` style="background:${p.card.bg}"` : ""}>${p.card
          ? `<img src="${p.card.src}" alt="" loading="lazy" decoding="async">` : ""}</div>` +
        `<div class="cap">` +
          `<div class="idx">${catalogNo.get(p.id)}</div>` +
          `<div class="nm"></div>` +
          `<div class="pr">${priceLabel(p)}</div>` +
          swatches +
        `</div>`;
      b.querySelector(".nm").textContent = p.name;   // names contain quotes/apostrophes
      b.addEventListener("click", () => openProduct(p));
      frag.appendChild(b);
    }
    el.grid.appendChild(frag);
    window.scrollTo(0, 0);
  }

  function buildChips() {
    const mk = (id, text, n) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-pressed", String(filter === id));
      b.innerHTML = `${text}${n != null ? `<span class="n">${String(n).padStart(2, "0")}</span>` : ""}`;
      b.addEventListener("click", () => {
        filter = id;
        // The 2026 collection carries the CDMX pink; everything else is AoIR teal.
        document.body.dataset.accent = id === "aoir2026" ? "pink" : "";
        buildChips();
        render();
      });
      return b;
    };
    el.chips.innerHTML = "";
    el.chips.appendChild(mk("all", "All", DATA.products.length));
    for (const c of DATA.collections) el.chips.appendChild(mk(c.id, c.label, c.count));
    if (DATA.collections.length && DATA.categories.length) {
      const r = document.createElement("span");
      r.className = "rule";
      el.chips.appendChild(r);
    }
    for (const c of DATA.categories) el.chips.appendChild(mk(c.id, c.label, c.count));
  }

  /* ---------------------------------------------------------------- product */

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

    el.pDetails.innerHTML = "";
    for (const d of p.details || []) {
      const li = document.createElement("li");
      li.textContent = d;
      el.pDetails.appendChild(li);
    }
    // A lone colour is not a choice, so don't make people look at it.
    el.colorOpt.hidden = p.colors.length < 2;
    el.sizeOpt.hidden = p.sizes.length < 2;

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
      if (c.swatch && !named) {
        b.style.background = c.swatch;
      } else {
        b.className = "named";
        b.textContent = c.name;
      }
      b.addEventListener("click", () => {
        curColor = c.name;
        // Keep the chosen size if this colour has it, else fall back.
        const avail = sizesForColor(current, curColor);
        if (!avail.has(curSize)) curSize = current.sizes.find((s) => avail.has(s)) || curSize;
        renderColors();
        renderSizes();
        syncVariant();
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
      b.addEventListener("click", () => {
        curSize = s;
        renderSizes();
        syncVariant();
      });
      el.sizes.appendChild(b);
    }
  }

  function renderGallery() {
    const c = current.colors.find((x) => x.name === curColor) || current.colors[0];
    const imgs = (c.images && c.images.length) ? c.images : (current.card ? [current.card] : []);
    const show = (im) => {
      el.galMain.src = im.src;
      // Letterbox against the shot's own backdrop so nothing is ever cropped.
      el.galMain.parentElement.style.background = im.bg;
    };
    if (imgs.length) show(imgs[0]);
    el.galMain.alt = `${current.name} — ${c.name}`;

    el.galStrip.innerHTML = "";
    if (imgs.length < 2) return;
    imgs.forEach((im, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.style.background = im.bg;
      b.setAttribute("aria-pressed", String(i === 0));
      b.innerHTML = `<img src="${im.src}" alt="" loading="lazy" decoding="async">`;
      b.addEventListener("click", () => {
        show(im);
        [...el.galStrip.children].forEach((x, j) =>
          x.setAttribute("aria-pressed", String(i === j)));
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

    if (!v) {
      el.pPrice.textContent = priceLabel(current);
      el.qrVariant.textContent = "This combination isn’t available.";
      el.qr.getContext("2d").clearRect(0, 0, el.qr.width, el.qr.height);
      el.pSku.textContent = "";
      return;
    }
    el.pPrice.textContent = money(v.price);
    const bits = [curColor === "Default" ? null : curColor,
                  realSize ? curSize : null].filter(Boolean);
    el.qrVariant.textContent =
      (bits.length ? bits.join(" / ") : current.name) + "  —  " + money(v.price);
    el.pSku.textContent = v.sku ? `SKU ${v.sku}` : "";
    drawQR(el.qr, v.qr, v.n);
  }

  /* ------------------------------------------------------------------ idle */

  let idleTimer = null;
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // Hand the kiosk back to the next person in a clean state.
      closeProduct();
      el.q.value = "";
      el.searchWrap.classList.remove("has-value");
      filter = "all";
      el.sort.value = "featured";
      document.body.dataset.accent = "";
      buildChips();
      render();
    }, IDLE_MS);
  }

  /* ------------------------------------------------------------------ wire */

  function wire() {
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
      render();
      el.q.focus();
    });
    el.sort.addEventListener("change", render);
    el.back.addEventListener("click", closeProduct);
    el.home.addEventListener("click", () => {
      closeProduct();
      filter = "all";
      el.q.value = "";
      el.searchWrap.classList.remove("has-value");
      document.body.dataset.accent = "";
      buildChips();
      render();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !el.sheet.hidden) closeProduct();
    });
    // Guided Access still allows a two-finger pinch; keep the layout fixed.
    document.addEventListener("gesturestart", (e) => e.preventDefault());
    for (const ev of ["pointerdown", "keydown", "wheel", "touchstart"]) {
      document.addEventListener(ev, resetIdle, { passive: true });
    }
    window.addEventListener("resize", () => {
      if (current) {
        const v = variantFor(current, curColor, curSize);
        if (v) drawQR(el.qr, v.qr, v.n);
      }
    });
  }

  if ("serviceWorker" in navigator) {
    // Keeps the kiosk usable if the venue wifi drops mid-conference.
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  fetch("data.json")
    .then((r) => {
      if (!r.ok) throw new Error(`data.json ${r.status}`);
      return r.json();
    })
    .then((d) => {
      DATA = d;
      document.title = `${d.shop.name} — Shop`;
      for (const c of [...d.categories, ...d.collections]) label.set(c.id, c.label);
      // Catalogue numbers follow the shop's own order, so they stay put
      // regardless of how the shopper sorts or filters.
      d.products.forEach((p, i) => catalogNo.set(p.id, String(i + 1).padStart(3, "0")));
      buildChips();
      render();
      wire();
      resetIdle();
    })
    .catch((err) => {
      el.count.textContent = "";
      el.empty.hidden = false;
      el.empty.innerHTML =
        `<h2>Couldn’t load the catalogue</h2><p>${err.message}</p>` +
        `<p>If you opened index.html directly, serve the folder instead:<br>` +
        `<code>python3 -m http.server -d site 8000</code></p>`;
    });
})();
