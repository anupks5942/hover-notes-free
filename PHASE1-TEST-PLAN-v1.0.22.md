# v1.0.22 focused acceptance test — marker-free evidence pipeline

## Install
1. Back up the current note and the existing unpacked extension folder.
2. Keep the same unpacked extension folder and Chrome extension card.
3. Replace the files in that folder with the ZIP contents.
4. Click Reload on the existing extension card; refresh the same YouTube tab. Do not uninstall, clear storage, or reset the vault permission.

## Run
- Use the same KG DSA lecture.
- Start at 00:00 and stop at approximately 08:00 (the same interval as the v1.0.21 field test).
- Keep English output and screenshots enabled.
- Wait for final synthesis and saving to finish.

## Required log evidence
- `source-map-start` reports `strategy: 'evidence-first-all-lengths'` and a chunk count.
- Every extraction chunk reports `source-map-complete` with `sourceWindowsMapped` greater than zero.
- Final synthesis reports `sourceWindowsMapped` equal to the non-empty 30-second window count.
- `final-render-complete` reports `validation: 'passed'`.
- `Final study-note synthesis completed` reports `outcome: 'applied-and-saved'`.
- There must be no marker-related errors; the model is no longer asked to echo `HN_TIME_*` or `HN_SOURCE_*` IDs.

## Evaluate the Markdown
- It must be organized by concepts, not headings such as `### [03:00] ...`.
- Use reference-style hyphen bullets, supporting nested bullets, and bold bracketed concept labels.
- For this eight-minute interval, expect multiple topic sections covering course approach, DSA importance, the purpose of studying DSA, computer-science problem solving, algorithms, time/memory criteria, efficiency, and the data-structure/algorithm foundation wherever supported by the source.
- Preserve screenshots, frontmatter and video title.
- Do not demand Mermaid/table/code when the captured source does not support one. The output should not invent content simply to satisfy a style checklist.
- Compare against only the matching 00:00–08:00 portion of `hovernotes.io.md`, not the complete full-lecture reference.

Upload the generated Markdown, all screenshot assets and the full Console log. The test proves whether final rendering runs and how the actual model writes; local tests alone cannot prove semantic parity.
