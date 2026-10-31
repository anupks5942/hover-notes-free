## v1.0.16 in-section screenshot chronology checks

- Normalize the exact observed note structure: `### [01:38]` parent section, timestamped bullets `[01:38–02:04]`, `[02:04–02:19]`, `[02:19–02:39]`, a nested `[01:41]` visual observation, and a legacy `### [01:41](URL)` plus image embed.
- Confirm timestamped bullet blocks become `[01:38]`, `[01:41]`, `[02:04]`, `[02:19]` in that order; the earlier visual observation is no longer nested beneath a later bullet.
- Confirm the screenshot anchor and Obsidian embed are inserted immediately after the `[01:41]` visual observation inside the `[01:38]` topic section, not after the entire parent section.
- Confirm the screenshot is represented as an inline timestamp link plus image embed rather than a peer `###` heading when a timestamped parent section exists.
- Normalize the resulting document a second time and confirm the image embed appears exactly once.
- Confirm legacy top-level screenshots still insert chronologically when no preceding timestamped topic section exists.
- Confirm previous-note sanitization removes the screenshot embed and its associated timestamp link in both legacy and inline formats.

# Phase 1 manual acceptance test plan

These tests must be run in Chrome with the existing connected Obsidian vault. The source ZIP and local regression tests cannot validate live Chrome/Obsidian behaviour or model quality.

## Current four-minute live test

1. Reload v1.0.16 from the same permanent unpacked extension directory and refresh the same YouTube lecture. Keep the existing vault connection; do not clear extension storage.
2. Start the supplied KnowledgeGATE lecture at `00:00`, playback speed `2×`, and click **AI Notes**.
3. At approximately `04:00`, pause YouTube first, click Stop, and wait until generation and saving finish.
4. Export the single YouTube-tab Console log, generated Markdown, and all referenced screenshot files.
5. Verify the note has the introductory DSA conceptual explanation, chronological timestamped teaching bullets, and no repeated screenshot embeds.
6. Specifically verify the `[01:41]` visual observation and screenshot sit inside the `[01:38]` DSA section, before the `[02:04]` and `[02:19]` bullets.
7. Confirm screenshot links are on separate Markdown blocks, image paths resolve in `HoverNotes/images/`, and all timestamp references are chronologically appropriate.
8. Confirm the 30-second Gemini first-token timeout/fallback and caption chunk-reassembly remain operational.

## Benchmark procedure (only after the four-minute test passes)

- Use the same YouTube lecture, start at `00:00`, set playback to `2.0×`.
- Start AI Notes and run until the player's timestamp reaches `30:00`.
- Pause at `30:00`, click Stop, wait for the final interval to finish and save.
- Export `HoverNotes/` (Markdown plus all referenced images) and compare against the original transcript.

## General acceptance checks

1. **Grounding:** Every factual statement must be supported by the supplied captions or visibly legible frame. Do not silently add generic GATE/DSA material.
2. **Coverage:** Meaningful conceptual motivation and instructor reasoning must not be discarded merely because the segment contains no formula or operation.
3. **Chronology:** Timestamped sections, timestamped bullets, visual observations and screenshot anchors must follow lecture time.
4. **Prior context:** Later segments should not reproduce previous sections verbatim.
5. **Checkpoint integrity:** Failed/empty AI responses must not advance the processed cursor.
6. **Stop:** The final flush must not exceed the timestamp captured when Stop was clicked.
7. **Vault persistence:** Every Markdown image reference must resolve to a saved image under `HoverNotes/images/`.
8. **No captions:** A video without accessible captions must report that limitation and leave the progress checkpoint unchanged.
9. **Extension reload:** Reloading from the same folder path should retain the existing vault permission, subject to Chrome's permission state.

## Not a Phase 1 acceptance claim

These tests do not prove direct audio transcription, caption-free operation, continuous visual comprehension, full HoverNotes parity, or support for non-YouTube sites.
