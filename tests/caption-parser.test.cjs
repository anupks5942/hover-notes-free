const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const parserSource = fs.readFileSync('content/caption-parser.js', 'utf8');

// Lightweight DOMParser mock for Node.js test environment
function createMockDOMParser() {
  return class MockDOMParser {
    parseFromString(str, mimeType) {
      const xml = String(str || '').trim();
      // Simple parsererror simulation if malformed xml
      if (xml.startsWith('<parsererror') || (xml.startsWith('<') && !xml.endsWith('>'))) {
        return {
          querySelector(sel) { return sel === 'parsererror' ? {} : null; },
          querySelectorAll() { return []; }
        };
      }

      function parseAttributes(attrStr) {
        const attrs = {};
        const regex = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        let match;
        while ((match = regex.exec(attrStr)) !== null) {
          attrs[match[1]] = match[2] !== undefined ? match[2] : match[3];
        }
        return attrs;
      }

      function createNode(tag, attrStr, content) {
        const attrs = parseAttributes(attrStr);
        return {
          tagName: tag,
          textContent: content.replace(/<[^>]+>/g, ''),
          getAttribute(name) { return attrs[name] !== undefined ? attrs[name] : null; },
          hasAttribute(name) { return attrs[name] !== undefined; },
          querySelectorAll(sel) {
            if (sel === 's') {
              const sNodes = [];
              const sRegex = /<s(?:\s+[^>]*)?>([\s\S]*?)<\/s>/gi;
              let sMatch;
              while ((sMatch = sRegex.exec(content)) !== null) {
                sNodes.push({ textContent: sMatch[1].replace(/<[^>]+>/g, '') });
              }
              return sNodes;
            }
            return [];
          }
        };
      }

      return {
        querySelector(sel) {
          if (sel === 'parsererror') return null;
          return null;
        },
        querySelectorAll(selector) {
          const results = [];
          if (selector === 'text') {
            const regex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
            let m;
            while ((m = regex.exec(xml)) !== null) {
              results.push(createNode('text', m[1], m[2]));
            }
          } else if (selector === 'p[t], p[start]') {
            const regex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
            let m;
            while ((m = regex.exec(xml)) !== null) {
              const node = createNode('p', m[1], m[2]);
              if (node.hasAttribute('t') || node.hasAttribute('start')) {
                results.push(node);
              }
            }
          }
          return results;
        }
      };
    }
  };
}

const context = {
  globalThis: {},
  console,
  DOMParser: createMockDOMParser()
};
vm.createContext(context);
vm.runInContext(parserSource, context, { filename: 'content/caption-parser.js' });
const parser = context.globalThis.HoverNotesCaptionParser;

// 1. Standard JSON3 with multiple events
{
  const json3 = {
    events: [
      { tStartMs: 0, dDurationMs: 2200, segs: [{ utf8: 'नमस्कार ' }, { utf8: 'दोस्तों' }] },
      { tStartMs: 2200, dDurationMs: 1800, segs: [{ utf8: 'Array &amp; Stack' }] },
      { tStartMs: 4000, dDurationMs: 500, segs: [{ utf16: 'legacy fallback' }] },
      { tStartMs: 4500, dDurationMs: 200, wWinId: 1 }
    ]
  };
  const cues = parser.parseJson3TimedText(json3);
  assert.equal(cues.length, 3);
  assert.equal(cues[0].start, 0);
  assert.equal(cues[0].duration, 2.2);
  assert.equal(cues[0].text, 'नमस्कार दोस्तों');
  assert.equal(cues[1].start, 2.2);
  assert.equal(cues[1].duration, 1.8);
  assert.equal(cues[1].text, 'Array & Stack');
  assert.equal(cues[2].start, 4.0);
  assert.equal(cues[2].duration, 0.5);
  assert.equal(cues[2].text, 'legacy fallback');
}

