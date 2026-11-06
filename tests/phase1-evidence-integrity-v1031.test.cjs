const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

global.window = {};
vm.runInThisContext(fs.readFileSync('sidebar/note-synthesis.js', 'utf8'), {
  filename: 'sidebar/note-synthesis.js'
});
const helpers = window.HoverNotesNoteSynthesis;

const windows = [
  { windowId: 'w1', bucket: 15, startLabel: '07:30', endLabel: '07:59', cueCount: 8 },
  { windowId: 'w2', bucket: 16, startLabel: '08:00', endLabel: '08:29', cueCount: 7 },
  { windowId: 'w3', bucket: 17, startLabel: '08:30', endLabel: '08:59', cueCount: 9 }
];

// 1. Markerless prose cannot claim source-window coverage merely because it is long.
const markerless = 'Generic plausible-looking evidence without any source anchors. '.repeat(80);
const markerlessResult = helpers.validateEvidencePacket(markerless, windows);
assert.equal(markerlessResult.valid, false);
assert.deepEqual(markerlessResult.missingWindows, ['07:30', '08:00', '08:30']);

// 2. A timestamp mentioned in ordinary prose is not a source-window anchor.
const proseTimestamp = `The instructor says this topic was covered at 07:30.\n${markerless}`;
assert.equal(helpers.validateEvidencePacket(proseTimestamp, windows).valid, false);

// 3. Exactly one anchor per source window is required.
const uniqueAnchors = `### [07:30]\n- A substantial source-grounded explanation for the first window.\n\n### [08:00]\n- A substantial source-grounded explanation for the second window.\n\n### [08:30]\n- A substantial source-grounded explanation for the third window.`;
const uniqueResult = helpers.validateEvidencePacket(uniqueAnchors, windows);
assert.equal(uniqueResult.valid, true);
assert.equal(uniqueResult.coveredWindows, 3);

const duplicateAnchors = `### [07:30]\n- First explanation for the first window.\n\n### [07:30]\n- Second explanation for the same window.\n\n### [08:00]\n- Substantial second-window explanation.\n\n### [08:30]\n- Substantial third-window explanation.`;
const duplicateResult = helpers.validateEvidencePacket(duplicateAnchors, windows);
assert.equal(duplicateResult.valid, false);
assert.deepEqual(duplicateResult.duplicateAnchors, ['07:30']);
assert.ok(duplicateResult.reasons.some(reason => /Duplicate source window anchor/.test(reason)));

// 4. Out-of-order anchors are rejected even if all labels are present.
const outOfOrder = `### [08:00]\n- Substantial second-window explanation.\n\n### [07:30]\n- Substantial first-window explanation.\n\n### [08:30]\n- Substantial third-window explanation.`;
const orderResult = helpers.validateEvidencePacket(outOfOrder, windows);
assert.equal(orderResult.valid, false);
assert.deepEqual(orderResult.outOfOrderWindows, ['07:30']);

// 5. Merge preserves unique content from both initial and repair packets.
const initial = `### [07:30]\n- Original definition and its distinct explanation.\n\n### [08:00]\n- Original second-window example and its implication.`;
const repair = `### [07:30]\n- Repair adds a distinct caveat omitted from the initial packet.\n\n### [08:30]\n- Repair adds the third-window comparison and conclusion.`;
const merged = helpers.mergeEvidenceEntries(initial, repair, windows);
assert.match(merged, /Original definition and its distinct explanation/);
assert.match(merged, /Repair adds a distinct caveat omitted from the initial packet/);
assert.match(merged, /Original second-window example and its implication/);
assert.match(merged, /Repair adds the third-window comparison and conclusion/);
assert.equal((merged.match(/\[07:30\]/g) || []).length, 1);
assert.equal(helpers.validateEvidencePacket(merged, windows).valid, true);

// 5b. Any leading context outside the first timestamp anchor is preserved.
const mergedWithPreamble = helpers.mergeEvidenceEntries(
  'Evidence context: retain the original explanation below.\n\n### [07:30]\n- Initial anchored explanation that is sufficiently detailed.',
  'Repair context: this adds the missing windows.\n\n### [08:00]\n- Repair anchored explanation with its distinct detail.\n\n### [08:30]\n- Last anchored explanation with its distinct detail.',
  windows
);
assert.match(mergedWithPreamble, /Evidence context: retain the original explanation/);
assert.match(mergedWithPreamble, /Repair context: this adds the missing windows/);
assert.equal(helpers.validateEvidencePacket(mergedWithPreamble, windows).valid, true);

