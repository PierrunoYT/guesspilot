const DEFAULTS = {
  apiKey: "",
  model: "google/gemini-4-argon",
  reasoning: "high",
  maxWidth: 1600,
  autoPlace: true,
  lookAround: true,
};

// How long to let Street View load new tiles after turning the camera.
const VIEW_SETTLE_MS = 1200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const running = new Set();

async function getSettings() {
  return { ...DEFAULTS, ...(await browser.storage.local.get(Object.keys(DEFAULTS))) };
}

// Inject the overlay on demand so it works on any site, not just a fixed list.
async function ensureOverlay(tabId) {
  try {
    await browser.tabs.sendMessage(tabId, { type: "ping" });
    return true;
  } catch {
    try {
      await browser.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      return true;
    } catch {
      return false; // e.g. about: pages
    }
  }
}

function notify(tabId, msg) {
  return browser.tabs.sendMessage(tabId, msg).catch(() => {});
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function downscale(dataUrl, maxWidth) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  if (bitmap.width <= maxWidth) return dataUrl;
  const scale = maxWidth / bitmap.width;
  const canvas = new OffscreenCanvas(maxWidth, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return blobToDataURL(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 }));
}

function parseJson(text) {
  const cleaned = text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Model did not return valid JSON:\n" + text.slice(0, 300));
  }
}

async function askModel(views, host, settings) {
  const parts = [{ type: "text", text: describeViews(views, host) }];
  views.forEach((view, i) => {
    parts.push(
      { type: "text", text: viewLabel(view, i, views.length) },
      { type: "image_url", image_url: { url: view.image } }
    );
  });
  parts.push({ type: "text", text: "Where is this location? Answer with the JSON object only." });

  const body = {
    model: settings.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: parts },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "geo_guess", strict: true, schema: RESPONSE_SCHEMA },
    },
  };
  if (settings.reasoning !== "default") body.reasoning = { effort: settings.reasoning };

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "GeoGuess AI",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    const message = data?.error?.message || `HTTP ${res.status}`;
    throw new Error(`OpenRouter error: ${message}`);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned an empty response.");

  const guess = parseJson(content);
  guess.model = data.model || settings.model;
  guess.cost = data.usage?.cost;
  return guess;
}

// Runs in the page's own JS context (world: "MAIN"), so it must be self-contained.
// Finds the game's map / Street View objects through React's internal fiber
// tree and drives them the same way the game's own UI does:
//   "place"  - fire a synthetic click on the guess map at [lat, lng]
//   "getPov" - read the Street View camera heading/pitch/zoom
//   "setPov" - turn the Street View camera to the given pov
function pageAction(action, arg) {
  const isGoogleMap = (o) =>
    typeof o?.getDiv === "function" && typeof o.getCenter === "function" && typeof o.panTo === "function";
  const isLeafletMap = (o) =>
    typeof o?.fire === "function" && typeof o.latLngToContainerPoint === "function";
  const isPanorama = (o) =>
    typeof o?.getPov === "function" && typeof o.setPov === "function" && typeof o.getPano === "function";

  const pick = (o, test) => {
    try {
      if (!o || typeof o !== "object") return null;
      if (test(o)) return o;
      for (const k of ["map", "panorama", "pano", "streetView"]) if (test(o[k])) return o[k];
    } catch {}
    return null;
  };

  function scanFiber(f, test) {
    const candidates = [];
    try {
      const props = f.memoizedProps;
      if (props && typeof props === "object") candidates.push(props, ...Object.values(props));
      for (let s = f.memoizedState, i = 0; s && typeof s === "object" && i < 50; s = s.next, i++) {
        const v = s.memoizedState;
        candidates.push(v);
        if (v && typeof v === "object" && "current" in v) candidates.push(v.current);
      }
      const inst = f.stateNode;
      if (inst && typeof inst === "object" && !(inst instanceof Node)) candidates.push(...Object.values(inst));
    } catch {}
    for (const c of candidates) {
      const hit = pick(c, test);
      if (hit) return hit;
    }
    return null;
  }

  function searchDown(fiber, test, limit) {
    const queue = [fiber];
    for (let n = 0; queue.length && n < limit; n++) {
      const f = queue.shift();
      if (!f) continue;
      const hit = scanFiber(f, test);
      if (hit) return hit;
      queue.push(f.child, f.sibling);
    }
    return null;
  }

  function find(selectors, test) {
    const els = new Set();
    for (const el of document.querySelectorAll(selectors)) {
      els.add(el);
      // Google renders .gm-style itself; the React-owned node is its parent.
      if (el.parentElement) els.add(el.parentElement);
    }
    for (const el of els) {
      const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
      if (!key) continue;
      for (let f = el[key], i = 0; f && i < 40; f = f.return, i++) {
        const hit = scanFiber(f, test);
        if (hit) return hit;
      }
      const hit = searchDown(el[key].child, test, 3000);
      if (hit) return hit;
    }
    // Last resort: search the whole React tree from the app root.
    for (const root of [document.getElementById("__next"), document.getElementById("root"), document.body]) {
      const key = root && Object.keys(root).find((k) => k.startsWith("__reactContainer$"));
      if (!key) continue;
      const hit = searchDown(root[key], test, 20000);
      if (hit) return hit;
    }
    return null;
  }

  if (action === "getPov" || action === "setPov") {
    const pano = find('[data-qa="panorama"], [class*="panorama"], .gm-style', isPanorama);
    if (!pano) return { ok: false, error: "Street View camera not found." };
    if (action === "setPov") {
      pano.setPov({ heading: arg.heading, pitch: arg.pitch });
      if (arg.zoom != null && typeof pano.setZoom === "function") pano.setZoom(arg.zoom);
      return { ok: true };
    }
    const pov = pano.getPov();
    const zoom = typeof pano.getZoom === "function" ? pano.getZoom() : null;
    return { ok: true, heading: pov.heading, pitch: pov.pitch, zoom };
  }

  let [lat, lng] = arg;
  lat = Math.max(-85, Math.min(85, lat));
  if (lng < -180 || lng > 180) lng = ((((lng + 180) % 360) + 360) % 360) - 180;

  // WorldGuessr (react-leaflet)
  const leaflet = find(".leaflet-container", isLeafletMap);
  if (leaflet) {
    const latlng = new (leaflet.getCenter().constructor)(lat, lng);
    leaflet.fire("click", {
      latlng,
      layerPoint: leaflet.latLngToLayerPoint(latlng),
      containerPoint: leaflet.latLngToContainerPoint(latlng),
      originalEvent: new MouseEvent("click"),
    });
    try { leaflet.panTo(latlng); } catch {}
    return { ok: true };
  }

  // GeoGuessr (Google Maps)
  const gmap = find(
    '[class*="guess-map"], [data-qa="guess-map"], .gm-style, [aria-roledescription="map"]',
    isGoogleMap
  );
  if (gmap) {
    const g = window.google?.maps;
    const latLng = g ? new g.LatLng(lat, lng) : { lat: () => lat, lng: () => lng };
    if (g?.event) {
      g.event.trigger(gmap, "click", { latLng });
    } else {
      // No global google object: call the map's registered click listeners directly.
      for (const listener of Object.values(gmap.__e3_?.click || {})) {
        for (const fn of Object.values(listener || {})) {
          if (typeof fn === "function") fn({ latLng });
        }
      }
    }
    try { gmap.panTo(latLng); } catch {}
    return { ok: true };
  }

  return { ok: false, error: "Couldn't find the guess map on this page. Is a round open?" };
}

