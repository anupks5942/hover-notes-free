# Phase 0 — Baseline and architecture audit

Build audited: **v1.0.14**  
Phase 0 hardening build: **v1.0.15**  
Target browser: Google Chrome (Manifest V3)

## 1. What is present in the source package

The uploaded v1.0.14 archive contains 39 files: 15 application/source assets, 11 Node.js regression tests, icons, a Manifest V3 manifest, README, changelog, test plan and version file. It has no package.json, build step or external runtime dependencies.

| Area | Files | Responsibility |
|---|---|---|
| Background | `background/service-worker.js` | Extension lifecycle, tab action, MAIN-world player response lookup, vault picker window and restricted fetch proxy |
| YouTube bridge | `content/youtube-main.js` | Observe/reuse page-context fetch/XHR caption response and relay large response bodies in chunks |
| Caption parsing | `content/caption-parser.js` | JSON3 and supported legacy XML/SRV3 timed-text parsing |
| Content integration | `content/content.js`, `content/content.css` | Inject split workspace, player controls, bridge messages, frame sampling, screenshot capture and time tracking |
| Frame quality | `content/frame-quality.js` | Edge/detail scoring, warm-tone obstruction penalty, transcript keyword gate, dHash and regional deduplication |
| AI client | `sidebar/gemini-client.js` | Three Gemini key slots, primary/fallback model cascade, SSE streaming, first-token timeout, custom OpenAI-compatible fallback and Markdown normalization |
| UI | `sidebar/sidebar.html`, `sidebar/sidebar.js`, `sidebar/sidebar.css` | Editor/preview, transcript, settings, playback controls, note generation, status and event wiring |
| Persistence | `sidebar/storage.js`, `sidebar/vault-picker.*` | File System Access API, IndexedDB directory handle persistence, Markdown and local image writes |
| Tests | `tests/*.test.cjs` | Caption, chunk relay, frame scoring, Gemini fallback, note normalization, Stop and instrumentation regressions |

## 2. Baseline architecture and data flow

1. The YouTube MAIN-world script observes player/network state and timed-text fetch/XHR responses.
2. The background service worker can query MAIN-world player response state through `chrome.scripting.executeScript` and handles extension messages.
3. The isolated content script receives the caption body, reassembles chunk messages, parses JSON3/SRV3 cues, samples the video and selects a candidate frame.
4. The sidebar asks Gemini to synthesize a bounded transcript interval, optionally with one still frame. The generated content streams into the Markdown editor.
5. Normalization inserts extension-managed screenshot anchors in chronological positions and updates the note.
6. `storage.js` persists notes and JPEG assets into the connected local folder. The selected directory handle is held in IndexedDB; Gemini configuration is in `chrome.storage.local`.

## 3. Existing working behaviour to preserve

- YouTube caption acquisition through the page's existing player response/network path.
- JSON3 plus supported XML/SRV3 parsing.
- Large chunked caption body transfer.
- 60-second video-time AI segments (the current log demonstrates 60-second intervals after the first 79-second interval).
- Gemini SSE generation with `gemini-3.8-flash` primary and `gemini-3.5-flash-lite` fallback.
- Three key slots and stored active-key index.
- The current prompt, previous-note context, timestamp normalization, screenshot insertion, Stop boundary and checkpoint behaviour.
- Frame quality scoring, promotional suppression and perceptual deduplication.
- Existing vault handle and the `HoverNotes/` plus `HoverNotes/images/` save layout.

No Phase 0 patch clears `chrome.storage.local` or the IndexedDB vault handle. The updated files must be installed over the same existing unpacked extension directory so Chrome keeps the same extension identity and origin-bound storage.

## 4. Console-log findings for the 30:00 video-time run

Source: `logs(8).log` (672 lines).

