# NexyBlock

Experimental YouTube ad filtering for Firefox. NexyBlock blocks known ad requests, removes ad data from YouTube's player responses, hides ad slots on the page and clicks **Skip** when it appears.

Everything runs locally. There is no telemetry, no remote code and no network access of its own (the extension's CSP sets `connect-src 'none'`).

**Install:** [NexyBlock on Firefox Add-ons](https://addons.mozilla.org/firefox/addon/nexyblock/)

> NexyBlock is an original implementation. It does not bundle uBlock Origin code or third-party filter lists.

## How it works

NexyBlock has four independent layers. Each can be turned on or off in the popup.

| Layer | What it does | Where |
|---|---|---|
| **Ad requests** | Cancels requests to known ad endpoints, but only when YouTube initiated them | `background.js` → `core.js` `shouldBlockRequest` |
| **Player response filtering** | Streams YouTube's `youtubei/v1/player`, `get_watch` and `resolve_url` JSON responses and removes `adPlacements`, `adSlots` and `playerAds`. Video streams, captions and playability data are left untouched | `stream.js`, `core.js` `transformPlayerJson` |
| **Page cleanup** | Hides dedicated ad containers with CSS | `content.js` |
| **Automatic Skip Ad clicks** | Clicks a visible, enabled Skip button during marked ads | `content.js` |

The filtering is designed to fail open. If a response is too large (over 2 MB), takes too long (over 1 s), or can't be parsed, the original bytes are passed through unchanged, so playback isn't broken. A per-tab **compatibility mode** in the popup turns off response filtering for a tab whose playback stalls.

## Permissions

| Permission | Why it's needed |
|---|---|
| `youtube.com`, `www.youtube.com`, `www.youtube-nocookie.com` | Run the content script (page cleanup, Skip clicks) and filter player responses on YouTube and its privacy-enhanced embed domain |
| `*.doubleclick.net`, `*.googlesyndication.com`, `*.googleadservices.com` | Cancel ad requests to Google's ad-serving domains. Firefox requires host access to a domain before an extension can block requests to it. Requests are only blocked when a YouTube page initiated them |
| `webRequest`, `webRequestBlocking` | Block ad requests and filter player responses (`filterResponseData`) |
| `storage` | Save your settings locally in Firefox |

NexyBlock declares no data collection (`data_collection_permissions: none`).

## Privacy

See [PRIVACY.md](PRIVACY.md). In short, nothing leaves your browser. Optional statistics and diagnostics are off by default, kept in memory only, and cleared when you turn them off.

## Building from source

The repository root is the extension. No build step or dependencies are needed.

```bash
# Load temporarily in Firefox: about:debugging → This Firefox → Load Temporary Add-on → manifest.json

# Package for upload (from the repo root):
zip -r -X ../nexyblock-$(jq -r .version manifest.json)-firefox.zip \
  manifest.json background.js content.js core.js stream.js \
  popup.html popup.css popup.js icon.svg
```

Or with Mozilla's [`web-ext`](https://github.com/mozilla/web-ext): `web-ext lint` and `web-ext build --ignore-files "*.md" LICENSE`.

Requires Firefox 142 or later.

## Status

Experimental. YouTube changes its ad delivery often, so blocking can break between releases. If playback stalls, use compatibility mode for that tab or pause protection and reload.

## Contributing

Issues and pull requests are welcome. Please describe the YouTube page and what you saw. If you can, include the counts from the popup's **Opt-in diagnostics** panel.

## License

[Mozilla Public License 2.0](LICENSE). You're free to use, study and build on NexyBlock. If you distribute a modified version of these files, those files must stay open source under the MPL-2.0 and keep their notices. Your own new files can use any license.
