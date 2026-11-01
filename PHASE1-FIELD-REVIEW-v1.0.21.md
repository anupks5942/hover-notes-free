# v1.0.21 field review — failure diagnosis

## Observed run
- Video: `2o2vX0ZqQ_Y`.
- Stop boundary: `08:00`.
- Eight minutes of incremental notes were saved; the resulting Markdown is the incremental draft, not final synthesized output.
- Final synthesis entered `source-map-start` with two transcript chunks.
- The first evidence chunk returned through multiple model attempts, but packet validation failed because `[[HN_TIME_0001]]` was not present exactly once.
- The pipeline aborted before `final-render-start`; no topic-based final document was generated.

## Root cause
The extension required Gemini to reproduce machine-generated hidden source-window identifiers exactly in prose. A generative model may omit, paraphrase, relocate or otherwise alter such tokens even when it returns useful evidence. Treating those strings as the proof of coverage made a brittle protocol a fatal dependency.

## Corrective design in v1.0.22
Source provenance now remains in a JavaScript-owned sidecar. Transcript cues are deterministically bucketed into 30-second windows, transcript chunks are guaranteed not to split those windows, and each chunk's window list is stored separately from generated Markdown. During consolidation, the extension merges these metadata lists deterministically. No model response must echo a token. The final renderer receives a plain source-range manifest and concept-organizes the evidence.

## Remaining limitation
The sidecar proves no source window was dropped by the extension's chunking or packet bookkeeping. It does not mathematically prove that the model preserved every semantic detail from every window. Actual output must still be compared with the source transcript/reference export. No live Gemini result has been tested for v1.0.22.