| Observation | Result | Interpretation |
|---|---:|---|
| Initial scheduler tick | 1 no-new-interval result | Normal before a full processing interval exists |
| Caption track | Hindi, 16,131 cues | Retrieval succeeded |
| Caption response | 13,969,317 characters | Large response, successfully relayed |
| Chunk relay | 72 chunks | Reassembly completed |
| Gemini 3.8 Flash | 1 HTTP 503 | Model reported high demand; this was not a 429 quota error |
| Gemini 3.5 Flash-Lite | 30 successful segment generations | Fallback and subsequent session preference worked |
| Saved note segments | 30/30 | No failed segment save appears in this run log |
| Run endpoint | 30:00 video time | AI Notes session completed at the requested boundary |
| Wall-clock run | 904,104 ms (~15m 04s) | Consistent with 30 minutes of video at 2x, plus generation overhead |
| Browser preload warnings | 339 | Repeated resource-preload warnings; not themselves extension failures |
| Blocked request | 2 `ERR_BLOCKED_BY_CLIENT` entries for Google Ads | Likely page/ad-blocking behaviour; not a caption or Gemini failure |
| 429 errors | 0 | No logged rate-limit response in this run |

The first Gemini 3.8 Flash call was made with Key #2 and returned 503 with a high-demand message. The client then successfully generated the same `00:00–01:19` interval with Flash-Lite. It kept Flash-Lite as the session-preferred model for later intervals, producing 30 successful generations in total. This is evidence that the existing fallback worked in this test; it is not a guarantee that all future 503/429 patterns will be handled optimally.

### Screenshot sampler statistics

- Sampler configured for 2,500 ms interval and `slide-detail-occlusion-dhash-v3` scoring.
- 29 completed frame-selection intervals after the initial promotional interval.
- 427 sampled candidates, 69 eligible candidates, 4 unique selected frames.
- 25 of those 29 intervals produced zero new unique frames.
- The `00:00–01:19` interval was skipped for screenshots with 11 promotional signals and zero instructional keyword signals.

The supplied transcript confirms that 00:00–01:19 is predominantly instructor/course introduction, promotion, course claims and administrative information; the DSA conceptual discussion begins around 01:39. The gate skipped screenshots only; AI note generation still processed and saved that interval. We should validate whether the four selected images and the 25 no-new-frame intervals match the desired HoverNotes screenshot density before changing thresholds. Do not loosen deduplication blindly: the same slide with a meaningful new annotation may need to be retained.

The exported console log collapses nested object details (`{…}`), so hidden `stages`, frame quality details and generated text previews cannot be reconstructed from this text export. A future log export should expand diagnostic objects or export structured JSON.

## 5. Phase 0 risks and priorities

### P0 — Markdown preview HTML injection (addressed in v1.0.15)

The v1.0.14 renderer built HTML from Markdown and assigned it directly to `notePreview.innerHTML`. Some generated elements were escaped, but ordinary text, link URLs, wiki-link image sources and inline markup were not consistently escaped or constrained. Since Markdown can originate from captions, AI output, imported files or manual edits, raw markup could introduce active elements, event handlers or unsafe URL schemes into the extension page.

v1.0.15 adds a local allowlist sanitizer and uses `replaceChildren()` with the sanitized fragment. It has no remote dependency and does not change the Markdown source saved to the vault or the AI prompt/output. Unit tests validate URL allowlists; a browser fixture covers active HTML and attribute removal.

### P1 — Broad host permission remains

`manifest.json` includes `<all_urls>` in `host_permissions`, although the injected content scripts currently match YouTube only. The broad permission appears to support user-configured OpenAI-compatible endpoints. Removing it without adding an explicit optional-permission request flow could break custom endpoints, so this Phase 0 hardening release leaves it unchanged. A later least-privilege change must request only the custom endpoint origin after a user action and be tested with existing custom endpoint configurations.

### P1 — API key storage model

Three Gemini keys and a custom endpoint key are stored in `chrome.storage.local`. The client uses the `x-goog-api-key` header rather than putting the Gemini key in the URL. This avoids URL/query-string exposure but does not make local browser-profile storage an encrypted secret vault. Never include keys in ZIP files, logs, screenshots or diagnostics.

### P1 — Local vault overwrite semantics

