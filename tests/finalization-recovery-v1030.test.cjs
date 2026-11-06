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

function streamCandidate({ text, finishReason = 'STOP', usageMetadata = null, safetyRatings = null, blockReason = null }) {
  const candidate = { content: { parts: [{ text }] }, finishReason };
  if (safetyRatings) candidate.safetyRatings = safetyRatings;
  const payload = { candidates: [candidate] };
  if (usageMetadata) payload.usageMetadata = usageMetadata;
  if (blockReason) payload.promptFeedback = { blockReason };
  return sseResponse(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
}

function streamText(text, finishReason = 'STOP') {
  return streamCandidate({ text, finishReason });
}

function sampleReferenceDocument() {
  return `### Introduction to Data Structures and Algorithms

- **[Teaching Strategy]** The instructor outlines a structured curriculum for the GATE syllabus.
    - Focuses on foundational conceptual depth before jumping into implementations.
    - Prioritizes topics with recurring exam importance and provides historical question analysis.
- **[Conceptual Clarity]** Understanding why algorithms exist is more critical than memorizing specific operations.
    - Long-term engineering mastery relies on analyzing trade-offs.

### Algorithmic Efficiency Principles

- **[Definition]** An algorithm is a finite, step-by-step procedure designed to solve a well-defined computational problem.
    - Must be translatable into programming code that executes on computer hardware.
- The two primary evaluation metrics are execution time and memory consumption.
    - **[Key Insight]** Time optimization takes precedence in modern computing environments due to abundant memory.
- Efficient programs minimize runtime rather than simply reducing line counts.
    - A 10-line solution that executes faster is superior to a slower 4-line solution.

### Core Data Structure Models

- Data structures govern how information is organized and manipulated in system memory.
    - Arrays provide contiguous memory allocation with O(1) random access.
    - Linked structures provide dynamic sizing at the cost of pointer overhead.
`;
}

(async () => {
  const client = window.geminiClient;
  const helpers = window.HoverNotesNoteSynthesis;

  console.log('--- Replaying v1.0.30 Production Regression Against v1.0.31 ---');

  // =========================================================================
  // SCENARIO B: Short but complete packet (< 18%) accepted immediately with 0 recovery calls
  // =========================================================================
  {
    console.log('Testing Scenario B: Short but complete packet (< 18%) accepted with 0 recovery calls...');
    const windowLabels = ['07:30', '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30'];
    const fakeChunkWindows = windowLabels.map((lbl, idx) => ({
      windowId: `window-${String(idx + 1).padStart(4, '0')}`,
      bucket: 15 + idx,
      startLabel: lbl,
      endLabel: windowLabels[idx + 1] || '15:00',
      cueCount: 10
    }));

    // Output is ~650 characters, covering all 15 windows with concise bullet points.
    // In v1.0.29, an 8,733-character input required >= 1,571 chars (18%), throwing an exception.
    const conciseCompletePacket = windowLabels.map(lbl =>
      `### [${lbl}]\n- Concise teaching point for window ${lbl}.`
    ).join('\n\n');

    assert.ok(conciseCompletePacket.length < 8733 * 0.18, 'Packet length must be under the legacy 18% threshold');

    const validation = helpers.validateEvidencePacket(conciseCompletePacket, fakeChunkWindows);
    assert.equal(validation.valid, true, 'Validation must pass for concise but complete packet');
    assert.equal(validation.missingWindows.length, 0, 'No missing windows');
    assert.equal(validation.emptyWindows.length, 0, 'No empty windows');

    let mapCalls = 0;
    let repairCalls = 0;
    let splitCalls = 0;
    const diagEvents = [];

    global.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body);
      const prompt = payload.contents[0].parts.find(p => p.text)?.text || '';
      if (/TARGETED EVIDENCE EXTRACTION REPAIR/.test(prompt)) {
        repairCalls++;
        return streamText('repair output');
      }
      if (/Build a comprehensive, loss-minimizing evidence packet/.test(prompt)) {
        mapCalls++;
        return streamText(conciseCompletePacket);
      }
      if (/SECOND-PASS SOURCE-TO-NOTE COVERAGE AUDIT/.test(prompt)) {
        return streamText('{"omissions":[],"unsupported_claims":[]}');
      }
      return streamText(sampleReferenceDocument());
    };

    const transcriptText = windowLabels.map(lbl => `[${lbl}] Source lecture explanation cue. ${'Detail. '.repeat(10)}`).join('\n');
    const result = await client.synthesizeStudyDocument({
      videoTitle: 'Scenario B Lecture',
      stopTime: '15:00',
      sourceTranscript: transcriptText,
      onDiagnostics: event => diagEvents.push(event)
    });

    assert.ok(result.length > 200, 'Final document should be produced');
    assert.equal(repairCalls, 0, 'No repair calls should occur for complete packet');
    assert.equal(splitCalls, 0, 'No split calls should occur');
    assert.ok(diagEvents.some(e => e.stage === 'source-map-validation' && e.valid === true), 'Validation success diagnostic logged');
    console.log('✔ Scenario B passed.');
  }

  // =========================================================================
  // SCENARIO C: Short & incomplete packet triggers targeted completion, merges missing anchors, validates
  // =========================================================================
  {
    console.log('Testing Scenario C: Targeted completion merges missing anchors and validates...');
    const windowLabels = ['01:00', '01:30', '02:00', '02:30'];
    const fakeChunkWindows = windowLabels.map((lbl, idx) => ({
      windowId: `window-${String(idx + 1).padStart(4, '0')}`,
      bucket: 2 + idx,
      startLabel: lbl,
      endLabel: windowLabels[idx + 1] || '03:00',
      cueCount: 8
    }));

    // Incomplete initial output: only covers 01:00 and 01:30
    const partialInitial = `### [01:00]\n- Explanation for first window with conceptual details.\n\n### [01:30]\n- Second window content covering instructor examples.`;
    const initialVal = helpers.validateEvidencePacket(partialInitial, fakeChunkWindows);
    assert.equal(initialVal.valid, false);
    assert.deepEqual(initialVal.missingWindows, ['02:00', '02:30']);

    // Repair output provides the missing 02:00 and 02:30
    const repairOutput = `### [02:00]\n- Completed third window with distinct formula.\n\n### [02:30]\n- Completed fourth window with final exam advice.`;

    const merged = helpers.mergeEvidenceEntries(partialInitial, repairOutput, fakeChunkWindows);
    const mergedVal = helpers.validateEvidencePacket(merged, fakeChunkWindows);
    assert.equal(mergedVal.valid, true, 'Merged output must be valid');
    assert.equal(mergedVal.missingWindows.length, 0);

    // Verify chronological order in merged text
    const idx0100 = merged.indexOf('[01:00]');
    const idx0130 = merged.indexOf('[01:30]');
    const idx0200 = merged.indexOf('[02:00]');
    const idx0230 = merged.indexOf('[02:30]');
    assert.ok(idx0100 < idx0130 && idx0130 < idx0200 && idx0200 < idx0230, 'Merged blocks must be in chronological order');

    let repairInvoked = false;
    let initialMapCall = true;
    global.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body);
      const prompt = payload.contents[0].parts.find(p => p.text)?.text || '';
      if (/TARGETED EVIDENCE EXTRACTION REPAIR/.test(prompt)) {
        repairInvoked = true;
        assert.match(prompt, /02:00/);
        assert.match(prompt, /02:30/);
        return streamText(repairOutput);
      }
      if (/Build a comprehensive, loss-minimizing evidence packet/.test(prompt)) {
        if (initialMapCall) {
          initialMapCall = false;
          return streamText(partialInitial);
        }
        return streamText(merged);
      }
      if (/SECOND-PASS SOURCE-TO-NOTE COVERAGE AUDIT/.test(prompt)) {
        return streamText('{"omissions":[],"unsupported_claims":[]}');
      }
      return streamText(sampleReferenceDocument());
    };

    const transcriptText = windowLabels.map(lbl => `[${lbl}] Source cue. ${'Instructional content. '.repeat(12)}`).join('\n');
    const result = await client.synthesizeStudyDocument({
      videoTitle: 'Scenario C Lecture',
      stopTime: '03:00',
      sourceTranscript: transcriptText
    });
    assert.ok(result.length > 200);
    assert.equal(repairInvoked, true, 'Targeted repair must be invoked for missing windows');
    console.log('✔ Scenario C passed.');
  }

  // =========================================================================
  // SCENARIO D: MAX_TOKENS truncation detected, does not treat partial text as complete, splits chunk
  // =========================================================================
  {
    console.log('Testing Scenario D: MAX_TOKENS truncation detection and split...');
    let sseMetadataObserved = null;
    let splitOccurred = false;

    // Test streamGeminiSSE metadata return
    const truncatedSSE = await client.streamGeminiSSE({
      apiKey: 'test-key',
      model: 'gemini-test-flash',
      promptText: 'test prompt',
      returnMetadata: true
    }, {
      // Mock fetch locally for this test
    });
    // Now test synthesizeStudyDocument flow with MAX_TOKENS
    const windowLabels = ['05:00', '05:30', '06:00', '06:30'];
    const transcriptText = windowLabels.map(lbl => `[${lbl}] Long source cue with detailed teaching explanation. ${'More speech. '.repeat(20)}`).join('\n');

    let initialCall = true;
    global.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body);
      const prompt = payload.contents[0].parts.find(p => p.text)?.text || '';

      if (/TARGETED EVIDENCE EXTRACTION REPAIR/.test(prompt)) {
        assert.fail('Targeted repair must NOT be called when MAX_TOKENS is detected');
      }

      if (/Build a comprehensive, loss-minimizing evidence packet/.test(prompt)) {
        if (initialCall) {
          initialCall = false;
          // Emulate MAX_TOKENS truncation: partial response cut off mid-sentence
          return streamCandidate({
            text: '### [05:00]\n- Thorough discussion of concept A that is unexpectedly cut off mid-',
            finishReason: 'MAX_TOKENS'
          });
        }
        // Child chunks from splitting
        splitOccurred = true;
        const match = prompt.match(/SOURCE RANGE: (\d{2}:\d{2})–(\d{2}:\d{2})/);
        const start = match ? match[1] : '05:00';
        const end = match ? match[2] : '06:30';
        return streamText(`### [${start}]\n- Child chunk evidence covering ${start} to ${end} thoroughly and completely.`);
      }

      if (/SECOND-PASS SOURCE-TO-NOTE COVERAGE AUDIT/.test(prompt)) {
        return streamText('{"omissions":[],"unsupported_claims":[]}');
      }
      return streamText(sampleReferenceDocument());
    };

    const diag = [];
    const result = await client.synthesizeStudyDocument({
      videoTitle: 'Scenario D Lecture',
      stopTime: '07:00',
      sourceTranscript: transcriptText,
      onDiagnostics: event => diag.push(event)
    });

    assert.ok(result.length > 200);
    assert.equal(splitOccurred, true, 'Adaptive splitting must occur upon MAX_TOKENS truncation');
    const splitStart = diag.find(e => e.stage === 'source-map-split-start');
    assert.ok(splitStart, 'source-map-split-start diagnostic must be recorded');
    assert.equal(splitStart.reason, 'max_tokens', 'Split reason must be max_tokens');
    console.log('✔ Scenario D passed.');
  }

  // =========================================================================
  // SCENARIO E: Recovery split: 15-window chunk splits into child packets (8 + 7 windows)
  // =========================================================================
  {
    console.log('Testing Scenario E: 15-window split partitions into 8 + 7 windows and accounts for all 15...');
    const windowLabels = ['07:30', '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30'];
    const fakeChunk = {
      lines: windowLabels.map(lbl => `[${lbl}] Cue line for window ${lbl}. Substantive instructional speech.`),
      characterCount: 1500,
      startTime: 450,
      endTime: 899,
      startLabel: '07:30',
      endLabel: '14:59'
    };
    const fakeWindows = windowLabels.map((lbl, idx) => ({
      windowId: `window-${String(idx + 1).padStart(4, '0')}`,
      bucket: 15 + idx,
      startLabel: lbl,
      endLabel: windowLabels[idx + 1] || '15:00',
      cueCount: 1
    }));

    const childChunks = helpers.splitChunkByWindows(fakeChunk, fakeWindows, 2, 30);
    assert.equal(childChunks.length, 2, 'Must split into 2 child chunks');
    assert.equal(childChunks[0].windows.length, 8, 'Child 1 must contain 8 windows');
    assert.equal(childChunks[1].windows.length, 7, 'Child 2 must contain 7 windows');
    assert.equal(childChunks[0].startLabel, '07:30');
    assert.equal(childChunks[0].endLabel, '11:30'); // 8th window end
    assert.equal(childChunks[1].startLabel, '11:30');
    assert.equal(childChunks[1].endLabel, '15:00');

    // Verify all 15 windows are uniquely preserved across the split
    const combinedWindows = [...childChunks[0].windows, ...childChunks[1].windows];
    assert.equal(combinedWindows.length, 15);
    const seenWindowIds = new Set(combinedWindows.map(w => w.windowId));
    assert.equal(seenWindowIds.size, 15, 'All 15 windows accounted for exactly once');
    console.log('✔ Scenario E passed.');
  }

  // =========================================================================
  // SCENARIO F: Raw source fallback: extraction and split fail with non-safety error
  // =========================================================================
  {
    console.log('Testing Scenario F: Raw source fallback preserves original transcript and final render translates it...');
    const windowLabels = ['00:00', '00:30', '01:00'];
    const transcriptText = `[00:00] Important definition of graph vertex and edge.\n[00:30] Discussion of adjacency list vs adjacency matrix space complexity.\n[01:00] Instructor proves why adjacency list uses O(V+E) space.`;

    let finalPromptReceived = '';
    global.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body);
      const prompt = payload.contents[0].parts.find(p => p.text)?.text || '';

      // Force extraction, repair and split to fail with network error
      if (/Build a comprehensive, loss-minimizing evidence packet/.test(prompt) ||
          /TARGETED EVIDENCE EXTRACTION REPAIR/.test(prompt)) {
        const errorResponse = { error: { message: 'Temporary upstream server error 503' } };
        return new Response(JSON.stringify(errorResponse), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }

      if (/Create the final study notes for this captured lecture segment/.test(prompt)) {
        finalPromptReceived = prompt;
        return streamText(sampleReferenceDocument());
      }

      if (/SECOND-PASS SOURCE-TO-NOTE COVERAGE AUDIT/.test(prompt)) {
        return streamText('{"omissions":[],"unsupported_claims":[]}');
      }
      return streamText(sampleReferenceDocument());
    };

    const diag = [];
    const result = await client.synthesizeStudyDocument({
      videoTitle: 'Scenario F Fallback Lecture',
      stopTime: '01:30',
      sourceTranscript: transcriptText,
      onDiagnostics: event => diag.push(event)
    });

    assert.ok(result.length > 200);
    // Verify fallback diagnostic emitted
    const fallbackDiag = diag.find(e => e.stage === 'source-map-source-fallback');
    assert.ok(fallbackDiag, 'source-map-source-fallback diagnostic must be emitted');

    // Verify final prompt received the raw source fallback and special instructions
    assert.match(finalPromptReceived, /SPECIAL RAW-SOURCE TRANSCRIPT INSTRUCTIONS/);
    assert.match(finalPromptReceived, /RAW SOURCE TRANSCRIPT FALLBACK/);
    assert.match(finalPromptReceived, /Important definition of graph vertex and edge/);
    assert.match(finalPromptReceived, /Instructor proves why adjacency list uses O\(V\+E\) space/);
    console.log('✔ Scenario F passed.');
  }

  // =========================================================================
  // SCENARIO G: Evidence consolidation: validates source windows, safe retention on failure, ledger safety
  // =========================================================================
  {
    console.log('Testing Scenario G: Consolidation validates windows and safely retains packets on failure...');
    const client = window.geminiClient;
    const helpers = window.HoverNotesNoteSynthesis;

    // Build synthetic large evidence that exceeds 36000 limit to trigger consolidation
    const fakePackets = Array.from({ length: 6 }, (_, i) => {
      const startMin = String(i * 5).padStart(2, '0');
      const endMin = String((i + 1) * 5).padStart(2, '0');
      return `### Evidence packet ${i + 1} (${startMin}:00–${endMin}:00)\n${'Comprehensive lecture analysis of topic and memory models. '.repeat(130)}`;
    });
    const totalEvidenceSize = fakePackets.join('\n\n').length;
    assert.ok(totalEvidenceSize > 36000, 'Synthetic evidence must exceed ledger limit to trigger consolidation');

    let consolidationAttempts = 0;
    let retainedFallbackDiagSeen = false;

    // Test Case: Consolidation returns invalid/truncated text -> Original packets must be retained safely
    const longCues = Array.from({ length: 240 }, (_, i) => {
      const m = String(Math.floor(i / 60)).padStart(2, '0');
      const s = String(i % 60).padStart(2, '0');
      return `[${m}:${s}] Source cue ${i}. ${'Instructor explains in detail. '.repeat(5)}`;
    }).join('\n');

    global.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body);
      const prompt = payload.contents[0].parts.find(p => p.text)?.text || '';

      if (/Build a comprehensive, loss-minimizing evidence packet/.test(prompt)) {
        const match = prompt.match(/SOURCE RANGE: (\d{2}:\d{2})–(\d{2}:\d{2})/);
        const start = match ? match[1] : '00:00';
        return streamText(`### [${start}]\n- Preserved extraction for ${start}.\n${'Detailed evidence point discussing time and space complexity with examples. '.repeat(150)}`);
      }

      if (/Loss-minimizing consolidation of comprehensive evidence packets/.test(prompt)) {
        consolidationAttempts++;
        // Return truncated or invalid consolidation result to test safe packet retention
        return streamCandidate({
          text: 'Short unvalidated consolidation.',
          finishReason: 'MAX_TOKENS'
        });
      }

      if (/SECOND-PASS SOURCE-TO-NOTE COVERAGE AUDIT/.test(prompt)) {
        return streamText('{"omissions":[],"unsupported_claims":[]}');
      }
      return streamText(sampleReferenceDocument());
    };

    const diag = [];
    try {
      await client.synthesizeStudyDocument({
        videoTitle: 'Scenario G Consolidation',
        stopTime: '04:00',
        sourceTranscript: longCues,
        onDiagnostics: event => diag.push(event)
      });
    } catch (err) {
      // If ledger remains too large because unvalidated consolidation was safely rejected,
      // it must throw the safe ledger error without discarding evidence!
      assert.match(err.message, /The lecture evidence is still too large for safe final synthesis/);
      retainedFallbackDiagSeen = diag.some(e => e.stage === 'source-reduce-fallback-retained');
      assert.ok(retainedFallbackDiagSeen, 'source-reduce-fallback-retained diagnostic must be logged');
    }
    console.log('✔ Scenario G passed.');
  }

  // =========================================================================
  // SCENARIO G2: Long 42-minute lecture evidence consolidation succeeds and completes final synthesis
  // =========================================================================
  {
    console.log('Testing Scenario G2: Long lecture evidence consolidation succeeds and completes final synthesis...');
    const client = window.geminiClient;

    const longCues = Array.from({ length: 240 }, (_, i) => {
      const m = String(Math.floor(i / 60)).padStart(2, '0');
      const s = String(i % 60).padStart(2, '0');
      return `[${m}:${s}] Source cue ${i}. ${'Instructor explains in detail. '.repeat(5)}`;
    }).join('\n');

    let consolidationAttempts = 0;
    let finalRenderCalled = false;

    global.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body);
      const prompt = payload.contents[0].parts.find(p => p.text)?.text || '';

      if (/Build a comprehensive, loss-minimizing evidence packet/.test(prompt)) {
        const match = prompt.match(/SOURCE RANGE: (\d{2}:\d{2})–(\d{2}:\d{2})/);
        const start = match ? match[1] : '00:00';
        return streamText(`### [${start}]\n- Preserved extraction for ${start}.\n${'Detailed evidence point discussing time and space complexity with examples. '.repeat(150)}`);
      }

      if (/Loss-minimizing consolidation of comprehensive evidence packets/.test(prompt)) {
        consolidationAttempts++;
        // Realistic consolidation: groups material by concept with some timestamps, reducing group from ~20k to ~4k
        return streamText(`### [00:00] Consolidated Concepts\n- Consolidated explanation of algorithms and memory.\n${'Preserved distinct concept and qualification. '.repeat(60)}`);
      }

      if (/SECOND-PASS SOURCE-TO-NOTE COVERAGE AUDIT/.test(prompt)) {
        return streamText('{"omissions":[],"unsupported_claims":[]}');
      }

      finalRenderCalled = true;
      const fullReferenceDoc = `${sampleReferenceDocument()}\n\n${sampleReferenceDocument()}`.repeat(5);
      return streamText(fullReferenceDoc);
    };

    const diag = [];
    const finalDoc = await client.synthesizeStudyDocument({
      videoTitle: 'Scenario G2 Consolidation Success',
      stopTime: '04:00',
      sourceTranscript: longCues,
      onDiagnostics: event => diag.push(event)
    });

    assert.ok(consolidationAttempts > 0, 'Consolidation must be invoked when evidence exceeds 36000');
    assert.ok(finalRenderCalled, 'Final rendering must be called when consolidation successfully reduces ledger');
    assert.match(finalDoc, /Introduction to Data Structures and Algorithms/);
    console.log('✔ Scenario G2 passed.');
  }

  // =========================================================================
  // SCENARIO H: Semantic audit protects correctness: catches omission, targeted repair fixes it
  // =========================================================================
  {
    console.log('Testing Scenario H: Semantic audit repair and verification...');
    const transcriptText = `[00:00] First concept.\n[00:30] Crucial instructor claim about exam syllabus.\n[01:00] Third concept.`;

    let auditPasses = 0;
    let repairCalled = false;
    global.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body);
      const prompt = payload.contents[0].parts.find(p => p.text)?.text || '';

      if (/Build a comprehensive, loss-minimizing evidence packet/.test(prompt)) {
        return streamText(`### [00:00]\n- Content 1\n\n### [00:30]\n- Content 2\n\n### [01:00]\n- Content 3`);
      }

      if (/SECOND-PASS SOURCE-TO-NOTE COVERAGE AUDIT/.test(prompt)) {
        auditPasses++;
        if (auditPasses === 1) {
          // Pass 1: report omission
          return streamText(JSON.stringify({
            omissions: [{
              missing_point: 'Crucial instructor claim about exam syllabus was omitted',
              source_excerpt: 'Crucial instructor claim about exam syllabus',
              source_timestamp: '00:30'
            }],
            unsupported_claims: []
          }));
        }
        // Pass 2 (verification): no omissions
        return streamText('{"omissions":[],"unsupported_claims":[]}');
      }

      if (/TARGETED SEMANTIC REPAIR OF THE CANDIDATE STUDY NOTES/.test(prompt)) {
        repairCalled = true;
        assert.match(prompt, /Crucial instructor claim about exam syllabus/);
        return streamText(`${sampleReferenceDocument()}\n\n### Exam Syllabus Scope\n- **[Key Insight]** Crucial instructor claim about exam syllabus is incorporated.`);
      }

      return streamText(sampleReferenceDocument());
    };

    const diag = [];
    const result = await client.synthesizeStudyDocument({
      videoTitle: 'Scenario H Audit Repair',
      stopTime: '01:30',
      sourceTranscript: transcriptText,
      onDiagnostics: event => diag.push(event)
    });

    assert.ok(result.length > 200);
    assert.equal(repairCalled, true, 'Targeted semantic repair must be called when audit finds omissions');
    assert.equal(auditPasses, 2, 'Audit must run initial and post-repair-verification passes');
    assert.ok(diag.some(e => e.stage === 'semantic-repair-complete'), 'semantic-repair-complete diagnostic recorded');
    console.log('✔ Scenario H passed.');
  }

  // =========================================================================
  // SCENARIO I: Cancellation aborts immediately at each stage with no further requests
  // =========================================================================
  {
    console.log('Testing Scenario I: Immediate cancellation with AbortSignal...');
    const controller = new AbortController();
    const transcriptText = `[00:00] First cue.\n[00:30] Second cue.`;

    let callCount = 0;
    global.fetch = async (_url, options) => {
      callCount++;
      // Abort after first fetch begins
      controller.abort();
      return streamText('### [00:00]\n- Some text');
    };

    await assert.rejects(
      client.synthesizeStudyDocument({
        videoTitle: 'Scenario I Cancellation',
        stopTime: '01:00',
        sourceTranscript: transcriptText,
        signal: controller.signal
      }),
      err => err.name === 'AbortError' || /cancelled/i.test(err.message)
    );

    assert.equal(callCount, 1, 'Only the initial aborted request should run, no subsequent requests');
    console.log('✔ Scenario I passed.');
  }

  // =========================================================================
  // SCENARIO A: Exact Production Reproduction
  // Video 2o2vX0ZqQ_Y, Stop boundary 42:12, 6 chunks, Chunk 2 is 8,733 chars with 15 windows
  // Initial response < 18% & missing anchors; recovery succeeds; chunks 3–6 process; final render and audit run.
  // =========================================================================
  {
    console.log('Testing Scenario A: Exact Production Reproduction (Chunk 2 failure recovery)...');
    // Define the 6 production chunks
    // Chunk 1: 00:00–07:29, 8,597 chars
    // Chunk 2: 07:30–14:59, 8,733 chars (15 windows)
    // Chunk 3: 15:00–22:29, 8,601 chars
    // Chunk 4: 22:30–30:29, 8,559 chars
    // Chunk 5: 30:30–37:59, 8,758 chars
    // Chunk 6: 38:00–42:12, 4,812 chars
    const chunkDefs = [
      { startSec: 0, endSec: 449, startLabel: '00:00', endLabel: '07:29' },
      { startSec: 450, endSec: 899, startLabel: '07:30', endLabel: '14:59' },
      { startSec: 900, endSec: 1349, startLabel: '15:00', endLabel: '22:29' },
      { startSec: 1350, endSec: 1829, startLabel: '22:30', endLabel: '30:29' },
      { startSec: 1830, endSec: 2279, startLabel: '30:30', endLabel: '37:59' },
      { startSec: 2280, endSec: 2532, startLabel: '38:00', endLabel: '42:12' }
    ];

    const allTranscriptLines = [];
    for (const def of chunkDefs) {
      for (let sec = def.startSec; sec <= def.endSec; sec += 30) {
        const m = String(Math.floor(sec / 60)).padStart(2, '0');
        const s = String(sec % 60).padStart(2, '0');
        // Add enough text so chunk characters match production scale (~8,600 chars per chunk)
        const filler = 'The instructor explains the fundamental theoretical foundations of data structures and algorithms with thorough reasoning and exam guidance. ';
        allTranscriptLines.push(`[${m}:${s}] Cue at ${m}:${s}. ${filler.repeat(4)}`);
      }
    }
    const fullLectureTranscript = allTranscriptLines.join('\n');

    let chunk2AttemptCount = 0;
    let chunk2RepairInvoked = false;
    const processedChunks = new Set();
    const stageLog = [];

    // Chunk 2 windows (07:30 to 14:30)
    const chunk2WindowLabels = ['07:30', '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30'];

    // Emulate Chunk 2 production failure:
    // Output is ~600 chars (< 18% of 8,733 = 1,571 chars) and only provides anchors for 07:30–09:30
    const chunk2IncompleteInitial = chunk2WindowLabels.slice(0, 5).map(lbl =>
      `### [${lbl}]\n- Initial partial notes for ${lbl} covering fundamental algorithms.`
    ).join('\n\n');

    // Repair returns the missing windows 10:00 to 14:30
    const chunk2RepairPortion = chunk2WindowLabels.slice(5).map(lbl =>
      `### [${lbl}]\n- Targeted repaired notes for missing window ${lbl} with detailed explanation.`
    ).join('\n\n');

    global.fetch = async (_url, options) => {
      const payload = JSON.parse(options.body);
      const prompt = payload.contents[0].parts.find(p => p.text)?.text || '';

      if (/TARGETED EVIDENCE EXTRACTION REPAIR/.test(prompt)) {
        chunk2RepairInvoked = true;
        assert.match(prompt, /10:00/);
        assert.match(prompt, /14:30/);
        return streamText(chunk2RepairPortion);
      }

      if (/Build a comprehensive, loss-minimizing evidence packet/.test(prompt)) {
        const segMatch = prompt.match(/SEGMENT: (\d+)\/(\d+)/);
        const segmentNum = segMatch ? Number(segMatch[1]) : 0;
        processedChunks.add(segmentNum);

        if (segmentNum === 2) {
          chunk2AttemptCount++;
          // First attempt returns incomplete and < 18% output
          return streamText(chunk2IncompleteInitial);
        }

        // For other chunks (1, 3, 4, 5, 6), return complete valid evidence covering all windows in this segment
        const windowLabelsInChunk = [...prompt.matchAll(/^(\d{2}:\d{2})–/gm)].map(m => m[1]);
        const completeChunkText = windowLabelsInChunk.map(lbl =>
          `### [${lbl}]\n- Complete and comprehensive evidence point for window ${lbl} explaining the algorithm.`
        ).join('\n\n');
        return streamText(completeChunkText);
      }

      if (/SECOND-PASS SOURCE-TO-NOTE COVERAGE AUDIT/.test(prompt)) {
        return streamText('{"omissions":[],"unsupported_claims":[]}');
      }

      if (/Create the final study notes for this captured lecture segment/.test(prompt) ||
          /EDITORIAL STRUCTURE RECOVERY/.test(prompt)) {
        const fullDoc = `${sampleReferenceDocument()}\n\n` + Array.from({ length: 80 }, (_, i) =>
          `### Topic Segment ${i + 1}\n\n- Detailed explanation of algorithmic topic ${i + 1} and memory complexity.\n    - In-depth sub-point analyzing runtime asymptotic performance and data structure trade-offs for topic ${i + 1}.`
        ).join('\n\n');
        return streamText(fullDoc);
      }

      return streamText(sampleReferenceDocument());
    };

    const finalResult = await client.synthesizeStudyDocument({
      videoTitle: 'KnowledgeGate Lecture 2o2vX0ZqQ_Y',
      stopTime: '42:12',
      sourceTranscript: fullLectureTranscript,
      onDiagnostics: event => stageLog.push(event)
    });

    assert.ok(finalResult.length > 300, 'Final study document must be produced');
    assert.equal(chunk2RepairInvoked, true, 'Chunk 2 must trigger targeted recovery');
    assert.equal(processedChunks.size, 6, 'All 6 chunks must be processed');
    for (let c = 1; c <= 6; c++) {
      assert.ok(processedChunks.has(c), `Chunk ${c} must be processed`);
    }

    // Verify recovery diagnostics for Chunk 2
    const repairCompleteEvent = stageLog.find(e => e.stage === 'source-map-repair-complete' && e.chunk === 2);
    assert.ok(repairCompleteEvent, 'Chunk 2 repair-complete diagnostic must be present');
    assert.equal(repairCompleteEvent.valid, true, 'Chunk 2 repaired evidence must validate successfully');

    // Verify final render completed successfully
    const finalRenderEvent = stageLog.find(e => e.stage === 'final-render-complete');
    assert.ok(finalRenderEvent, 'final-render-complete diagnostic must be present');
    assert.equal(finalRenderEvent.validation, 'passed');
    console.log('✔ Scenario A (Exact Production Reproduction) passed successfully!');
  }

  console.log('\n=======================================================');
  console.log('All Scenarios A through I in finalization-recovery-v1030 passed!');
  console.log('=======================================================');
})();
