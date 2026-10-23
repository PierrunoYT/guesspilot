const DEFAULTS = {
  apiKey: "",
  model: "google/gemini-4-argon",
  reasoning: "medium",
  maxWidth: 1600,
  autoPlace: true,
};

const SYSTEM_PROMPT = `You are a world-class GeoGuessr player. You are shown a screenshot from a geography guessing game (GeoGuessr, WorldGuessr or similar) showing a Street View location. Work out where it is as precisely as possible.

Ignore the game UI (guess map, score, timer, buttons, chat) - it holds no location info, except a compass, which tells you the camera heading.

Reason from concrete evidence, for example:
- driving side, road line colours and styles, road surface
- bollards, utility poles, guardrails, street lights, kerbs
- signs: language, script, fonts, colours, phone numbers, web domains, business names
- licence plates (shape, colour, regional codes)
- Google car / camera generation and coverage artifacts (car colour, roof rack, antenna, snorkel, blur, image quality)
- architecture, roofs, fences, walls
- vegetation, soil colour, terrain, climate, sun position

Always commit to one best guess with specific coordinates - never refuse. If you can't narrow it down to a town, place the coordinates in the most likely region of the most likely country rather than at the country's centroid.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    country: { type: "string", description: "Best-guess country name" },
    country_code: { type: "string", description: "ISO 3166-1 alpha-2 code" },
    region: { type: "string", description: "State / province / region, or empty string" },
    area: { type: "string", description: "City, town or local area, or empty string" },
    latitude: { type: "number" },
    longitude: { type: "number" },
    confidence: { type: "integer", description: "0-100 confidence in the country" },
    clues: {
      type: "array",
      items: { type: "string" },
      description: "Short bullet points of the key evidence used",
    },
    alternatives: {
      type: "array",
      items: {
        type: "object",
        properties: {
          country: { type: "string" },
          likelihood: { type: "integer", description: "0-100" },
        },
        required: ["country", "likelihood"],
        additionalProperties: false,
      },
      description: "Up to 3 other plausible countries",
    },
  },
  required: [
    "country",
    "country_code",
    "region",
    "area",
    "latitude",
    "longitude",
    "confidence",
    "clues",
    "alternatives",
  ],
  additionalProperties: false,
};

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

async function askModel(imageDataUrl, settings) {
  const body = {
    model: settings.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Where is this location? Answer with the JSON object only." },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
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
// Finds the game's guess map through React's internal fiber tree and fires a
// synthetic map click at the given coordinates, which is exactly what the
// game's own click handler listens for.
function placeMarkerInPage(lat, lng) {
  const isGoogleMap = (o) =>
    typeof o?.getDiv === "function" && typeof o.getCenter === "function" && typeof o.panTo === "function";
  const isLeafletMap = (o) =>
    typeof o?.fire === "function" && typeof o.latLngToContainerPoint === "function";

  const pick = (o, test) => {
    try {
      if (!o || typeof o !== "object") return null;
      if (test(o)) return o;
      if (test(o.map)) return o.map;
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
    } catch {}
    for (const c of candidates) {
      const hit = pick(c, test);
      if (hit) return hit;
    }
    return null;
  }

  function findMap(selectors, test) {
    for (const el of document.querySelectorAll(selectors)) {
      const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
      if (!key) continue;
      // Walk up through the component tree...
      for (let f = el[key], i = 0; f && i < 40; f = f.return, i++) {
        const hit = scanFiber(f, test);
        if (hit) return hit;
      }
      // ...then down into children (e.g. react-leaflet's context provider).
      const queue = [el[key].child];
      for (let n = 0; queue.length && n < 3000; n++) {
        const f = queue.shift();
        if (!f) continue;
        const hit = scanFiber(f, test);
        if (hit) return hit;
        queue.push(f.child, f.sibling);
      }
    }
    return null;
  }

  lat = Math.max(-85, Math.min(85, lat));
  if (lng < -180 || lng > 180) lng = ((((lng + 180) % 360) + 360) % 360) - 180;

  // WorldGuessr (react-leaflet)
  const leaflet = findMap(".leaflet-container", isLeafletMap);
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
  const gmap = findMap(
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

async function placeMarker(tabId, lat, lng) {
  try {
    const [res] = await browser.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: placeMarkerInPage,
      args: [Number(lat), Number(lng)],
    });
    return res?.result || { ok: false, error: "Marker script returned nothing." };
  } catch (err) {
    return { ok: false, error: `Couldn't place marker: ${err?.message || err}` };
  }
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

    // Hide our own overlay so it doesn't end up in the screenshot.
    if (hasOverlay) await notify(tab.id, { type: "hide" });
    let shot;
    try {
      shot = await browser.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 92 });
    } catch (err) {
      throw new Error(
        `Couldn't screenshot the tab (${err?.message || err}). ` +
          "Trigger the analysis with Alt+Shift+G or the toolbar button, which grant screenshot access."
      );
    }
    if (hasOverlay) await notify(tab.id, { type: "loading" });

    const image = await downscale(shot, settings.maxWidth);
    const guess = await askModel(image, settings);
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
