const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const stored = {
  gemini_keys: ['test-api-key'],
  active_key_index: 0,
  gemini_model: 'gemini-test-flash'
};
global.chrome = {
  storage: {
    local: {
      get(keys, callback) {
        const result = {};
        for (const key of keys) result[key] = stored[key];
        callback(result);
      },
      async set(values) { Object.assign(stored, values); }
    }
  }
};
global.window = {};
vm.runInThisContext(fs.readFileSync('sidebar/note-synthesis.js', 'utf8'), { filename: 'sidebar/note-synthesis.js' });
vm.runInThisContext(fs.readFileSync('sidebar/gemini-client.js', 'utf8'), { filename: 'sidebar/gemini-client.js' });

function streamText(value) {
  const payload = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: value }] } }] })}\n\n`;
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    }
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const cues = [];
for (let second = 0; second <= 570; second += 30) {
  const mm = String(Math.floor(second / 60)).padStart(2, '0');
  const ss = String(second % 60).padStart(2, '0');
  cues.push(`[${mm}:${ss}] The instructor explains a distinct source-backed concept ${Math.floor(second / 30) + 1}, its reason, example, qualification and connection to the lecture objective.`);
}
const sourceTranscript = cues.join('\n');

const timestampDraft = [
  '### [00:00–02:00] Course Context',
  '- The lecture introduces the course and its preparation approach.',
  '    - It explains the intended level and the materials available to learners.',
  '',
  '### [02:00–04:00] Foundational Motivation',
  '- The instructor explains why the core subject deserves careful study.',
  '    - The explanation includes the long-term importance of foundational understanding.',
  '',
  '### [04:00–06:00] Problem-Solving Method',
  '- The lecture introduces a general problem-solving method and its purpose.',
  '    - The supporting explanation describes how the method is applied.',
  '',
  '### [06:00–10:00] Organizing and Using Information',
  '- The instructor connects organization with effective use of information.',
  '    - The explanation includes practical examples and their shared relationship.',
  ...Array.from({ length: 18 }, (_, i) => `- Additional preserved source detail ${i + 1} explains a distinct point without adding unsupported facts.`)
].join('\n');

const recoveredNote = [
  '### Course Overview and Preparation Strategy',
  '- **[Teaching Strategy]** The course is introduced through its preparation approach.',
  '    - It is organized around the learning objective and the materials described by the instructor.',
  ...Array.from({ length: 4 }, (_, i) => `    - A distinct source-supported course detail ${i + 1} is retained beneath this topic.`),
  '',
  '### Importance of Foundational Understanding',
  '- The instructor explains why the foundations should be studied carefully.',
  '    - The rationale and the distinct supporting explanation are preserved.',
  ...Array.from({ length: 4 }, (_, i) => `    - A source-backed reason or qualification ${i + 1} is retained.`),
  '',
  '### Problem Solving and Algorithms',
  '- The lecture describes a systematic method for solving problems.',
  '    - Its procedure and purpose are explained using the supplied source material.',
  ...Array.from({ length: 4 }, (_, i) => `    - A distinct procedural detail ${i + 1} is included.`),
  '',
  '### Criteria for Evaluating Solutions',
  '- The instructor compares the relevant criteria for evaluating a solution.',
  '    - The explanation preserves the relative importance and the stated reasoning.',
  ...Array.from({ length: 4 }, (_, i) => `    - A source-backed comparison detail ${i + 1} is retained.`),
  '',
  '### Data Organization and Practical Examples',
  '- Data organization is explained through several parallel real-life examples.',
  '    - The examples are grouped beneath the abstract idea they illustrate.',
  ...Array.from({ length: 5 }, (_, i) => `    - A distinct analogy or qualification ${i + 1} is preserved.`),
  '```mermaid',
  'mindmap',
  '  root((Data Organization))',
  '    Kitchen',
  '    Medical Store',
  '    Warehouse',
  '```'
].join('\n');

(async () => {
  let evidenceCalls = 0;
  let finalRenderCalls = 0;
  let editorialRepairCalls = 0;
  let semanticAuditCalls = 0;
  const events = [];

  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    const prompt = request.contents[0].parts.find(part => part.text)?.text || '';
    if (/Build a comprehensive, loss-minimizing evidence packet/.test(prompt)) {
      evidenceCalls++;
      return streamText(`### Evidence Packet\n${Array.from({ length: 45 }, (_, i) => `- Source-supported instructional detail ${i + 1} is preserved with its explanation, example and qualification.`).join('\n')}`);
    }
    if (/EDITORIAL STRUCTURE RECOVERY/.test(prompt)) {
      editorialRepairCalls++;
      assert.match(prompt, /Replace every timestamp-led section heading/);
      assert.match(prompt, /heuristic count is not a target quota/);
      return streamText(recoveredNote);
    }
    if (/SECOND-PASS SOURCE-TO-NOTE COVERAGE AUDIT/.test(prompt)) {
      semanticAuditCalls++;
      assert.match(prompt, /ORIGINAL TIMESTAMPED TRANSCRIPT/);
      assert.match(prompt, /CANDIDATE FINAL STUDY NOTES/);
      return streamText('{"omissions":[],"unsupported_claims":[]}');
    }
    finalRenderCalls++;
    assert.match(prompt, /The source-length heading estimate is guidance only, never a numerical quota/);
    return streamText(timestampDraft);
  };

  const output = await window.geminiClient.synthesizeStudyDocument({
    videoTitle: 'Structural recovery regression',
    stopTime: '10:00',
    sourceTranscript,
    onDiagnostics: event => events.push(event)
  });

  assert.equal(evidenceCalls, 1, 'original transcript must be converted into an evidence packet');
  assert.equal(finalRenderCalls, 1, 'one final render is sufficient before recovery');
  assert.equal(editorialRepairCalls, 1, 'one targeted structural recovery must run');
  assert.equal(semanticAuditCalls, 1, 'the recovered note must be checked against the source');
  assert.match(output, /^### Course Overview and Preparation Strategy/m);
  assert.doesNotMatch(output, /^#{2,4}\s+\[(?:\d{1,3}:)?\d{2}:\d{2}/m);
  assert.match(output, /^- \*\*\[Teaching Strategy\]\*/m);
  assert.match(output, /^ {4,}-\s+/m);
  assert.match(output, /^```mermaid/m);
  assert.ok(events.some(event => event.stage === 'editorial-style-measured' && event.warnings.some(w => w.code === 'fewer-than-preferred-topic-headings')));
  assert.ok(events.some(event => event.stage === 'editorial-repair-accepted'));
  assert.ok(events.some(event => event.stage === 'semantic-coverage-accepted'));
  const completion = events.find(event => event.stage === 'final-render-complete');
  assert.ok(completion, 'the recovered note must reach final-render-complete');
  assert.equal(completion.validation, 'passed');
  assert.equal(completion.semanticValidation, 'passed');
  console.log('Structural-recovery regression passed: a four-heading timestamp draft was repaired, source-audited and accepted without a time-derived heading rejection.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
