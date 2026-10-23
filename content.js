(() => {
  if (window.__geoGuessAI) return;
  window.__geoGuessAI = true;

  const POS_KEY = "geoguess-ai-pos";

  // Remove an overlay left behind by a previous (reloaded) copy of the extension;
  // its buttons can no longer reach the background script.
  for (const stale of document.querySelectorAll("[data-geoguess-ai]")) stale.remove();

  const host = document.createElement("div");
  host.setAttribute("data-geoguess-ai", "");
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;top:80px;left:16px;display:none;";
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY));
    if (saved) Object.assign(host.style, { top: saved.top, left: saved.left });
  } catch {}
  document.documentElement.appendChild(host);

  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .panel {
        width: 320px; max-height: 70vh; display: flex; flex-direction: column;
        font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
        color: #e8eef3; background: rgba(18, 24, 32, 0.94);
        border: 1px solid rgba(255,255,255,0.12); border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.45); overflow: hidden;
        backdrop-filter: blur(6px);
      }
      .head {
        display: flex; align-items: center; gap: 8px; padding: 8px 10px;
        background: rgba(255,255,255,0.05); cursor: move; user-select: none;
      }
      .title { flex: 1; font-weight: 600; font-size: 12px; letter-spacing: .03em; color: #9fb3c3; }
      button {
        font: inherit; color: inherit; background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.14); border-radius: 6px;
        padding: 3px 8px; cursor: pointer;
      }
      button:hover { background: rgba(255,255,255,0.16); }
      .x { padding: 0 7px; font-size: 15px; line-height: 20px; }
      .body { padding: 12px; overflow-y: auto; }
      .country { font-size: 20px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
      .cc {
        font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 4px;
        background: #1a7f5a; color: #fff;
      }
      .sub { color: #b9c7d2; margin-top: 2px; }
      .coords { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
      .bar { height: 6px; border-radius: 3px; background: rgba(255,255,255,0.1); margin: 10px 0 2px; overflow: hidden; }
      .bar > i { display: block; height: 100%; background: linear-gradient(90deg, #e5484d, #f5a623, #30a46c); }
      .muted { color: #8a9aa8; font-size: 11px; }
      .actions { display: flex; gap: 6px; margin-top: 10px; }
      .actions > * {
        flex: 1; text-align: center; padding: 6px; border-radius: 6px; font-weight: 600;
      }
      button.place { background: #1a7f5a; border-color: #1a7f5a; color: #fff; }
      button.place:hover { background: #20946a; }
      button:disabled { opacity: .6; cursor: default; }
      a.map {
        color: #e8eef3; text-decoration: none;
        background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14);
      }
      a.map:hover { background: rgba(255,255,255,0.16); }
      .marker { margin-top: 6px; }
      .marker:empty { display: none; }
      .marker.ok { color: #7fd1a8; }
      h4 { margin: 12px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8a9aa8; }
      ul { margin: 0; padding-left: 18px; }
      li { margin: 2px 0; }
      .alt { display: flex; justify-content: space-between; }
      .err { color: #ff8d8d; white-space: pre-wrap; }
      .spin {
        width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.2);
        border-top-color: #7fd1a8; border-radius: 50%; animation: s 0.8s linear infinite;
        display: inline-block; vertical-align: middle; margin-right: 8px;
      }
      @keyframes s { to { transform: rotate(360deg); } }
    </style>
    <div class="panel">
      <div class="head">
        <span class="title">GEOGUESS AI</span>
        <button class="again" title="Analyze again (Alt+Shift+G)">Analyze</button>
        <button class="x" title="Close">×</button>
      </div>
      <div class="body"></div>
    </div>`;

  const body = root.querySelector(".body");
  const head = root.querySelector(".head");

  root.querySelector(".x").addEventListener("click", () => (host.style.display = "none"));
  root.querySelector(".again").addEventListener("click", () => {
    send({ type: "analyze" }).catch((err) => show(el("div", { className: "err", textContent: err.message })));
  });

  // Messages fail if the extension was reloaded/updated after this page loaded.
  async function send(msg) {
    try {
      return await browser.runtime.sendMessage(msg);
    } catch (err) {
      throw new Error(`Lost connection to GeoGuess AI (${err.message}). Refresh the page (F5) and try again.`);
    }
  }

  // Dragging
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const startX = e.clientX - host.offsetLeft;
    const startY = e.clientY - host.offsetTop;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => {
      host.style.left = Math.max(0, Math.min(innerWidth - 60, ev.clientX - startX)) + "px";
      host.style.top = Math.max(0, Math.min(innerHeight - 30, ev.clientY - startY)) + "px";
    };
    const up = () => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({ top: host.style.top, left: host.style.left }));
      } catch {}
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
  });

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const c of [].concat(children)) node.append(c);
    return node;
  }

  function show(...nodes) {
    body.replaceChildren(...nodes);
    host.style.display = "block";
  }

  const markerStatus = el("div", { className: "muted marker" });

  function setMarkerStatus({ ok, error }) {
    markerStatus.textContent = ok ? "✓ Marker placed on the guess map" : error;
    markerStatus.className = ok ? "muted marker ok" : "muted marker err";
  }

  function placeBtn(g) {
    const btn = el("button", { className: "place", textContent: "Place marker" });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      setMarkerStatus(
        await send({ type: "place", lat: g.latitude, lng: g.longitude }).catch((err) => ({ error: err.message }))
      );
      btn.disabled = false;
    });
    return btn;
  }

  function renderResult(g) {
    markerStatus.textContent = "";
    const lat = Number(g.latitude).toFixed(5);
    const lng = Number(g.longitude).toFixed(5);
    const conf = Math.max(0, Math.min(100, Number(g.confidence) || 0));
    const place = [g.area, g.region].filter(Boolean).join(", ");

    const copyBtn = el("button", { textContent: "Copy" });
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(`${lat}, ${lng}`).then(() => {
        copyBtn.textContent = "Copied";
        setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
      });
    });

    const nodes = [
      el("div", { className: "country" }, [
        g.country_code ? el("span", { className: "cc", textContent: g.country_code.toUpperCase() }) : "",
        el("span", { textContent: g.country || "Unknown" }),
      ]),
    ];
    if (place) nodes.push(el("div", { className: "sub", textContent: place }));
    nodes.push(
      el("div", { className: "coords" }, [el("span", { textContent: `${lat}, ${lng}` }), copyBtn]),
      el("div", { className: "bar" }, [el("i", { style: `width:${conf}%` })]),
      el("div", { className: "muted", textContent: `Confidence ${conf}%` }),
      el("div", { className: "actions" }, [placeBtn(g), el("a", {
        className: "map",
        href: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
        target: "_blank",
        rel: "noopener",
        textContent: "Google Maps",
      })]),
      markerStatus
    );

    if (g.clues?.length) {
      nodes.push(el("h4", { textContent: "Clues" }), el("ul", {}, g.clues.map((c) => el("li", { textContent: c }))));
    }
    if (g.alternatives?.length) {
      nodes.push(
        el("h4", { textContent: "Alternatives" }),
        ...g.alternatives.map((a) =>
          el("div", { className: "alt" }, [
            el("span", { textContent: a.country }),
            el("span", { className: "muted", textContent: `${a.likelihood}%` }),
          ])
        )
      );
    }
    const meta = [g.model, g.cost != null ? `$${Number(g.cost).toFixed(4)}` : ""].filter(Boolean).join(" · ");
    if (meta) nodes.push(el("div", { className: "muted", style: "margin-top:10px", textContent: meta }));
    show(...nodes);
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  browser.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "ping":
        return Promise.resolve(true);
      case "hide":
        host.style.display = "none";
        return nextFrame().then(() => true);
      case "loading":
        show(el("div", {}, [el("span", { className: "spin" }), "Analyzing location…"]));
        break;
      case "result":
        renderResult(msg.guess);
        break;
      case "marker":
        setMarkerStatus(msg);
        break;
      case "error":
        show(el("div", { className: "err", textContent: msg.error }));
        break;
    }
  });
})();
