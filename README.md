# HoverNotes Clone — Phase 1.0.8

Build: 1.0.8

A personal Chrome Manifest V3 prototype for creating transcript-grounded YouTube lecture notes and saving them to a local Obsidian vault.

## Requirements

- Google Chrome 111 or later (the caption observer is a static MAIN-world content script).

## 1.0.8 large-caption response handling

YouTube returned a valid 13,969,317-character JSON3 caption response for the supplied Hindi lecture. v1.0.7 observed that response but discarded its body because the MAIN-world bridge had a 3 MiB transfer limit. v1.0.8 transfers large responses in numbered chunks, reassembles them in the isolated content script, checks the final character count, and then passes the full body to the JSON3 parser. The maximum accepted response is 40 MiB.

## What this build currently supports

- YouTube pages and accessible YouTube caption tracks, using a static MAIN-world observer to capture the player-issued timed-text response; watch-page HTML is metadata fallback only.
- JSON3 UTF-8 captions and modern srv3 XML caption responses.
- English-language Markdown generation from the selected caption transcript (the model translates Hindi/Hinglish captions into technical English).
- One current video frame captured for each successfully processed interval and stored in `HoverNotes/images/`.
- Gemini streaming with configured key rotation and an optional OpenAI-compatible fallback endpoint.
- Local Markdown saving in `HoverNotes/{Video_Title}.md`.
- Obsidian wiki-link screenshot references using unique `screenshot-<24-char-id>.jpg` filenames.
- Per-video progress checkpoints, fresh-run confirmation at the beginning of a video, graceful Stop with final-interval flushing, and cancellation on video navigation.

## Important limitations (not yet implemented)

- This build does **not** directly capture or transcribe video audio. It depends on captions exposed by YouTube. A video without an accessible caption track cannot produce faithful spoken-content notes; the extension reports this and does not advance its processing checkpoint.
- It samples a still frame at the end of each processing interval. It is not continuous frame-by-frame video understanding and can miss visual changes between captures.
- It is currently YouTube-specific. Generic HTML5 players, Udemy, Coursera, university LMS pages, Bilibili, Zoom/Meet recordings, and local video files are not implemented.
- The annotation toolbar, advanced HoverNotes playback popover, multilingual selector, and other full HoverNotes UI-parity features are not part of Phase 1.
- AI requests are sent to the configured external AI provider. Local Markdown/image saving does not mean AI processing is offline. The Gemini API key is still stored in `chrome.storage.local` for this client-side prototype; do not share extension storage exports or screenshots of Settings.

## Historical diagnostic/build notes

- The sidebar header displays the installed build number (`v1.0.8`).
- v1.0.4 logged service-worker proxy outcomes; that proxy path was later removed from caption acquisition.
- v1.0.5/v1.0.6 direct-fetch and inline-script experiments were superseded by the v1.0.7 MAIN-world player observer.
- Current v1.0.8 logs use the `[HoverNotes Player Bridge]` and `[HoverNotes Captions]` prefixes. Large caption bodies are transferred in 192 KiB chunks (up to a guarded 40 MiB response limit); logs never include PO-token query values or caption body text.
- Hovering the red save/error status reveals the complete diagnostic text when the compact bar clips it.

## 1.0.5 caption-fetch rollback

- Restored direct timed-text `fetch()` from the YouTube content-script context. This matches the original code path and v1.0.2; it intentionally does not route caption bodies through the extension service worker.
- Added safe content-script diagnostics for the requested caption host/path/format, HTTP status, content type, and response length. Signed query strings and caption text are not logged.
- The service-worker proxy remains available for unrelated approved requests, but timed-text retrieval no longer uses it.
- This is a targeted correction based on the v1.0.4 live diagnostic showing three service-worker requests returned HTTP 200, `text/html`, and zero response characters. Live verification is still required.

## Installation

1. Extract this ZIP to a stable folder, for example `C:\HoverNotes-Dev\hover-notes`.
2. Open `chrome://extensions/` and enable Developer mode.
3. Use **Load unpacked** and select the `hover-notes` folder (the folder containing `manifest.json`).
4. Configure your Gemini API key under the extension's Settings.
5. Connect your dedicated Obsidian test vault. The extension writes notes to `HoverNotes/` and screenshots to `HoverNotes/images/` inside that vault.
6. For future code updates, overwrite the files in the **same extracted folder** and click the extension's Reload button. Do not uninstall it or load the folder from a new path; the persisted vault directory handle is origin-scoped.
7. Refresh the YouTube tab after reloading the extension.

## Repeatable benchmark run

1. Open the same benchmark YouTube video at `00:00` and set playback to `2.0x`.
2. Click **AI Notes**. If a prior note/checkpoint exists for the same video, first export the previous output ZIP, then confirm the fresh-run prompt.
3. Let the video reach `30:00` (this is 30 minutes of video content, about 15 minutes of wall-clock playback at 2x).
4. Pause the video at `30:00`, then click **Stop**. If a generation request is already in progress, Stop finishes that segment and then processes any remaining transcript interval up to the paused timestamp.
5. Wait for the final save status. Verify the `.md` file and all referenced images exist in the vault.
6. Zip only the generated `HoverNotes/` output folder, including its `images/` directory. The images folder can retain unused screenshots from previous runs; for a clean comparison, include the images referenced by the current Markdown note. Do not include the whole vault or API keys.

## Phase 1 engineering notes

See `CHANGELOG.md` and `PHASE1-TEST-PLAN.md` for the fixes and manual acceptance tests. A static code check cannot prove Gemini output quality or Chrome/Obsidian runtime behavior; those must be validated using the benchmark run.

## YouTube caption acquisition in 1.0.7

- A dedicated static MAIN-world content script runs at `document_start`; it does not inject inline script elements, avoiding YouTube/extension CSP violations.
- The bridge observes the YouTube player's own `/api/timedtext` fetch/XHR response. It does not construct or log proof-of-origin (PO) tokens and does not refetch token-less `captionTracks[].baseUrl` values.
- When AI Notes requests a transcript, the bridge asks the YouTube player to activate the selected caption track and waits for the player-issued response.
- The browser page is the source of the caption response; the extension parses the response body in its isolated content-script context.
- This path depends on YouTube's undocumented player APIs and network behavior. It requires a live Chrome smoke test; the project does not claim it is verified until that test succeeds.