// 2. JSON3 with multiple segments per event
{
  const multiSeg = {
    events: [
      {
        tStartMs: 1000,
        dDurationMs: 3000,
        segs: [
          { utf8: 'Data ' },
          { utf8: 'Structures ' },
          { utf8: 'and ' },
          { utf8: 'Algorithms' }
        ]
      }
    ]
  };
  const cues = parser.parseJson3TimedText(multiSeg);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'Data Structures and Algorithms');
  assert.equal(cues[0].start, 1.0);
  assert.equal(cues[0].duration, 3.0);
}

// 3. Legacy XML timed text
{
  const legacyXml = `
    <transcript>
      <text start="1.5" dur="3.0">Hello &amp; welcome to the lecture</text>
      <text start="4.5" dur="2.5">Next slide on binary trees</text>
    </transcript>
  `;
  const cues = parser.parseXmlTimedText(legacyXml);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1.5);
  assert.equal(cues[0].duration, 3.0);
  assert.equal(cues[0].text, 'Hello & welcome to the lecture');
  assert.equal(cues[1].start, 4.5);
  assert.equal(cues[1].duration, 2.5);
  assert.equal(cues[1].text, 'Next slide on binary trees');
}

// 4. SRV3 XML timed text (both <s> segments and direct text)
{
  const srv3Xml = `
    <timedtext format="3">
      <head/>
      <body>
        <p t="1000" d="2000"><s>Welcome </s><s>everyone</s></p>
        <p t="3000" d="1500">Direct paragraph without s tags</p>
      </body>
    </timedtext>
  `;
  const cues = parser.parseXmlTimedText(srv3Xml);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1.0);
  assert.equal(cues[0].duration, 2.0);
  assert.equal(cues[0].text, 'Welcome everyone');
  assert.equal(cues[1].start, 3.0);
  assert.equal(cues[1].duration, 1.5);
  assert.equal(cues[1].text, 'Direct paragraph without s tags');
}

// 5. WebVTT format adapter
{
  const vtt = `WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:04.000
First WebVTT cue

2
00:00:04.500 --> 00:00:07.250
<c>Second</c> <b>styled</b> cue
`;
  const cues = parser.parseVttTimedText(vtt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1.0);
  assert.equal(cues[0].duration, 3.0);
  assert.equal(cues[0].text, 'First WebVTT cue');
  assert.equal(cues[1].start, 4.5);
  assert.equal(cues[1].duration, 2.75);
  assert.equal(cues[1].text, 'Second styled cue');
}

// 6. Valid JSON with unknown schema
{
  const unknownJson = JSON.stringify({
    responseContext: { serviceTrackingParams: [{ service: 'CSI' }] },
    actions: [
      { updateAction: { targetId: '123' } }
    ],
    unknownCollection: [
      { id: 'c1', info: 'some data' }
    ]
  });

  const res = parser.parseCaptionResponse(unknownJson, {
    format: 'default',
    contentType: 'application/json; charset=UTF-8',
    responseCharacters: unknownJson.length
  });

  assert.equal(res.cues.length, 0, 'unknown JSON schema should yield 0 cues');
  assert.equal(res.error, 'Unsupported YouTube caption JSON schema');
  assert.ok(res.diagnostics, 'safe diagnostics must be present for unsupported JSON');
  assert.equal(res.diagnostics.contentType, 'application/json; charset=UTF-8');
  assert.equal(res.diagnostics.topLevelType, 'object');
  assert.ok(res.diagnostics.topLevelKeys.includes('actions'));
  assert.ok(res.diagnostics.topLevelKeys.includes('unknownCollection'));
  assert.ok(!JSON.stringify(res.diagnostics).includes('some data'), 'diagnostics must never include data values');

  const formatted = parser.formatUnsupportedJsonDiagnostic(res.diagnostics, unknownJson.length);
  assert.ok(formatted.includes('Unsupported YouTube caption JSON schema'));
  assert.ok(formatted.includes('unknownCollection'));
}

// 7. Malformed JSON
{
  const malformed = '{"events": [ { tStartMs: 100, broken: ';
  const res = parser.parseCaptionResponse(malformed, {
    format: 'json3',
    contentType: 'application/json'
  });
  assert.equal(res.cues.length, 0);
  assert.equal(res.error, 'Malformed JSON caption response');
}

