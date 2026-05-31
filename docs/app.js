/* PinShop frontend */

(function () {
  "use strict";

  /* ---------------------------------------------------------------------- */
  /* Config + settings                                                      */
  /* ---------------------------------------------------------------------- */

  const DEFAULTS = (window.PINSHOP_CONFIG || {});
  const LS_KEY = "pinshop.settings.v1";

  function loadSettings() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    } catch {
      saved = {};
    }
    return {
      workerUrl: (saved.workerUrl || DEFAULTS.workerUrl || "").trim().replace(/\/+$/, ""),
      amazonTag: (saved.amazonTag || DEFAULTS.amazonTag || "").trim(),
    };
  }

  function saveSettings(s) {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  }

  let settings = loadSettings();

  /* ---------------------------------------------------------------------- */
  /* Retailer link building                                                  */
  /* ---------------------------------------------------------------------- */

  const RETAILER_URLS = {
    amazon: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
    nordstrom: (q) => `https://www.nordstrom.com/sr?keyword=${encodeURIComponent(q)}`,
    asos: (q) => `https://www.asos.com/us/search/?q=${encodeURIComponent(q)}`,
    revolve: (q) => `https://www.revolve.com/r/Search.jsp?search=${encodeURIComponent(q)}`,
    zappos: (q) => `https://www.zappos.com/${encodeURIComponent(q)}`,
    etsy: (q) => `https://www.etsy.com/search?q=${encodeURIComponent(q)}`,
    lululemon: (q) => `https://shop.lululemon.com/search?Ntt=${encodeURIComponent(q)}`,
    wayfair: (q) => `https://www.wayfair.com/keyword.php?keyword=${encodeURIComponent(q)}`,
    sephora: (q) => `https://www.sephora.com/search?keyword=${encodeURIComponent(q)}`,
  };

  const RETAILER_LABELS = {
    nordstrom: "Nordstrom",
    asos: "ASOS",
    revolve: "Revolve",
    zappos: "Zappos",
    etsy: "Etsy",
    lululemon: "Lululemon",
    wayfair: "Wayfair",
    sephora: "Sephora",
  };

  // Which fallback retailers to show per identified category.
  const CATEGORY_FALLBACKS = {
    clothing: ["nordstrom", "asos", "revolve"],
    shoes: ["zappos", "nordstrom", "asos"],
    accessories: ["nordstrom", "asos", "etsy"],
    bags: ["nordstrom", "revolve", "etsy"],
    jewelry: ["etsy", "nordstrom", "revolve"],
    beauty: ["sephora", "nordstrom"],
    home: ["wayfair", "etsy"],
    furniture: ["wayfair", "etsy"],
    decor: ["etsy", "wayfair"],
    kids: ["nordstrom", "etsy"],
    fitness: ["lululemon", "zappos", "nordstrom"],
    other: ["etsy", "nordstrom"],
  };

  function amazonUrl(query) {
    let url = RETAILER_URLS.amazon(query);
    if (settings.amazonTag) {
      url += `&tag=${encodeURIComponent(settings.amazonTag)}`;
    }
    return url;
  }

  function buildFallbacks(ident) {
    const cat = (ident.category || "other").toLowerCase();
    const keys = CATEGORY_FALLBACKS[cat] || CATEGORY_FALLBACKS.other;
    const q = ident.general_query || ident.item || "";
    return keys.map((k) => ({
      label: RETAILER_LABELS[k] || k,
      url: (RETAILER_URLS[k] || RETAILER_URLS.etsy)(q),
    }));
  }

  /* ---------------------------------------------------------------------- */
  /* DOM refs                                                                */
  /* ---------------------------------------------------------------------- */

  const $ = (id) => document.getElementById(id);
  const boardForm = $("boardForm");
  const boardUrlInput = $("boardUrl");
  const loadBtn = $("loadBtn");
  const identifyAllBtn = $("identifyAllBtn");
  const statusEl = $("status");
  const grid = $("grid");
  const emptyEl = $("empty");

  // Settings modal
  const settingsModal = $("settingsModal");
  const settingsBtn = $("settingsBtn");
  const closeSettings = $("closeSettings");
  const saveSettingsBtn = $("saveSettings");
  const cfgWorkerUrl = $("cfgWorkerUrl");
  const cfgAmazonTag = $("cfgAmazonTag");

  /* ---------------------------------------------------------------------- */
  /* State                                                                   */
  /* ---------------------------------------------------------------------- */

  let pins = []; // { image_url, title, description, link, ident, state }

  function setStatus(msg) {
    statusEl.textContent = msg || "";
  }

  /* ---------------------------------------------------------------------- */
  /* Board loading                                                           */
  /* ---------------------------------------------------------------------- */

  boardForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = boardUrlInput.value.trim();
    if (!url) return;

    if (!settings.workerUrl) {
      openSettings();
      setStatus("Set your Worker URL in settings first.");
      return;
    }

    loadBtn.disabled = true;
    identifyAllBtn.disabled = true;
    setStatus("Loading board…");
    grid.innerHTML = "";
    emptyEl.hidden = true;

    try {
      const res = await fetch(
        `${settings.workerUrl}/board?url=${encodeURIComponent(url)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      pins = (data.pins || []).map((p) => ({
        ...p,
        ident: null,
        state: "idle",
      }));

      if (!pins.length) {
        emptyEl.hidden = false;
        emptyEl.textContent = "No pins found on that board.";
        setStatus("");
      } else {
        renderAll();
        identifyAllBtn.disabled = false;
        setStatus(`${pins.length} pins loaded.`);
      }
    } catch (err) {
      emptyEl.hidden = false;
      emptyEl.textContent = "Couldn't load that board.";
      setStatus("Error: " + err.message);
    } finally {
      loadBtn.disabled = false;
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Rendering                                                               */
  /* ---------------------------------------------------------------------- */

  function renderAll() {
    grid.innerHTML = "";
    pins.forEach((pin, i) => grid.appendChild(renderCard(pin, i)));
  }

  function renderCard(pin, index) {
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.index = String(index);

    const imgwrap = document.createElement("div");
    imgwrap.className = "imgwrap";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = pin.title || "Pinterest pin";
    img.src = pin.image_url;
    img.referrerPolicy = "no-referrer";
    imgwrap.appendChild(img);
    card.appendChild(imgwrap);

    const body = document.createElement("div");
    body.className = "body";

    const ident = document.createElement("div");
    ident.className = "ident";
    body.appendChild(ident);

    const links = document.createElement("div");
    links.className = "links";
    body.appendChild(links);

    card.appendChild(body);

    paintCard(card, pin, index);
    return card;
  }

  function paintCard(card, pin, index) {
    const ident = card.querySelector(".ident");
    const links = card.querySelector(".links");
    card.classList.toggle("loading", pin.state === "loading");
    ident.innerHTML = "";
    links.innerHTML = "";

    if (pin.state === "loading") {
      return; // CSS ::after shows "Identifying…"
    }

    if (pin.state === "error") {
      const err = document.createElement("div");
      err.className = "err";
      err.textContent = pin.error || "Identification failed.";
      ident.appendChild(err);
      links.appendChild(makeIdentifyButton(index, "Retry"));
      return;
    }

    if (pin.state === "done" && pin.ident) {
      const d = pin.ident;
      const itemEl = document.createElement("div");
      itemEl.className = "item";
      itemEl.textContent = d.item || "Unidentified item";
      ident.appendChild(itemEl);

      const metaBits = [d.color, d.brand].filter(Boolean).join(" · ");
      if (metaBits) {
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = metaBits;
        ident.appendChild(meta);
      }

      if (d.confidence) {
        const badge = document.createElement("span");
        badge.className = "badge " + (d.confidence || "").toLowerCase();
        badge.textContent = d.confidence + " confidence";
        ident.appendChild(badge);
      }

      // Amazon button
      const aQuery = d.amazon_query || d.item || pin.title || "";
      const amazonBtn = document.createElement("a");
      amazonBtn.className = "btn-shop btn-amazon";
      amazonBtn.href = amazonUrl(aQuery);
      amazonBtn.target = "_blank";
      amazonBtn.rel = "noopener nofollow";
      amazonBtn.textContent = "🛒 Shop on Amazon";
      links.appendChild(amazonBtn);

      // Fallback retailers
      const fb = document.createElement("div");
      fb.className = "fallbacks";
      buildFallbacks(d).forEach((f) => {
        const a = document.createElement("a");
        a.className = "btn-fallback";
        a.href = f.url;
        a.target = "_blank";
        a.rel = "noopener nofollow";
        a.textContent = f.label;
        fb.appendChild(a);
      });
      links.appendChild(fb);
      return;
    }

    // idle
    const hint = document.createElement("div");
    hint.className = "meta";
    hint.textContent = pin.title ? pin.title : "Not identified yet.";
    ident.appendChild(hint);
    links.appendChild(makeIdentifyButton(index, "Identify"));
  }

  function makeIdentifyButton(index, label) {
    const btn = document.createElement("button");
    btn.className = "btn-identify";
    btn.textContent = label;
    btn.addEventListener("click", () => identifyOne(index));
    return btn;
  }

  function repaint(index) {
    const card = grid.querySelector(`.card[data-index="${index}"]`);
    if (card) paintCard(card, pins[index], index);
  }

  /* ---------------------------------------------------------------------- */
  /* Identification                                                          */
  /* ---------------------------------------------------------------------- */

  async function identifyOne(index) {
    const pin = pins[index];
    if (!pin || pin.state === "loading") return;
    if (!settings.workerUrl) {
      openSettings();
      return;
    }

    pin.state = "loading";
    repaint(index);

    try {
      const res = await fetch(`${settings.workerUrl}/identify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_url: pin.image_url,
          title: pin.title,
          description: pin.description,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      pin.ident = data;
      pin.state = "done";
    } catch (err) {
      pin.state = "error";
      pin.error = err.message;
    }
    repaint(index);
  }

  // Identify all with concurrency = 3.
  identifyAllBtn.addEventListener("click", async () => {
    if (!pins.length) return;
    identifyAllBtn.disabled = true;
    loadBtn.disabled = true;

    const queue = pins
      .map((p, i) => i)
      .filter((i) => pins[i].state !== "done");

    const CONCURRENCY = 3;
    let cursor = 0;
    let completed = pins.length - queue.length;
    const total = pins.length;
    setStatus(`Identifying… ${completed}/${total}`);

    async function worker() {
      while (cursor < queue.length) {
        const idx = queue[cursor++];
        await identifyOne(idx);
        completed++;
        setStatus(`Identifying… ${completed}/${total}`);
      }
    }

    const workers = [];
    for (let w = 0; w < Math.min(CONCURRENCY, queue.length); w++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    setStatus(`Done. ${total} pins.`);
    identifyAllBtn.disabled = false;
    loadBtn.disabled = false;
  });

  /* ---------------------------------------------------------------------- */
  /* Settings modal                                                          */
  /* ---------------------------------------------------------------------- */

  function openSettings() {
    cfgWorkerUrl.value = settings.workerUrl || "";
    cfgAmazonTag.value = settings.amazonTag || "";
    settingsModal.hidden = false;
  }
  function closeSettingsModal() {
    settingsModal.hidden = true;
  }

  settingsBtn.addEventListener("click", openSettings);
  closeSettings.addEventListener("click", closeSettingsModal);
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) closeSettingsModal();
  });
  saveSettingsBtn.addEventListener("click", () => {
    settings = {
      workerUrl: cfgWorkerUrl.value.trim().replace(/\/+$/, ""),
      amazonTag: cfgAmazonTag.value.trim(),
    };
    saveSettings(settings);
    closeSettingsModal();
    setStatus("Settings saved.");
  });

  // Prompt for setup on first visit if nothing is configured.
  if (!settings.workerUrl) {
    setStatus("Click ⚙ to add your Worker URL.");
  }
})();
