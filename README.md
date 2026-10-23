# GeoGuess AI (Firefox extension)

Takes a screenshot of your current GeoGuessr / WorldGuessr round, sends it to **Gemini 4 Argon** (`google/gemini-4-argon`) through OpenRouter, and shows the predicted country, region, coordinates, confidence and the clues it used in a draggable overlay.

## Install

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…** and pick `manifest.json` in this folder.
3. Click the GeoGuess AI toolbar icon, open **Settings**, paste your OpenRouter key (https://openrouter.ai/keys) and click **Save**.

Temporary add-ons are removed when Firefox restarts. To keep it installed, either use Firefox Developer Edition / Nightly with `xpinstall.signatures.required = false` in `about:config` and install a zip of this folder, or sign it for free with `npx web-ext sign --channel=unlisted` (needs AMO API keys).

## Use

- Go to a round on geoguessr.com or worldguessr.com (any site works, it just screenshots the tab).
- Press **Alt+Shift+G** or click the toolbar icon → **Analyze this round**.
- The result shows up in an overlay on the page. Drag it by its header; **Google Maps** shows the guessed spot.
- With **Auto-place marker** on (toolbar popup toggle, on by default) the guess pin is dropped on the game's guess map automatically. It never submits the guess, so you still press Guess yourself. With it off, use the overlay's **Place marker** button.

Change the shortcut at `about:addons` → gear icon → **Manage Extension Shortcuts**.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Look around | On | GeoGuessr only: turns the camera 90° three times so the model sees all 4 directions, each labelled with its compass heading. A few seconds slower, noticeably more accurate. |
| Auto-place marker | On | Drops the pin on the guess map after each analysis. Saves as soon as you flip it. |
| Model | `google/gemini-4-argon` | Any OpenRouter vision model ID works. |
| Reasoning effort | High | Lower is faster and cheaper but less accurate. |
| Max screenshot width | 1600 px | Screenshots are downscaled to this before upload to save tokens. |

The cost of each request (as reported by OpenRouter) is shown at the bottom of the overlay.

## Notes

- Your API key is stored only in the extension's local storage and is sent only to `openrouter.ai`.
- Using this in multiplayer / competitive modes is against GeoGuessr's rules and can get your account banned.