`saveNoteFile()` writes to a deterministic sanitized note title and opens the file with `{ create: true }`, so a same-name note can be overwritten. Preserve current behaviour for now; introduce an explicit Save/Save As and overwrite-confirmation workflow in the file-management phase.

### P1 — Screenshot density and semantic relevance

The current frame sampler is heuristic, not a continuous vision model. In this run, only four unique captures were selected from 427 candidates. Compare this against HoverNotes with automatic screenshots enabled and the same video interval before altering sampling thresholds.

### P2 — Single-platform coupling

The injected content scripts match `*.youtube.com`. The existing architecture needs a stable video-adapter interface before adding Udemy, Coursera, Vimeo, Bilibili or generic HTML5 videos.

### P2 — Rich editor parity

The current editor is a textarea plus rendered preview, not a fully WYSIWYG editor. It does not currently guarantee round-trip preservation of all Obsidian Markdown constructs. The next editor milestone must preserve YAML, wiki-links, Mermaid, mathematics and image embeds.

## 6. Phase 0.1 change summary (v1.0.15)

- Added `sidebar/markdown-sanitizer.js` and loaded it before `sidebar.js`.
- Sanitizes the preview HTML with a strict tag/attribute allowlist.
- Drops scripts, frames, SVG/MathML, forms, media, event handlers, styles and unsafe URL schemes.
- Allows ordinary safe links, timestamp links, raster image data URLs, same-extension assets, Markdown formatting, code and LaTeX wrappers.
- Added four URL-policy Node tests and a browser sanitizer regression fixture.
- Left AI models, prompts, segment timing, frame-selection thresholds, Gemini key slots, custom endpoint settings, storage keys and vault handle schema unchanged.

## 7. Validation performed

- Original v1.0.14 regression suite: 11/11 tests passed before edits.
- v1.0.15 Node regression suite: run as part of this delivery (expected 15 tests total).
- JavaScript syntax checks: run as part of this delivery.
- Browser sanitizer fixture: included for Chrome-side verification. Automated headless Chromium navigation was blocked by the execution environment's browser policy, so this specific browser runtime check is not claimed as passed here.
- Live Chrome/YouTube/Obsidian behaviour: must be confirmed on the user's machine using the existing unpacked extension path and existing storage.

### v1.0.15 validation result

- Node regression suite: **15 passed, 0 failed** (11 original tests plus 4 sanitizer URL-policy tests).
- `node --check` passed for all JavaScript files.
- Manifest parsed successfully as Manifest V3, version 1.0.15.
- The browser fixture is included. Automated Chromium navigation was blocked by the execution environment (`ERR_BLOCKED_BY_ADMINISTRATOR`), so browser DOM execution is not reported as passed. Complete the preview smoke checks in your own Chrome installation.


## 8. Regression discovered during the v1.0.15 field test

The first real Chrome test after v1.0.15 produced one successful AI segment (`00:00–01:19`) and then repeated failures on the next interval. The error returned through `captureFrameData` was:

`Cannot read properties of undefined (reading 'analyzeTranscriptRelevance')`

Root cause found in source: the normal manifest content-script list loads `content/frame-quality.js` before `content/content.js`, but the service-worker fallback path injected only `content/caption-parser.js` and `content/content.js`. When the extension action needed to recover by dynamically injecting the content scripts, the content script ran without its frame-quality dependency. Later screenshot selection made unguarded calls to that missing helper and returned a failed `CAPTURE_FRAME` response. The sidebar treated the frame failure as a fatal generation error, so the interval never advanced and the scheduler retried the same interval repeatedly.

v1.0.16 addresses this in three layers:
1. The service-worker fallback injection now includes `content/frame-quality.js` in dependency order.
2. Content-side helper calls have guarded fallback behaviour.
3. Screenshot-selection failure is non-fatal to text-note generation; the segment can still be sent to Gemini without an image.

The v1.0.15 field run is considered **failed/incomplete**. Its Markdown output contains only the introductory segment through approximately `01:17`; it is not a valid 30- or 40-minute AI-quality benchmark.