// 8. Empty response
{
  for (const empty of ['', '   ', null, undefined]) {
    const res = parser.parseCaptionResponse(empty, { format: 'json3' });
    assert.equal(res.cues.length, 0);
    assert.equal(res.error, 'Empty caption response body');
  }
}

// 9. Invalid or negative timestamps
{
  const invalidJson = {
    events: [
      { tStartMs: -1000, dDurationMs: 1000, segs: [{ utf8: 'negative start' }] },
      { tStartMs: 1000, dDurationMs: -500, segs: [{ utf8: 'negative duration' }] },
      { tStartMs: 'notANumber', dDurationMs: 500, segs: [{ utf8: 'NaN start' }] },
      { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'valid cue' }] }
    ]
  };
  const cues = parser.parseJson3TimedText(invalidJson);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'valid cue');
  assert.equal(cues[0].start, 2.0);
}

// 10. Out-of-order cues
{
  const outOfOrder = {
    events: [
      { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: 'Third' }] },
      { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'First' }] },
      { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: 'Second' }] }
    ]
  };
  const cues = parser.parseJson3TimedText(outOfOrder);
  assert.equal(cues.length, 3);
  assert.equal(cues[0].text, 'First');
  assert.equal(cues[0].start, 1.0);
  assert.equal(cues[1].text, 'Second');
  assert.equal(cues[1].start, 3.0);
  assert.equal(cues[2].text, 'Third');
  assert.equal(cues[2].start, 5.0);
}

// Format dispatcher behavior
{
  // fmt=json3 routes to JSON3
  const json3Payload = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'ok' }] }] });
  const res1 = parser.parseCaptionResponse(json3Payload, { format: 'json3' });
  assert.equal(res1.cues.length, 1);
  assert.equal(res1.formatRecognized, 'json3');

  // fmt=vtt routes to WebVTT
  const vttPayload = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello VTT';
  const res2 = parser.parseCaptionResponse(vttPayload, { format: 'vtt' });
  assert.equal(res2.cues.length, 1);
  assert.equal(res2.formatRecognized, 'vtt');

  // fmt=srv3 routes to XML
  const srv3Payload = '<timedtext format="3"><body><p t="500" d="1000"><s>SRV3 text</s></p></body></timedtext>';
  const res3 = parser.parseCaptionResponse(srv3Payload, { format: 'srv3' });
  assert.equal(res3.cues.length, 1);
  assert.equal(res3.formatRecognized, 'xml');

  // Arbitrary JSON is NEVER passed to XML parser
  const nonJson3Json = JSON.stringify({ testRoot: { someField: 123 } });
  const res4 = parser.parseCaptionResponse(nonJson3Json, { format: 'json3', contentType: 'application/json' });
  assert.equal(res4.cues.length, 0);
  assert.ok(!res4.adapterAttempted.includes('xml'), 'XML adapter must never be run on valid JSON');

  // Absent fmt with application/json: dispatches to JSON adapter, never forced into XML
  const json3PayloadNoFmt = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'no-fmt cue' }] }] });
  const resNoFmt = parser.parseCaptionResponse(json3PayloadNoFmt, { format: '', contentType: 'application/json; charset=UTF-8' });
  assert.equal(resNoFmt.cues.length, 1);
  assert.equal(resNoFmt.formatRecognized, 'json3');
  assert.equal(resNoFmt.detectionMethod, 'content-type');
  assert.ok(!resNoFmt.adapterAttempted.includes('xml'), 'Absent fmt with JSON Content-Type must not run XML adapter');
  assert.equal(resNoFmt.formatSupplied, '');

  // Absent fmt with unsupported JSON schema distinguishes absent fmt from explicit fmt
  const unknownNoFmt = JSON.stringify({ mysteryRoot: { list: [1, 2, 3] } });
  const resUnknownNoFmt = parser.parseCaptionResponse(unknownNoFmt, { format: '', contentType: 'application/json' });
  assert.equal(resUnknownNoFmt.cues.length, 0);
  assert.ok(!resUnknownNoFmt.adapterAttempted.includes('xml'));
  assert.equal(resUnknownNoFmt.diagnostics.fmtSupplied, false);
  const formattedNoFmt = parser.formatUnsupportedJsonDiagnostic(resUnknownNoFmt.diagnostics, unknownNoFmt.length);
  assert.ok(formattedNoFmt.includes('fmt=absent (unspecified)'), 'Must indicate fmt was absent');

  // Explicit fmt with unsupported JSON schema shows explicit fmt in diagnostics
  const resUnknownExplicit = parser.parseCaptionResponse(unknownNoFmt, { format: 'json3', contentType: 'application/json' });
  assert.equal(resUnknownExplicit.diagnostics.fmtSupplied, true);
  const formattedExplicit = parser.formatUnsupportedJsonDiagnostic(resUnknownExplicit.diagnostics, unknownNoFmt.length);
  assert.ok(formattedExplicit.includes('fmt=json3 (explicit)'), 'Must indicate fmt was explicitly supplied');
}