async function runInPage(tabId, action, arg) {
  try {
    const [res] = await browser.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: pageAction,
      args: [action, arg],
    });
    return res?.result || { ok: false, error: "Page script returned nothing." };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function placeMarker(tabId, lat, lng) {
  const res = await runInPage(tabId, "place", [Number(lat), Number(lng)]);
  if (!res.ok && !res.error.startsWith("Couldn't")) res.error = `Couldn't place marker: ${res.error}`;
  return res;
}

async function capture(windowId, maxWidth) {
  let shot;
  try {
    shot = await browser.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 92 });
  } catch (err) {
    throw new Error(
      `Couldn't screenshot the tab (${err?.message || err}). ` +
        "Trigger the analysis with Alt+Shift+G or the toolbar button, which grant screenshot access."
    );
  }
  return downscale(shot, maxWidth);
}

// Screenshot the current view, then (if the Street View camera can be found)
// turn 90° three times to get the full surroundings, and turn back.
async function captureViews(tab, settings) {
  const pov = settings.lookAround ? await runInPage(tab.id, "getPov") : { ok: false };
  const views = [{ image: await capture(tab.windowId, settings.maxWidth), heading: pov.ok ? pov.heading : null }];
  if (!pov.ok) return views;

  try {
    for (const turn of [90, 180, 270]) {
      const heading = (pov.heading + turn) % 360;
      const res = await runInPage(tab.id, "setPov", { heading, pitch: 0, zoom: pov.zoom });
      if (!res.ok) break;
      await sleep(VIEW_SETTLE_MS);
      views.push({ image: await capture(tab.windowId, settings.maxWidth), heading });
    }
  } finally {
    await runInPage(tab.id, "setPov", { heading: pov.heading, pitch: pov.pitch, zoom: pov.zoom });
  }
  return views;
}

async function analyze(tab) {
  if (running.has(tab.id)) return { error: "Already analyzing this tab." };
  running.add(tab.id);
  const hasOverlay = await ensureOverlay(tab.id);

  try {
    const settings = await getSettings();
    if (!settings.apiKey) {
      throw new Error("No OpenRouter API key set. Click the GeoGuess AI toolbar button to add one.");
    }

    // Hide our overlay and the game's guess map so they don't cover the scene.
    if (hasOverlay) await notify(tab.id, { type: "hide" });
    const views = await captureViews(tab, settings);
    if (hasOverlay) await notify(tab.id, { type: "loading", views: views.length });

    let host = "";
    try { host = new URL(tab.url).hostname; } catch {}
    const guess = await askModel(views, host, settings);
    guess.views = views.length;
    await notify(tab.id, { type: "result", guess });
    await browser.storage.local.set({ lastGuess: guess });
    let marker;
    if (settings.autoPlace) {
      marker = await placeMarker(tab.id, guess.latitude, guess.longitude);
      await notify(tab.id, { type: "marker", ...marker });
    }
    return { guess, marker };
  } catch (err) {
    const error = err?.message || String(err);
    await notify(tab.id, { type: "error", error });
    return { error };
  } finally {
    running.delete(tab.id);
  }
}

browser.commands.onCommand.addListener(async (command) => {
  if (command !== "analyze") return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) analyze(tab);
});

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "analyze") {
    const tabPromise = sender.tab
      ? Promise.resolve(sender.tab)
      : browser.tabs.query({ active: true, currentWindow: true }).then(([t]) => t);
    return tabPromise.then((tab) => (tab ? analyze(tab) : { error: "No active tab." }));
  }
  if (msg.type === "place" && sender.tab) {
    return placeMarker(sender.tab.id, msg.lat, msg.lng);
  }
});
