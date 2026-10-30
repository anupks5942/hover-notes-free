const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const stored = {
  gemini_keys: ['test-api-key-do-not-log'],
  active_key_index: 0,
  gemini_model: 'gemini-3.8-flash'
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

const source = fs.readFileSync('sidebar/gemini-client.js', 'utf8');
vm.runInThisContext(source, { filename: 'sidebar/gemini-client.js' });

function sseResponse(body, status = 200) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    }
  }), { status, headers: { 'Content-Type': 'text/event-stream' } });
}

(async () => {
  const sanitizedPrior = window.geminiClient.sanitizePreviousNotes(`# Note\n\n### [02:38](https://youtube.com/watch?v=x&t=158s)\n![[HoverNotes/images/screenshot-old.jpg]]\n\n### [03:00] New concept\nText.`);
  assert.doesNotMatch(sanitizedPrior, /screenshot-old|02:38/);
  assert.match(sanitizedPrior, /03:00.*New concept/);
  const sortedSections = window.geminiClient.sortTimestampedSections('### [02:38] Later slide\nLater material.\n\n### [01:39] Earlier DSA context\nEarlier material.');
  assert.ok(sortedSections.indexOf('[01:39]') < sortedSections.indexOf('[02:38]'),
    'timestamped major note sections must be persisted in chronological order');
  assert.match(window.geminiClient.systemPrompt, /strictly increasing lecture-time order/i);
  assert.match(window.geminiClient.systemPrompt, /Do not output screenshot headings/i);

  const events = [];
  let fetchCount = 0;
  let requestHeader = null;
  global.fetch = async (_url, options) => {
    fetchCount++;
    requestHeader = options.headers;
    if (fetchCount === 1) {
      return new Response(JSON.stringify({ error: { message: 'thinking config unsupported' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return sseResponse('data: {"candidates":[{"content":{"parts":[{"text":"## Timed notes\\n- Grounded evidence."}]}}]}');
  };

  const generated = await window.geminiClient.generateNotesStream({
    videoTitle: 'Performance test lecture',
    currentTimestamp: '00:00–01:00',
    transcriptChunk: '[00:10] Instructor explains a stack.',
    onChunk: () => {},
    onDiagnostics: event => events.push(event)
  });

  assert.match(generated, /Grounded evidence/);
  assert.equal(fetchCount, 2, '400 compatibility retry remains unchanged');
  assert.ok(requestHeader['x-goog-api-key']);
  assert.ok(events.some(event => event.type === 'config-ready'));
  assert.ok(events.some(event => event.type === 'attempt-start' && event.keySlot === 1));
  assert.ok(events.some(event => event.type === 'request-retry' && event.firstHttpStatus === 400));
  assert.ok(events.some(event => event.type === 'http-response' && event.httpStatus === 200));
  assert.ok(events.some(event => event.type === 'first-token' && Number.isFinite(event.firstTokenMs)));
  assert.ok(events.some(event => event.type === 'stream-complete' && event.generatedCharacters > 0));
  assert.ok(events.some(event => event.type === 'attempt-success' && event.generatedCharacters > 0));
  assert.ok(!JSON.stringify(events).includes('test-api-key-do-not-log'), 'diagnostics must never contain API keys');
  assert.ok(!JSON.stringify(events).includes('Instructor explains a stack'), 'diagnostics must never contain transcript text');

  console.log('Gemini performance diagnostics tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
