const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

global.window = {};
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../sidebar/note-synthesis.js'), 'utf8'), { filename: 'sidebar/note-synthesis.js' });
const h = window.HoverNotesNoteSynthesis;

const cues = [
  '[00:00] Intro', '[00:12] Course approach', '[00:31] Beginner level',
  '[00:59] Exam focus', '[01:10] Course timeline', '[01:31] Channel CTA', '[01:38] DSA importance',
  '[02:04] Lifelong impact', '[02:37] DSA and algorithms', '[03:00] Computer science',
  '[03:30] Algorithm definition', '[04:09] Evaluation criteria', '[04:40] Time priority',
  '[05:04] Code length', '[05:45] Data structures and algorithms', '[06:01] Definition continues'
];
const windows = h.buildCoverageWindows(cues, 30);
assert.equal(windows.length, 13, 'every non-empty 30-second interval gets a coverage marker');
assert.equal(new Set(windows.map(x => x.windowId)).size, windows.length, 'extension-owned source-window IDs are unique');
const mapped = h.validateCoverageAssignment(h.chunkTranscriptByTimeWindows(cues, 1000, 30), windows, 30);
assert.equal(mapped.valid, true, 'each original source window is assigned to exactly one packet without model-generated markers');
assert.equal(h.minimumTopicHeadings(cues, 30), 5, 'six-minute source requires a meaningful number of topic sections');

const good = `### Course Overview\n- **[Teaching Strategy]** Designed for beginners.\n    - Includes examples.\n\n### DSA Foundations\n- **[Key Insight]** DSA requires conceptual clarity.`;
assert.equal(h.validateOutput(good, 1000, { minimumCharacters: 100, minimumHeadings: 2, requireNestedBullets: true, requireBoldLabels: true, requireHyphenBullets: true }).valid, true);
assert.equal(h.validateOutput('### One heading\n* One line only.', 4000, { minimumCharacters: 10, minimumHeadings: 1, requireNestedBullets: true, requireBoldLabels: true, requireHyphenBullets: true }).valid, false);

// A small number of coherent concept sections is no longer rejected solely
// because a time-derived heading heuristic expects more sections.
const oldShape = `### Course Overview\n* **[Teaching Strategy]** Course overview.\n  * Nested detail.\n\n### Algorithms and Efficiency\n* **[Definition]** Algorithm.\n  * Time and memory.\n\n### Foundations of Efficient Programs\n* **[Definition]** Data structure.`;
const oldHeadingCheck = h.validateOutput(oldShape, 6855, { minimumRatio: 0.02, minimumCharacters: 100, minimumHeadings: 2 });
assert.equal(oldHeadingCheck.valid, true, 'three coherent headings should reach semantic/style review');
const oldBulletCheck = h.validateOutput(oldShape, 6855, { minimumRatio: 0.02, minimumCharacters: 100, minimumHeadings: 1, requireHyphenBullets: true });
assert.equal(oldBulletCheck.valid, false);
assert.match(oldBulletCheck.reason, /hyphen-bullet convention/);

const src = fs.readFileSync(path.join(__dirname, '../sidebar/gemini-client.js'), 'utf8');
const methodStart = src.indexOf('async synthesizeStudyDocument(');
const methodEnd = src.indexOf('\n  emitDiagnostics(callback, event)', methodStart);
const method = src.slice(methodStart, methodEnd);
assert.match(method, /Evidence extraction is mandatory for all transcript sizes/);
assert.doesNotMatch(method, /if \(transcript\.length <= directLimit\)/, 'short transcripts must not bypass evidence extraction');
assert.match(method, /buildCoverageWindows\(lines, 30\)/);
assert.match(method, /validateCoverageAssignment\(chunks, coverageWindows, 30\)/);
assert.match(method, /provenance remains in a code-owned sidecar/);
assert.doesNotMatch(method, /HN_TIME_|HN_SOURCE_|requiredMarkers|final-render-marker-repair/);
assert.match(method, /REFERENCE EXPORT STYLE/);
assert.match(method, /hyphen bullets/);
assert.match(method, /Do not use video title, YouTube description, channel metadata, earlier AI drafts/);
assert.match(method, /ignoredSupplementaryVisualNotesCharacters/);
assert.match(method, /preferredHeadingCount = helpers\.minimumTopicHeadings\(lines, 30\)/);
assert.match(method, /minimumHeadings: 1,/);
assert.match(method, /allowTimestampHeadings: true/);
assert.doesNotMatch(method, /final-render-marker-repair-start/);

console.log('Reference-style contract, all-length evidence extraction, deterministic source-window sidecars and metadata isolation tests passed.');
