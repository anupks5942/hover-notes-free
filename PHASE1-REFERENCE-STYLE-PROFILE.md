# Reference style profile — `hovernotes.io.md`

This profile is measured from the exact user-supplied reference export. It describes observable formatting and organization, not proprietary prompts or backend behavior.

## Measured reference statistics

- File size: **21,651 characters**, **467 lines**, approximately **2,894 words** (word count depends on tokenization rules).
- Headings: **32 `###` topic headings** and **6 `####` subheadings** (38 total).
- Hyphen bullets: **245 total**, comprising **82 top-level bullets** and **163 nested bullets** (nested items indented by at least four spaces).
- **3 Mermaid diagrams**.
- **1 display-LaTeX equation**.
- **24 Markdown table lines**.
- No need to force every construct into every note: diagrams, equations, tables and blockquotes should appear only when the source supports them.

## Observed editorial structure

- Concept-based headings rather than one heading per minute or generation interval.
- Hierarchical explanatory bullets: a parent statement followed by indented reasons, examples, qualifications, operations or subcategories.
- Bold bracketed callouts such as `[Definition]`, `[Teaching Strategy]`, `[Key Insight]`, `[Example]`, `[Advantages]`, `[Disadvantages]` and similar labels.
- Important equations are set apart using display LaTeX.
- Tables are used for genuine comparisons or structured data.
- Mermaid mind maps and flowcharts visualize source-supported relationships, classifications and processes.
- Blockquotes are occasional, not a mandatory section type.
- Timestamped screenshots act as visual anchors; they do not turn every heading into a timestamp heading.
- YAML frontmatter and the note title remain document metadata, separate from the generated note body.

## Editorial contract used by v1.0.25

1. Use descriptive topic headings and occasional subheadings; do not produce a chronological transcript log.
2. Preserve the lecture's explanations, motivations, distinctions, examples, analogies, numbers, caveats, course context and exam context when actually spoken.
3. Prefer a direct concept statement followed by indented supporting details.
4. Use bold bracketed labels selectively to help scanning; routine explanatory bullets remain plain text. One conditional structure-recovery pass can fix timestamp-led headings, missing hierarchy/callouts, overuse of callouts, and possible over-merging. The source-length topic-heading estimate is a soft prompt signal, never a numerical pass/fail quota.
5. Use equations, diagrams, code and comparison tables only when source-supported and useful.
6. Avoid repeating a concept simply because the lecturer revisits it; consolidate repeated wording but preserve distinct information.
7. Keep original YAML and managed screenshot links outside the AI-generated body. Remove a body H1 only when it exactly duplicates the YAML title; preserve distinct H1 content.
8. Treat transcript as the primary spoken-content source; original frames may supplement it only where visual text is legible.
9. Do not import video-description metadata, external knowledge or facts from prior generated notes into the final document.

## Fair comparison rule

The full reference export covers substantially more lecture material than a six- or eight-minute test. Compare a capture only with the matching source interval in the reference and transcript. Evaluate **content coverage** separately from **style parity**. A partial-lecture note should not be judged by the full lecture's total word count, heading count or diagram count.
