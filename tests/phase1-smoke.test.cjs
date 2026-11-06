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
      get(keys, callback) { const result = {}; for (const key of keys) result[key] = stored[key]; callback(result); },
      async set(values) { Object.assign(stored, values); }
    }
  }
};
global.window = {};
vm.runInThisContext(fs.readFileSync('sidebar/note-synthesis.js', 'utf8'), { filename: 'sidebar/note-synthesis.js' });
vm.runInThisContext(fs.readFileSync('sidebar/gemini-client.js', 'utf8'), { filename: 'sidebar/gemini-client.js' });

function sseResponse(body, status = 200) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    }
  }), { status, headers: { 'Content-Type': 'text/event-stream' } });
}
function streamText(text) {
  return sseResponse(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] })}\n\ndata: [DONE]\n\n`);
}

function evidenceForPrompt(prompt, detailPrefix = 'Source-grounded teaching detail') {
  const included = prompt.match(/SOURCE WINDOWS INCLUDED IN THIS PACKET:\n([\s\S]*?)\n\nORIGINAL TIMESTAMPED TRANSCRIPT/);
  const represented = prompt.match(/SOURCE WINDOWS REPRESENTED IN THIS GROUP[^\n]*\n([\s\S]*?)\n\nEVIDENCE PACKETS/);
  const manifest = included?.[1] || represented?.[1] || '';
  const labels = [...manifest.matchAll(/(?:^|\n)(\d{2}:\d{2})–/g)].map(match => match[1]);
  return labels.map((label, index) => `### [${label}]\n- ${detailPrefix} ${index + 1}: a distinct, source-backed explanation with supporting detail.`).join('\n\n');
}

function comprehensiveMarkdown() {
  return `### GATE Exam Preparation Course
- **[Teaching Strategy]** The instructor describes a structured course for the GATE syllabus.
    - It begins from a basic level and uses real-life examples.
    - It includes concept videos, previous-year question solutions, notes and an exam roadmap.
- **[Exam Focus]** More attention is given to topics where questions are frequently asked.

### Importance of Data Structures and Algorithms
- **[Conceptual Clarity]** The instructor says DSA deserves especially strong conceptual understanding among the many subjects studied during an engineering degree.
    - The instructor says these subjects can support a professional career over the long term.
    - Students should study their fundamentals in depth rather than skimming them.

### Purpose of Studying Data Structures
- The instructor says the goal is not to jump directly into arrays, stacks or queues.
    - The larger purpose is to understand what computer science and IT engineers do and why data structures and algorithms matter.
    - Memorizing insertion and deletion algorithms is described as a smaller task than understanding the overall purpose.

### Idea of Computer Science
- Computer science involves solving problems by designing algorithms that can be converted into efficient programs.
    - The central challenge is optimizing time and memory.
- **[Definition of an Algorithm]** An algorithm is a systematic, step-by-step procedure that can be converted into a computer program using a programming language and executed to solve a problem.

### Evaluating Algorithms
- Multiple algorithms can solve the same problem, so criteria are needed to compare them.
    - **Time**: How quickly the algorithm executes.
    - **Memory**: How much space it requires.
- **[Key Insight]** The instructor gives greater priority to time, arguing that modern hardware and cloud storage make memory less of a bottleneck while execution time remains important.

### Efficient Programming
- **[Defining Efficiency]** An efficient program solves a given problem in the minimum possible time.
- **[Common Misconception]** Shorter code does not automatically mean better programming.
    - Beginners may compare a 10-line solution with a 4-line solution, but the instructor says execution speed matters more than line count.
- **[The Two Pillars]** Efficient execution depends on both data structures and algorithms.
    - Data structures determine how data is organized in computer memory.

`;
}

