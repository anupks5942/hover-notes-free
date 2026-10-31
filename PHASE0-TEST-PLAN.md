# Phase 0.2 — v1.0.16 smoke-test plan

## Before replacing files

1. Keep the existing unpacked extension directory in its current location.
2. Make a normal filesystem backup of that directory.
3. Do **not** remove the extension from `chrome://extensions/`, clear Chrome extension storage, clear site data, or load this ZIP from a different folder path.
4. This release deliberately does not change `chrome.storage.local` keys or the IndexedDB vault-handle schema. Replacing files in the same existing directory and using **Reload** on the same Chrome extension card is the intended update path.

## Install

1. Extract `My-HoverNotes-v1.0.16-Phase0.zip` to a temporary folder.
2. Copy the extracted contents (the `background`, `content`, `icons`, `sidebar`, `tests` folders and top-level files) into your existing extension folder, allowing overwrite.
3. Open `chrome://extensions/` and click **Reload** on the existing My HoverNotes extension card. Do not delete/re-add it.
4. Refresh the YouTube tab.

## Configuration-preservation checks

- Open Settings and verify that the existing three Gemini key slots remain configured. Do not copy keys into any report or screenshot.
- Verify that the currently selected model remains as previously configured (`gemini-3.8-flash` primary selection, `gemini-3.5-flash-lite` fallback in the client).
- Verify that the Vault pill remains connected to the existing vault. Do not select a new folder unless Chrome explicitly reports that permission needs to be re-granted.
- Confirm that a short manual note save still writes under the same `HoverNotes/` directory.

## Preview regression checks

- Open or generate a note containing headings, bold/italic, lists, code blocks, LaTeX wrappers, a timestamp link and an embedded screenshot.
- Verify that supported formatting and timestamp links still render.
- Click a timestamp link and verify that the video seeks to the corresponding timestamp.
- Verify that screenshot embeds still render and the underlying Markdown remains unchanged when saved.
- The new browser fixture `tests/markdown-sanitizer.browser.html` contains malicious HTML cases. It is a test fixture only; do not copy that content into a real study note or vault.

## Existing workflow regression

- Use the same KnowledgeGATE YouTube lecture and unchanged settings.
- Start at 00:00, set playback to 2.0x, enable AI Notes, and process 20 minutes of playback (40 minutes of video-time content).
- Pause playback at the target boundary and use Stop so the final interval flushes.
- Verify the note is saved into the existing vault and all referenced images exist in `HoverNotes/images/`.
- Export the YouTube tab's Console log and provide the `.md` file plus every image referenced by it.

## What this release is intended to change

- The Markdown preview now passes rendered markup through a local allowlist sanitizer before insertion.

## What this release is not intended to change

- AI prompts or generated note wording.
- Gemini model IDs, three configured API keys, key rotation, fallback rules or generation interval.
- Caption retrieval, caption chunking, frame sampling thresholds or promotional filtering.
- Note filename strategy, existing vault path, saved vault directory handle or storage keys.

Because the browser-side change is a preview security fix, generated Markdown should remain substantively unchanged. Any difference in note generation, captions, screenshots or saving should be treated as a regression and reported.


## Additional v1.0.16 regression checks

- Trigger the toolbar-action fallback injection path on a YouTube tab where the content script is not already responding; verify that `frame-quality.js` loads before `content.js`.
- Confirm that the console contains no `analyzeTranscriptRelevance` undefined-property error.
- Confirm that a deliberate frame-capture failure is logged as a skipped screenshot and does not stop transcript-grounded AI text generation.
- Verify that subsequent intervals advance beyond the last saved timestamp instead of retrying the same `01:19–pending` interval.
