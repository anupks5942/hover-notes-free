const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

global.window = {};
vm.runInThisContext(fs.readFileSync('sidebar/note-synthesis.js', 'utf8'), { filename: 'sidebar/note-synthesis.js' });
const h = window.HoverNotesNoteSynthesis;

const chunks = [
  { startTime: 0, endTime: 59, startLabel: '00:00', endLabel: '00:59', transcriptText: '[00:00] A' },
  { startTime: 60, endTime: 119, startLabel: '01:00', endLabel: '01:59', transcriptText: '[01:00] B' },
  { startTime: 120, endTime: 179, startLabel: '02:00', endLabel: '02:59', transcriptText: '[02:00] C' },
  { startTime: 180, endTime: 239, startLabel: '03:00', endLabel: '03:59', transcriptText: '[03:00] D' },
  { startTime: 240, endTime: 299, startLabel: '04:00', endLabel: '04:59', transcriptText: '[04:00] E' }
];
const batches = h.buildSemanticAuditBatches(chunks, 3);
assert.equal(batches.length, 2);
assert.equal(batches[0].transcriptText, '[00:00] A\n[01:00] B\n[02:00] C');
assert.equal(batches[1].startLabel, '03:00');
assert.equal(batches[1].endLabel, '04:59');

const json = h.parseSemanticAuditResponse(`Second-pass review:\n\n\`\`\`json\n${JSON.stringify({
  omissions: [{ missing_point: 'The lecturer distinguishes organizing data from using it.', source_excerpt: 'how to use', source_timestamp: '07:10' }],
  unsupported_claims: [{ claim: 'The course has 12 modules.', reason: 'No source evidence.' }]
})}\n\`\`\``);
assert.equal(json.omissions.length, 1);
assert.match(json.omissions[0].point, /organizing data from using it/);
assert.equal(json.unsupportedClaims.length, 1);
assert.throws(() => h.parseSemanticAuditResponse('not JSON'), /parseable JSON/);
assert.throws(() => h.parseSemanticAuditResponse('{"omissions":[]}'), /missing the required/);
assert.throws(() => h.parseSemanticAuditResponse('{"omissions":[{"missing_point":"X"}],"unsupported_claims":[]}'), /source excerpt or timestamp/);
assert.throws(() => h.parseSemanticAuditResponse('{"omissions":[],"unsupported_claims":[{"claim":"Y"}]}'), /must include a reason/);
assert.deepEqual(h.parseSemanticAuditResponse('{"omissions":[],"unsupported_claims":[]}'), { omissions: [], unsupportedClaims: [] });

const styled = `### Course Overview\n- **[Teaching Strategy]** Structured course.\n    - Begins with fundamentals.\n\n### Core Concept\n- **[Definition]** The lecture defines the concept.\n    - It explains the reason and provides an example.\n\n\`\`\`mermaid\nflowchart TD\n A[Input] --> B[Process]\n\`\`\``;
const metrics = h.measureReferenceStyle(styled);
assert.equal(metrics.topicHeadings, 2);
assert.equal(metrics.timestampHeadings, 0);
assert.equal(metrics.hyphenBullets, 4);
assert.equal(metrics.nestedHyphenBullets, 2);
assert.equal(metrics.boldCallouts, 2);
assert.equal(metrics.mermaidDiagrams, 1);

console.log('Second-pass semantic-audit parsing, deterministic batch mapping and reference-style measurement tests passed.');