(async () => {
  const client = window.geminiClient;
  assert.match(client.systemPrompt, /primary record of what the instructor said/i);
  assert.match(client.systemPrompt, /Attribute the instructor's promises, guarantees, opinions, and personal claims explicitly/i);
  assert.doesNotMatch(client.systemPrompt, /1D\/2D Array address calculation|UB - LB \+ 1/);

  let requestText = '';
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    requestText = payload.contents[0].parts.find(part => part.text)?.text || '';
    return streamText('## Grounded notes\n- Only supplied evidence.');
  };
  const generated = await client.generateNotesStream({
    videoTitle: 'DSA lecture',
    currentTimestamp: '00:00–01:00',
    transcriptChunk: '[01:39] The instructor explains why Data Structures and Algorithms require conceptual clarity and deep understanding, before moving to arrays, stacks, or queues.',
    existingNotes: '## Earlier section\n- Existing point',
    onChunk: () => {}
  });
  assert.match(generated, /Grounded notes/);
  assert.match(requestText, /why Data Structures and Algorithms require conceptual clarity/i);
  assert.match(requestText, /CONTENT COVERAGE — DO NOT OMIT INSTRUCTIONAL FRAMING/i);
  assert.match(requestText, /Earlier section/);

  // Short-source mode: it must still run the evidence extraction pass first.
  const assetToken = '[[HN_VISUAL_ASSET_01]]';
  const directSource = '[00:00] Course begins from fundamentals.\n[01:00] DSA needs conceptual clarity and deep understanding.';
  const description = 'UNTRUSTED_DESCRIPTION_ONLY_DO_NOT_USE';
  const visualNotes = 'UNTRUSTED_OLD_DRAFT_ONLY_DO_NOT_USE';
  let finalPrompt = '';
  let mapCalls = 0;
  let imagePartsSeen = 0;
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    const prompt = payload.contents[0].parts.find(part => part.text)?.text || '';
    if (/Build a comprehensive, loss-minimizing evidence packet/.test(prompt)) {
      mapCalls++;
      imagePartsSeen = payload.contents[0].parts.filter(part => part.inlineData).length;
      assert.match(prompt, /SOURCE WINDOWS INCLUDED IN THIS PACKET/);
      assert.doesNotMatch(prompt, /HN_TIME_|HN_SOURCE_|REQUIRED MARKERS/);
      return streamText(`### [00:00] Course Introduction\n- Course begins from fundamentals with supporting explanation.\n\n### [01:00] DSA Fundamentals\n- DSA requires conceptual clarity and deep understanding. ${'Preserved distinct source evidence. '.repeat(10)}`);
    }
    if (/SECOND-PASS SOURCE-TO-NOTE COVERAGE AUDIT/.test(prompt)) {
      assert.match(prompt, /ORIGINAL TIMESTAMPED TRANSCRIPT/);
      assert.match(prompt, /CANDIDATE FINAL STUDY NOTES/);
      return streamText('{"omissions":[],"unsupported_claims":[]}');
    }
    finalPrompt = prompt;
    assert.match(payload.systemInstruction.parts[0].text, /expert educational note editor/i);
    assert.match(prompt, /SOURCE PACKET MAP/);
    assert.match(prompt, /SOURCE COVERAGE WINDOWS/);
    assert.doesNotMatch(prompt, /HN_TIME_|HN_SOURCE_/);
    return streamText(comprehensiveMarkdown());
  };
  const shortResult = await client.synthesizeStudyDocument({
    videoTitle: 'DSA lecture',
    stopTime: '03:00',
    sourceTranscript: directSource,
    videoDescription: description,
    visualAssets: [{ token: assetToken, timestamp: '01:00', dataUrl: 'data:image/jpeg;base64,TESTIMAGE' }],
    supplementaryVisualNotes: visualNotes
  });
  assert.equal(mapCalls, 1, 'short transcripts must run an evidence extraction pass');
  assert.equal(imagePartsSeen, 1, 'original screenshot frames available in the run cache must be attached to the matching evidence packet');
  assert.match(shortResult, /### Importance of Data Structures and Algorithms/);
  assert.match(shortResult, /### Purpose of Studying Data Structures/);
  assert.doesNotMatch(shortResult, /HN_(?:SOURCE|TIME|VISUAL_ASSET)/);
  assert.match(finalPrompt, /REFERENCE EXPORT STYLE/);
  assert.match(finalPrompt, /nested bullet structure/);
  assert.match(finalPrompt, /SOURCE COVERAGE WINDOWS/);
  assert.doesNotMatch(finalPrompt, /UNTRUSTED_DESCRIPTION_ONLY_DO_NOT_USE/);
  assert.doesNotMatch(finalPrompt, /UNTRUSTED_OLD_DRAFT_ONLY_DO_NOT_USE/);
  assert.doesNotMatch(finalPrompt, /SUPPLEMENTARY VISUAL CONTEXT/);
  assert.match(finalPrompt, /OPTIONAL SCREENSHOT PLACEHOLDERS/);
  assert.match(finalPrompt, /No word-count ratio and no arbitrary compression/);

  // Regression: evidence and final rendering must not depend on Gemini echoing opaque IDs.
  let markerlessMapCalls = 0;
  let markerlessFinalCalls = 0;
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    const prompt = payload.contents[0].parts.find(part => part.text)?.text || '';
    if (/Build a comprehensive, loss-minimizing evidence packet/.test(prompt)) {
      markerlessMapCalls++;
      assert.doesNotMatch(prompt, /HN_TIME_|HN_SOURCE_|REQUIRED MARKERS/);
      return streamText(`### Evidence\n- Every source segment's details are represented in this packet.\n${'Preserved source teaching detail. '.repeat(35)}`);
    }
    if (/SECOND-PASS SOURCE-TO-NOTE COVERAGE AUDIT/.test(prompt)) {
      return streamText('{"omissions":[],"unsupported_claims":[]}');
    }
    markerlessFinalCalls++;
    assert.doesNotMatch(prompt, /HN_TIME_|HN_SOURCE_/);
    return streamText(comprehensiveMarkdown());
  };
  const markerlessResult = await client.synthesizeStudyDocument({
    videoTitle: 'Short lecture',
    stopTime: '00:20',
    sourceTranscript: '[00:00] A short instructional explanation with a meaningful concept.'
  });
  assert.equal(markerlessMapCalls, 1);
  assert.equal(markerlessFinalCalls, 1, 'a valid model response must not be discarded for omitting extension-owned tokens');
  assert.match(markerlessResult, /### Idea of Computer Science/);
  assert.doesNotMatch(markerlessResult, /HN_(?:SOURCE|TIME)/);

  // Long-source mode: packets and code-owned time-window sidecars survive map/reduce/render.
  const longCues = Array.from({ length: 360 }, (_, i) => {
    const minutes = String(Math.floor(i / 60)).padStart(2, '0');
    const seconds = String(i % 60).padStart(2, '0');
    return `[${minutes}:${seconds}] Evidence cue ${i}. ${'The instructor gives a distinct explanation, example, and exam-related distinction. '.repeat(3)}`;
  }).join('\n');
  let longMapCalls = 0;
  let reduceCalls = 0;
  let finalCalls = 0;
  let editorialRepairCalls = 0;
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    const prompt = payload.contents[0].parts.find(part => part.text)?.text || '';
    if (/Build a comprehensive, loss-minimizing evidence packet/.test(prompt)) {
      longMapCalls++;
      assert.doesNotMatch(prompt, /HN_TIME_|HN_SOURCE_|REQUIRED MARKERS/);
      return streamText(evidenceForPrompt(prompt, `Packet ${longMapCalls} preserves explanations, examples, details and exam context. ${'Distinct supporting lecture evidence and qualifications. '.repeat(150)}`));
    }
    if (/SECOND-PASS SOURCE-TO-NOTE COVERAGE AUDIT/.test(prompt)) {
      return streamText('{"omissions":[],"unsupported_claims":[]}');
    }
    if (/EDITORIAL STRUCTURE RECOVERY/.test(prompt)) {
      editorialRepairCalls++;
      assert.match(prompt, /Use bold bracketed callouts selectively/);
      const repairedLongNote = `${comprehensiveMarkdown()}\n${Array.from({ length: 80 }, (_, i) => `- A distinct source-supported teaching point ${i + 1} remains fully explained without an unnecessary bracketed label.`).join('\n')}`;
      return streamText(repairedLongNote);
    }
    if (/Loss-minimizing consolidation of comprehensive evidence packets/.test(prompt)) {
      reduceCalls++;
      assert.match(prompt, /SOURCE WINDOWS REPRESENTED IN THIS GROUP/);
      assert.doesNotMatch(prompt, /HN_TIME_|HN_SOURCE_|REQUIRED MARKERS/);
      return streamText(evidenceForPrompt(prompt, 'The consolidated packet preserves source details and distinct examples'));
    }
    finalCalls++;
    assert.doesNotMatch(prompt, /HN_TIME_|HN_SOURCE_/);
    const longFinal = `${comprehensiveMarkdown()}\n${Array.from({ length: 80 }, (_, i) => `- **[Preserved teaching point ${i + 1}]** A distinct explanation, example, comparison, qualification, or course detail remains available in the synthesized document.`).join('\n')}`;
    return streamText(longFinal);
  };
  const largeResult = await client.synthesizeStudyDocument({
    videoTitle: 'Long DSA lecture',
    stopTime: '06:00',
    sourceTranscript: longCues,
    visualAssets: [{ token: assetToken, timestamp: '01:41' }]
  });
  assert.ok(longMapCalls >= 2, 'long transcripts should be processed in multiple source chunks');
  assert.equal(finalCalls, 1, 'the final editorial document should be rendered once');
  assert.equal(editorialRepairCalls, 1, 'excessive callout density should trigger one separate editorial refinement');
  assert.match(largeResult, /### Importance of Data Structures and Algorithms/);
  assert.doesNotMatch(largeResult, /HN_(?:SOURCE|TIME|VISUAL_ASSET)/);
  assert.ok(reduceCalls > 0, 'large evidence packets should use hierarchical consolidation');

  // Second-pass semantic audit must detect an omitted point, trigger a targeted
  // repair, then verify the repaired document against the original source again.
  const repairSource = '[00:00] The course begins from fundamentals.\n[00:30] The instructor explicitly says that no prior knowledge is required.\n[01:00] Data Structures and Algorithms require conceptual clarity.';
  let repairAuditCalls = 0;
  let repairRenderCalls = 0;
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    const prompt = payload.contents[0].parts.find(part => part.text)?.text || '';
    if (/Build a comprehensive, loss-minimizing evidence packet/.test(prompt)) {
      return streamText(evidenceForPrompt(prompt, 'Course begins from fundamentals and DSA requires conceptual clarity'));
    }
    if (/SECOND-PASS SOURCE-TO-NOTE COVERAGE AUDIT/.test(prompt)) {
      repairAuditCalls++;
      if (repairAuditCalls === 1) {
        return streamText(JSON.stringify({
          omissions: [{
            missing_point: 'The course does not require prior knowledge.',
            source_excerpt: 'no prior knowledge is required',
            source_timestamp: '00:30'
          }],
          unsupported_claims: []
        }));
      }
      return streamText('{"omissions":[],"unsupported_claims":[]}');
    }
    if (/TARGETED SEMANTIC REPAIR/.test(prompt)) {
      repairRenderCalls++;
      assert.match(prompt, /The course does not require prior knowledge/);
      assert.match(prompt, /no prior knowledge is required/);
      return streamText(`${comprehensiveMarkdown()}\n- **[Prerequisite]** No prior knowledge is required to begin the course.`);
    }
    return streamText(comprehensiveMarkdown());
  };
  const repairedResult = await client.synthesizeStudyDocument({
    videoTitle: 'Short lecture',
    stopTime: '01:30',
    sourceTranscript: repairSource
  });
  assert.equal(repairAuditCalls, 2, 'the repaired document must be audited again in a second pass');
  assert.equal(repairRenderCalls, 1, 'one targeted repair pass should be performed');
  assert.match(repairedResult, /No prior knowledge is required/);

  // If the second-pass semantic audit still finds omissions after the one
  // repair attempt, synthesis must fail closed and preserve the incremental draft.
  let failClosedAuditCalls = 0;
  let failClosedRepairCalls = 0;
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    const prompt = payload.contents[0].parts.find(part => part.text)?.text || '';
    if (/Build a comprehensive, loss-minimizing evidence packet/.test(prompt)) {
      return streamText(evidenceForPrompt(prompt, 'Course begins from fundamentals with grounded instructional detail'));
    }
    if (/SECOND-PASS SOURCE-TO-NOTE COVERAGE AUDIT/.test(prompt)) {
      failClosedAuditCalls++;
      return streamText(JSON.stringify({
        omissions: [{
          missing_point: 'The instructor explicitly states that no prior knowledge is required.',
          source_excerpt: 'no prior knowledge is required',
          source_timestamp: '00:30'
        }],
        unsupported_claims: []
      }));
    }
    if (/TARGETED SEMANTIC REPAIR/.test(prompt)) {
      failClosedRepairCalls++;
      // Deliberately return the same incomplete candidate to exercise the gate.
      return streamText(comprehensiveMarkdown());
    }
    return streamText(comprehensiveMarkdown());
  };
  await assert.rejects(client.synthesizeStudyDocument({
    videoTitle: 'Short lecture',
    stopTime: '01:30',
    sourceTranscript: '[00:00] The course starts from fundamentals.\n[00:30] No prior knowledge is required.\n[01:00] Data Structures and Algorithms require conceptual clarity.'
  }), /Second-pass semantic audit still found 1 omissions/);
  assert.equal(failClosedAuditCalls, 2, 'the candidate must be audited before and after repair');
  assert.equal(failClosedRepairCalls, 1, 'only one targeted repair attempt is allowed before fail-closed');

  let onErrorCalled = false;
  global.fetch = async () => new Response(JSON.stringify({ error: { message: 'quota exhausted' } }), {
    status: 429,
    headers: { 'Content-Type': 'application/json' }
  });
  await assert.rejects(client.generateNotesStream({
    videoTitle: 'DSA lecture', currentTimestamp: '01:00–02:00', transcriptChunk: '[01:10] Test segment',
    onError: () => { onErrorCalled = true; }
  }), /quota exhausted/);
  assert.equal(onErrorCalled, true, 'final API errors must reach onError and reject');

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.generateNotesStream({
    videoTitle: 'DSA lecture', currentTimestamp: '02:00–03:00', transcriptChunk: 'test', signal: controller.signal
  }), error => error && error.name === 'AbortError');

  console.log('Marker-free evidence-first, sidecar coverage, screenshot restoration and reference-style synthesis smoke tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
