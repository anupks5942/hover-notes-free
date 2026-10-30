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
  const client = window.geminiClient;
  assert.match(client.systemPrompt, /primary record of what the instructor said/i);
  assert.doesNotMatch(client.systemPrompt, /1D\/2D Array address calculation|UB - LB \+ 1/);

  let requestUrl = '';
  let requestHeaders = null;
  let requestText = '';
  global.fetch = async (url, options) => {
    requestUrl = String(url);
    requestHeaders = options.headers;
    const payload = JSON.parse(options.body);
    requestText = payload.contents[0].parts.find(part => part.text)?.text || '';
    // Intentionally no trailing newline: verifies final SSE buffer handling.
    return sseResponse('data: {"candidates":[{"content":{"parts":[{"text":"## Grounded notes\\n- Only supplied evidence."}]}}]}');
  };

  const generated = await client.generateNotesStream({
    videoTitle: 'DSA lecture',
    currentTimestamp: '00:00–01:00',
    transcriptChunk: '[00:10] Instructor explains a stack.',
    existingNotes: '## Earlier section\n- Existing point',
    onChunk: () => {}
  });
  assert.match(generated, /Grounded notes/);
  assert.ok(requestHeaders['x-goog-api-key']);
  assert.ok(!requestUrl.includes('test-api-key'), 'API key must not appear in request URL');
  assert.match(requestText, /Instructor explains a stack/);
  assert.match(requestText, /Earlier section/);

  let onErrorCalled = false;
  global.fetch = async () => new Response(JSON.stringify({ error: { message: 'quota exhausted' } }), {
    status: 429,
    headers: { 'Content-Type': 'application/json' }
  });
  await assert.rejects(
    client.generateNotesStream({
      videoTitle: 'DSA lecture',
      currentTimestamp: '01:00–02:00',
      transcriptChunk: '[01:10] Test segment',
      onError: () => { onErrorCalled = true; }
    }),
    /quota exhausted/
  );
  assert.equal(onErrorCalled, true, 'final API errors must reach onError and reject');

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.generateNotesStream({
      videoTitle: 'DSA lecture',
      currentTimestamp: '02:00–03:00',
      transcriptChunk: 'test',
      signal: controller.signal
    }),
    error => error && error.name === 'AbortError'
  );

  console.log('Phase 1 smoke tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
