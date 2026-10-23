# GuessPilot

A Firefox extension that looks at your current **GeoGuessr** or **WorldGuessr** round, asks **Gemini 4 Argon** (`google/gemini-4-argon`, via [OpenRouter](https://openrouter.ai)) where it is, and can drop the pin on the guess map for you.

The result appears in a draggable panel on the page: country, region, town, coordinates, a confidence bar, the clues the model used, other likely countries and its full reasoning.

> Using this in multiplayer, duels or ranked games breaks GeoGuessr's rules and can get your account banned. Stick to singleplayer and practice.

## Features

- **One shortcut**: press **Alt+Shift+G** during a round.
- **Looks around** (GeoGuessr): turns the camera 90° three times so the model sees all four directions, each labelled with its compass heading, which helps with sun position.
- **Clean screenshots**: hides its own panel and the game's guess map while capturing.
- **Auto-places the marker** on the guess map. It never presses *Guess* for you.
- **Structured reasoning**: the model must list what it sees (text, driving side, bollards, poles, plates, vegetation...) and reason through candidates *before* it answers.
- **Shows cost and provider** for every request.

## Requirements

- Firefox 128 or newer
- An [OpenRouter API key](https://openrouter.ai/keys) with some credit

## Install

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and choose `manifest.json` in this folder.
3. Click the GuessPilot icon in the toolbar, open **Settings**, paste your OpenRouter key and click **Save**.

Temporary add-ons are removed when Firefox restarts. To keep it installed permanently, either:

- use Firefox Developer Edition or Nightly, set `xpinstall.signatures.required` to `false` in `about:config`, and install a zip of this folder, or
- sign it for free as an unlisted add-on: `npx web-ext sign --channel=unlisted --api-key=... --api-secret=...` (keys from [addons.mozilla.org](https://addons.mozilla.org/developers/addon/api/key/)).

**After updating the files**, click **Reload** on the extension in `about:debugging` and refresh the game tab.

## Usage

1. Start a round on geoguessr.com or worldguessr.com.
2. Press **Alt+Shift+G**, or click the toolbar icon → **Analyze this round**.
3. Wait for the panel. A counter shows how long it's been running (usually 20–60 s on High reasoning).
4. With **Auto-place marker** on, the pin is already on the guess map. Otherwise click **Place marker**. Check it, then press *Guess* yourself.

The panel can be dragged by its header and remembers its position. **Copy** copies the coordinates and **Google Maps** opens the guessed spot.

To change the shortcut, go to `about:addons` → gear icon → **Manage Extension Shortcuts**.

## Settings

Toggles in the popup save immediately. The other settings need **Save**.

| Setting | Default | What it does |
|---|---|---|
| Auto-place marker | On | Drops the pin on the guess map after each analysis. |
| Look around | On | GeoGuessr only. Takes 4 screenshots (one per direction) instead of 1. A few seconds slower and costs more, but noticeably more accurate. |
| OpenRouter API key | — | Required. Stored only in the extension's local storage. |
| Model | `google/gemini-4-argon` | Any OpenRouter model that accepts images. |
| Reasoning effort | High | Low / Medium / High / model default. Lower is faster and cheaper, but less accurate. |
| Max screenshot width | 1600 px | Screenshots are downscaled to this before upload to save tokens. |

## How it works

1. **Capture.** The background script hides the panel and guess map, then screenshots the tab with `tabs.captureVisibleTab`. With *Look around* on, it finds GeoGuessr's Street View camera through React's internal component tree, turns it with `setPov`, waits for the imagery to load, captures again, and finally turns it back.
2. **Ask.** The screenshots are sent to OpenRouter with a system prompt (see [`prompt.js`](prompt.js)) and a strict JSON schema. The schema puts `observations` and `reasoning` *before* the answer fields so the model reasons first.
3. **Show.** The JSON answer is rendered in the panel, built inside a closed shadow DOM so the game's styles can't interfere.
4. **Place.** A script running in the page's own context finds the guess map and fires a synthetic click at the coordinates. That's a Leaflet map on WorldGuessr and a Google Maps map on GeoGuessr; both games handle the click like a real one.

### Reliability details

- Firefox stops an idle extension background script after ~30 s, even while a request is still in flight. While a request is running, the extension writes to storage every 15 s to keep it awake.
- Requests are aborted after 4 minutes with a clear error. If the panel hears nothing for 5 minutes, it shows an error too.
- OpenRouter favours cheaper providers. Google's half-price *Flex* tier queues requests and can take minutes, so it's excluded (`provider.ignore: ["google-ai-studio/flex"]`).

### Limitations

- **WorldGuessr gets one screenshot only.** Its Street View is a cross-origin Google iframe, so the extension can't turn the camera there.
- Camera turning and marker placement rely on the games' internal structure. If GeoGuessr changes its map setup, the panel will say it couldn't find the map or camera, and you can still place the pin manually from the coordinates.

## Troubleshooting

| Problem | Fix |
|---|---|
| "No OpenRouter API key set" | Open the popup → Settings → paste the key → Save. |
| Stuck on "Analyzing…" for minutes | Make sure you're on the latest version (reload in `about:debugging`). Check which provider is shown after the next result. Set reasoning to Medium for faster answers. |
| "Lost connection to GuessPilot" / "Receiving end does not exist" | The extension was reloaded after the page was opened. Refresh the page (F5). |
| "Couldn't screenshot the tab" | Use Alt+Shift+G or the toolbar button. Firefox only allows screenshots right after those. |
| "Couldn't find the guess map" | Make sure a round is open (not the results screen). Use the coordinates and place the pin yourself. |
| `NS_ERROR_FILE_NOT_FOUND` when reloading | The folder was moved. Remove the add-on and load `manifest.json` again from the new location. |
| CORS errors from `reddit.com`, `sentry` etc. in the console | Those come from the website itself (often blocked by tracking protection), not from this extension. |

To see the extension's own logs, open `about:debugging`, click **Inspect** next to GuessPilot, and use the Console tab. While that window is open Firefox never suspends the background script, so timing problems may not reproduce there.

## Costs

Every request is billed to your OpenRouter account and its cost is shown at the bottom of the panel. *Look around* sends 4 images instead of 1, and High reasoning generates more tokens. Lower either one to save money.

## Privacy

- Your API key is stored only in the extension's local storage and is only ever sent to `openrouter.ai`.
- Screenshots of the game tab are sent to OpenRouter and Google to be analyzed. Nothing else leaves your browser.

## Project structure

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3, Firefox). |
| `prompt.js` | System prompt, JSON response schema and view labels. |
| `background.js` | Screenshots, camera control, OpenRouter request, marker placement, keep-alive. |
| `content.js` | The result panel on the page; hides the guess map during capture. |
| `popup.html` / `popup.js` / `popup.css` | Toolbar popup with settings and the Analyze button. |
| `icons/icon.svg` | Extension icon. |

## Development

```sh
npx web-ext lint     # validate the extension
npx web-ext run      # start a temporary Firefox profile with it loaded
```

There's no build step: edit the files, then reload the extension in `about:debugging`.

## See also

**WhereWasThis** (separate repo, `where-was-this`): the same approach for any image or video on the web.

## License

[MIT](LICENSE)
