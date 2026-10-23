const DEFAULTS = {
  apiKey: "",
  model: "google/gemini-4-argon",
  reasoning: "high",
  maxWidth: 1600,
  autoPlace: true,
  lookAround: true,
};
const TOGGLES = ["autoPlace", "lookAround"];
const FIELDS = Object.keys(DEFAULTS).filter((k) => !TOGGLES.includes(k));

const $ = (id) => document.getElementById(id);
const status = $("status");

function setStatus(text, cls = "") {
  status.textContent = text;
  status.className = cls || "muted";
}

async function load() {
  const settings = { ...DEFAULTS, ...(await browser.storage.local.get(Object.keys(DEFAULTS))) };
  for (const key of FIELDS) $(key).value = settings[key];
  for (const key of TOGGLES) $(key).checked = settings[key];
  if (!settings.apiKey) $("settings").open = true;
}

// Toggles save immediately, no need to press Save.
for (const key of TOGGLES) {
  $(key).addEventListener("change", (e) => browser.storage.local.set({ [key]: e.target.checked }));
}

$("save").addEventListener("click", async () => {
  await browser.storage.local.set({
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim() || DEFAULTS.model,
    reasoning: $("reasoning").value,
    maxWidth: Number($("maxWidth").value) || DEFAULTS.maxWidth,
  });
  $("saved").textContent = "Saved";
  setTimeout(() => ($("saved").textContent = ""), 1500);
});

$("analyze").addEventListener("click", async () => {
  const btn = $("analyze");
  btn.disabled = true;
  setStatus("Analyzing…");
  const { guess, marker, error } = await browser.runtime
    .sendMessage({ type: "analyze" })
    .catch((err) => ({ error: `Background script not reachable (${err.message}). Reload the extension in about:debugging.` }));
  btn.disabled = false;
  if (error) return setStatus(error, "err");
  const place = [guess.area, guess.region, guess.country].filter(Boolean).join(", ");
  let text = `${place}\n${Number(guess.latitude).toFixed(4)}, ${Number(guess.longitude).toFixed(4)} · ${guess.confidence}% confident`;
  if (marker) text += marker.ok ? "\n✓ Marker placed" : `\n${marker.error}`;
  setStatus(text, "ok");
});

load();