// ---------------------------------------------------------------------------
// Schema census regression test (Requirement 6)
// Uses a synthetic fixture; does not claim to reproduce the actual production response.
// ---------------------------------------------------------------------------
{
  const syntheticFixture = [
    // 0: control event without segs (matches the observed production event 0 shape)
    {
      tStartMs: 0,
      dDurationMs: 5000,
      id: 1,
      wpWinPosId: 1,
      wsWinStyleId: 1
    },
    // 1: event with segs, nested arrays and objects, string leaves, timestamp fields
    {
      tStartMs: 5000,
      dDurationMs: 2500,
      id: 2,
      segs: [
        { utf8: 'Synthetic secret caption text alpha', tOffsetMs: 100, acAsrConf: 98 },
        { utf8: 'Synthetic secret caption text beta' }
      ],
      customMeta: {
        region: {
          anchor: 'top-left'
        }
      }
    },
    // 2: alternative shape with textRuns
    {
      tStartMs: 7500,
      dDurationMs: 1200,
      textRuns: [
        { text: 'Synthetic secret alternative run', confidence: 0.95 }
      ],
      mode: 'overlay'
    }
  ];

  const census = parser.performEventSchemaCensus(syntheticFixture);

  // Assert calculations 1-7
  assert.equal(census.totalEvents, 3, 'Must report exact total events');
  assert.equal(census.eventsWithSegs, 1, 'Must count events containing segs');
  assert.equal(census.firstEventWithSegsIndex, 1, 'Must find index of first event with segs');
  assert.equal(census.firstEventWithStringIndex, 1, 'Must find index of first event with non-empty string');
  assert.equal(census.eventKeyFrequencies['tStartMs'], 3);
  assert.equal(census.eventKeyFrequencies['segs'], 1);
  assert.equal(census.eventKeyFrequencies['mode'], 1);
  assert.equal(census.segmentLikeFields['segs'].arrayCount, 1);
  assert.equal(census.segmentLikeFields['textRuns'].arrayCount, 1);
  assert.equal(Object.keys(census.keySignatures).length, 3, 'Must identify 3 distinct event shapes');

  // Assert calculation 8: Representative events
  assert.ok(census.representativeEvents.length >= 3, 'Must include representative events');
  const rep0 = census.representativeEvents.find(r => r.index === 0);
  assert.ok(rep0, 'Must include first event');
  assert.equal(rep0.reason, 'first-event');
  assert.equal(rep0.fieldTypes['tStartMs'], 'integer');
  assert.equal(rep0.fieldTypes['id'], 'integer');

  const rep1 = census.representativeEvents.find(r => r.index === 1);
  assert.ok(rep1, 'Must include event with segs');
  assert.ok(rep1.reason.includes('first-event-with-segs'));
  assert.ok(rep1.fieldTypes['segs'].includes('Array(2)'));
  assert.ok(rep1.fieldTypes['customMeta'].includes('object{region}'));

  // Assert calculation 9: Nested structural paths
  const paths = census.structuralPaths.map(p => p.path);
  assert.ok(paths.includes('events[].segs[].utf8'));
  assert.ok(paths.includes('events[].customMeta.region.anchor'));
  assert.ok(paths.includes('events[].textRuns[].text'));

  // Assert calculation 10: Numeric paths and value ranges without converting to seconds
  const tStartInfo = census.numericPaths.find(p => p.path === 'events[].tStartMs');
  assert.ok(tStartInfo);
  assert.equal(tStartInfo.min, 0);
  assert.equal(tStartInfo.max, 7500);
  assert.equal(tStartInfo.likelyTimestamp, true);

  const tOffsetInfo = census.numericPaths.find(p => p.path === 'events[].segs[].tOffsetMs');
  assert.ok(tOffsetInfo);
  assert.equal(tOffsetInfo.min, 100);
  assert.equal(tOffsetInfo.max, 100);

  // Assert calculation 11 & Privacy: Non-empty string leaf paths report ONLY lengths and counts, NEVER contents
  const utf8Info = census.stringLeafPaths.find(p => p.path === 'events[].segs[].utf8');
  assert.ok(utf8Info);
  assert.equal(utf8Info.count, 2);
  assert.equal(utf8Info.minLength, 'Synthetic secret caption text beta'.length);
  assert.equal(utf8Info.maxLength, 'Synthetic secret caption text alpha'.length);
  assert.equal(utf8Info.sampleLengths.length, 2);
  assert.equal(utf8Info.sampleLengths[0], 'Synthetic secret caption text alpha'.length);
  assert.equal(utf8Info.sampleLengths[1], 'Synthetic secret caption text beta'.length);

  // Privacy verification: Zero confidential transcript strings in serialized census
  const serializedCensus = JSON.stringify(census);
  assert.ok(!serializedCensus.includes('Synthetic secret caption text'), 'Census must NEVER include string contents');
  assert.ok(!serializedCensus.includes('Synthetic secret alternative run'), 'Census must NEVER include string contents');

  // Verify diagnostic formatting includes census and preserves privacy
  const mockDiagnostics = {
    contentType: 'application/json; charset=UTF-8',
    format: 'json3',
    fmtSupplied: true,
    topLevelType: 'object',
    topLevelKeys: ['wireMagic', 'pens', 'wsWinStyles', 'wpWinPositions', 'events'],
    likelyCollections: [{ name: 'events', count: 3 }],
    eventCount: 3,
    firstEventKeys: ['tStartMs', 'dDurationMs', 'id', 'wpWinPosId', 'wsWinStyleId'],
    firstSegmentKeys: [],
    attemptedAdapters: ['json3'],
    recognizedAdapters: [],
    validCueCount: 0,
    schemaCensus: census
  };
  const formatted = parser.formatUnsupportedJsonDiagnostic(mockDiagnostics, 1200);
  assert.ok(formatted.includes('[Schema Census] Total events: 3'));
  assert.ok(formatted.includes('Events with \'segs\': 1 (first at index: 1)'));
  assert.ok(formatted.includes('First string leaf at index: 1'));
  assert.ok(formatted.includes('Key frequencies:'));
  assert.ok(formatted.includes('events[].segs[].utf8(count=2'));
  assert.ok(formatted.includes('events[].tStartMs(count=3, range=[0..7500], timestamp)'));
  assert.ok(!formatted.includes('Synthetic secret caption text'), 'Formatted diagnostic must NEVER contain caption text');

  // Traversal node budget enforcement test
  const budgetLimited = parser.performEventSchemaCensus(syntheticFixture, { maxNodeBudget: 5 });
  assert.equal(budgetLimited.traversalBudget.budgetExceeded, true, 'Must report budgetExceeded when limit reached');
  assert.ok(budgetLimited.traversalBudget.nodesVisited <= 10, 'Node traversal must halt once budget exceeded');
  const formattedBudgetLimited = parser.formatUnsupportedJsonDiagnostic({
    ...mockDiagnostics,
    schemaCensus: budgetLimited
  }, 1200);
  assert.ok(formattedBudgetLimited.includes('[BUDGET EXCEEDED]'), 'Diagnostic string must report when traversal budget was exceeded');
}

console.log('YouTube caption parser and format dispatcher tests passed.');
