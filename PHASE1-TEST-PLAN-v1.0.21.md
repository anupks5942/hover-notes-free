# v1.0.21 focused acceptance test

## Install
1. Keep the same unpacked extension folder and Chrome extension card.
2. Replace the files in that folder with the ZIP contents.
3. Click Reload on the existing extension card; refresh the same YouTube tab. Do not uninstall, clear storage, or reset the vault permission.

## Run
- Use the same KG DSA lecture.
- Start at 00:00; keep English output and screenshots enabled.
- Stop at 06:00–06:10.
- Wait for the final synthesis and save to finish.

## Required log evidence
- `source-map-start` has `strategy: 'evidence-first-all-lengths'`.
- At least one `source-map-complete` event.
- `coverageWindowCount` reflects all non-empty 30-second windows (about 13 for six minutes).
- `final-render-complete` reports `validation: 'passed'`.
- `finalSynthesis.outcome` is `applied-and-saved`.

## Evaluate the Markdown
- It should be concept-organized, not timestamp-organized.
- It should preserve course introduction, DSA importance, the purpose of studying DSA, computer science problem-solving, algorithm definition, algorithm evaluation criteria, time-vs-memory reasoning, code-length misconception, and the two pillars of efficient programs—where those are present in the transcript.
- Use nested bullets and bold bracketed labels in the reference style. Do not invent facts or force unsupported tables/diagrams.
- Compare only against the matching 00:00–06:10 portion of `hovernotes.io.md`, not the entire 3,284-word full-lecture export.

Upload the generated Markdown and full Console log. This test is a quality check, not a request to watch the entire lecture.
