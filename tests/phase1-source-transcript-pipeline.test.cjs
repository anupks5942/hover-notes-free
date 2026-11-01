const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

global.window = {};
vm.runInThisContext(fs.readFileSync('sidebar/note-synthesis.js', 'utf8'), { filename: 'sidebar/note-synthesis.js' });
const helpers = window.HoverNotesNoteSynthesis;
assert.ok(helpers, 'synthesis helpers should register');

const cues = [];
for (let i = 0; i < 74; i++) {
  const minute = String(Math.floor(i / 60)).padStart(2, '0');
  const second = String(i % 60).padStart(2, '0');
  cues.push(`[${minute}:${second}] ${String(i).padStart(2, '0')} ${'Transcript evidence '.repeat(30)}`);
}
const chunks = helpers.chunkTranscriptLines(cues, 1000);
assert.ok(chunks.length > 1, 'generic transcript chunker should split large transcripts');
assert.deepEqual(chunks.flatMap(chunk => chunk.lines), cues, 'generic chunker preserves every cue in order');
assert.equal(helpers.normalizeTranscriptForAI('[00:04](https://youtu.be/x?t=4)(https://youtu.be/x?t=4) Hindi cue'), '[00:04] Hindi cue');

const coverage = helpers.buildCoverageWindows(cues, 30);
assert.ok(coverage.length > 1);
assert.equal(new Set(coverage.map(x => x.windowId)).size, coverage.length, 'source-window IDs are unique in extension metadata');
const grouped = helpers.chunkTranscriptByTimeWindows(cues, 1000, 30);
assert.deepEqual(grouped.flatMap(chunk => chunk.lines), cues, 'coverage-aware chunking preserves every source cue in order');
for (const chunk of grouped) {
  const bucketIds = chunk.lines.map(line => Math.floor(helpers.parseTimestampSeconds(line) / 30));
  assert.equal(new Set(bucketIds).size, 1, 'a 30-second source window must never be split across evidence packets');
}
const assignment = helpers.validateCoverageAssignment(grouped, coverage, 30);
assert.equal(assignment.valid, true, 'every source window must be mapped to exactly one packet by extension code');
assert.equal(assignment.assigned.length, coverage.length);
assert.equal(helpers.validateCoverageAssignment(grouped.slice(1), coverage, 30).valid, false, 'dropping a source packet must fail code-side coverage validation');
assert.ok(helpers.minimumTopicHeadings(cues, 30) >= 1);

const good = `### Course Overview\n- **[Teaching Strategy]** Designed for beginners.\n    - Includes examples.\n\n### DSA Foundations\n- **[Key Insight]** DSA requires conceptual clarity.`;
assert.equal(helpers.validateOutput(good, 1000, { minimumCharacters: 100, minimumHeadings: 2, requireNestedBullets: true, requireBoldLabels: true, requireHyphenBullets: true }).valid, true);
assert.equal(helpers.validateOutput('### One heading\n* One line only.', 4000, { minimumCharacters: 10, minimumHeadings: 1, requireNestedBullets: true, requireBoldLabels: true, requireHyphenBullets: true }).valid, false);

const sidebar = fs.readFileSync('sidebar/sidebar.js', 'utf8');
const client = fs.readFileSync('sidebar/gemini-client.js', 'utf8');
assert.match(sidebar, /GET_TRANSCRIPT_SLICE',\s*\{\s*startTime:\s*0,\s*endTime:/, 'finalization retrieves original transcript to the Stop boundary');
assert.match(sidebar, /sourceTranscript:\s*sourceResult\.transcriptText/);
assert.doesNotMatch(sidebar, /draftMarkdown:\s*protectedAssets\.markdown/);
assert.match(client, /Evidence extraction is mandatory for all transcript sizes/);
assert.match(client, /validateCoverageAssignment\(chunks, coverageWindows, 30\)/);
assert.match(client, /source-window metadata separately/);
assert.match(client, /REFERENCE EXPORT STYLE/);
assert.doesNotMatch(client, /HN_TIME_|HN_SOURCE_/);
assert.doesNotMatch(client, /requiredMarkers|final-render-marker-repair/);
assert.doesNotMatch(client, /const directLimit = 18000/);
console.log('Source-grounded transcript, deterministic window mapping, marker-free evidence extraction and style contract tests passed.');