// 6. Exact duplicate repair fragments may be deduplicated without discarding unique material.
const exactMerged = helpers.mergeEvidenceEntries(
  '### [07:30]\n- Shared detail repeated exactly.',
  '### [07:30]\n- Shared detail repeated exactly.\n- Additional repair detail is preserved.',
  [windows[0]]
);
assert.equal((exactMerged.match(/Shared detail repeated exactly/g) || []).length, 1);
assert.match(exactMerged, /Additional repair detail is preserved/);

// Load actual streaming methods and verify completion metadata never fabricates STOP.
const stored = { gemini_keys: ['test-key'], active_key_index: 0, gemini_model: 'gemini-test-flash' };
global.chrome = { storage: { local: {
  get(keys, callback) { const result = {}; for (const key of keys) result[key] = stored[key]; callback(result); },
  async set(values) { Object.assign(stored, values); }
} } };
vm.runInThisContext(fs.readFileSync('sidebar/gemini-client.js', 'utf8'), {
  filename: 'sidebar/gemini-client.js'
});

function sseResponse(events) {
  const body = events.join('');
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); }
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

(async () => {
  const client = window.geminiClient;
  client.firstTokenTimeoutMs = 5000;

  // 7. Normal reader EOF with content but no finish reason or [DONE] is unknown, not STOP.
  global.fetch = async () => sseResponse([
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'partial evidence' }] } }] })}\n\n`
  ]);
  const unknownGemini = await client.streamGeminiSSE({
    apiKey: 'test-key', model: 'gemini-test-flash', promptText: 'test', returnMetadata: true
  });
  assert.equal(unknownGemini.metadata.finishReason, null);
  assert.equal(unknownGemini.metadata.completionStatus, 'unknown_completion');
  assert.equal(unknownGemini.metadata.hasTerminalSignal, false);
  assert.equal(unknownGemini.metadata.isComplete, false);
  assert.equal(unknownGemini.metadata.streamEndedNormally, true);

  // 8. Explicit Gemini STOP is reported as completed.
  global.fetch = async () => sseResponse([
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'complete evidence' }] }, finishReason: 'STOP' }] })}\n\n`
  ]);
  const stoppedGemini = await client.streamGeminiSSE({
    apiKey: 'test-key', model: 'gemini-test-flash', promptText: 'test', returnMetadata: true
  });
  assert.equal(stoppedGemini.metadata.finishReason, 'STOP');
  assert.equal(stoppedGemini.metadata.completionStatus, 'completed');
  assert.equal(stoppedGemini.metadata.hasTerminalSignal, true);
  assert.equal(stoppedGemini.metadata.isComplete, true);

  // 9. Transport [DONE] without model finish metadata is explicitly distinguished.
  global.fetch = async () => sseResponse([
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'done without reason' }] } }] })}\n\n`,
    'data: [DONE]\n\n'
  ]);
  const doneGemini = await client.streamGeminiSSE({
    apiKey: 'test-key', model: 'gemini-test-flash', promptText: 'test', returnMetadata: true
  });
  assert.equal(doneGemini.metadata.finishReason, null);
  assert.equal(doneGemini.metadata.completionStatus, 'done_marker_without_finish_reason');
  assert.equal(doneGemini.metadata.hasTerminalSignal, true);
  assert.equal(doneGemini.metadata.isComplete, true);

  // 10. MAX_TOKENS remains explicitly truncated.
  global.fetch = async () => sseResponse([
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'truncated evidence' }] }, finishReason: 'MAX_TOKENS' }] })}\n\n`
  ]);
  const truncatedGemini = await client.streamGeminiSSE({
    apiKey: 'test-key', model: 'gemini-test-flash', promptText: 'test', returnMetadata: true
  });
  assert.equal(truncatedGemini.metadata.finishReason, 'MAX_TOKENS');
  assert.equal(truncatedGemini.metadata.completionStatus, 'truncated');
  assert.equal(truncatedGemini.metadata.isTruncated, true);
  assert.equal(truncatedGemini.metadata.isComplete, false);

  // 11. OpenAI-compatible streams receive equivalent truthful completion metadata.
  client.customEndpointUrl = 'https://example.invalid/v1';
  client.customModel = 'test-openai-compatible';
  global.fetch = async () => sseResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'custom output' } }] })}\n\n`
  ]);
  const unknownCustom = await client.streamOpenAIExtension({ promptText: 'test', returnMetadata: true });
  assert.equal(unknownCustom.metadata.finishReason, null);
  assert.equal(unknownCustom.metadata.completionStatus, 'unknown_completion');
  assert.equal(unknownCustom.metadata.hasTerminalSignal, false);

  console.log('v1.0.31 evidence-integrity and truthful-stream-completion tests passed (14 scenarios).');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
