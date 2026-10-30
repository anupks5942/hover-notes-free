/**
 * HoverNotes Clone - Production Multi-Key Gemini AI Streamer
 * Uses a bounded first-token wait, model-aware generation configuration,
 * live SSE token streaming, and transcript-grounded academic lecture synthesis.
 */

class GeminiAIClient {
  constructor() {
    this.geminiKeys = ['', '', ''];
    this.activeKeyIndex = 0;
    this.primaryModel = 'gemini-3.8-flash';
    this.fallbackModel = 'gemini-3.5-flash-lite';
    this.activeModel = 'gemini-3.8-flash';
    this.customEndpointUrl = '';
    this.customApiKey = '';
    this.customModel = 'gpt-4o-mini';
    // Time allowed for a Gemini request to produce its first text token. The
    // timer stops at the first token; it does not cap a valid response stream.
    this.firstTokenTimeoutMs = 30000;
    this.sessionPreferredModel = null;

    // Evidence-first prompt: never prescribe subject-specific concepts or examples.
    // The transcript is the source of truth; the frame is supporting visual evidence.
    this.systemPrompt = `You are an accurate lecture-note assistant. Convert only the supplied lecture segment into clear, structured English Markdown notes.

NON-NEGOTIABLE GROUNDING RULES:
1. Treat the supplied transcript segment as the primary record of what the instructor said. Do not introduce a topic merely because it is common in this subject or appears in prior knowledge.
2. Use the attached frame only for information visibly supported by that frame. Never infer unseen slide content, hidden steps, or spoken explanations from a still image.
3. Do not invent examples, numerical values, equations, PYQs, definitions, claims, or instructor opinions. Preserve the instructor's actual values and method. If audio/transcript and frame appear inconsistent, say what is unclear rather than guessing.
4. Translate Hindi/Hinglish into precise technical English while preserving the instructor's meaning, caveats, emphasis, and examples. Omit greetings, promotions, and unrelated banter; retain meaningful analogies.
5. Cover the technical information in this segment without padding. Do not expand a brief mention into a full textbook explanation. Do not include a subject-specific formula unless it appears in the supplied evidence.
6. Preserve important notation and equations. Use LaTeX only when the expression is present or unambiguously derivable from the supplied evidence. Do not fabricate complexity bounds.
7. Clearly distinguish instructor material from uncertain extraction. Attribute the instructor's promises, guarantees, opinions, and personal claims explicitly (for example, ‘The instructor claims…’); do not present them as independently verified facts. Do not add practice questions or supplementary teaching unless explicitly requested.
8. Use the timestamp range in the user message. Add concise timestamp anchors to major concepts when the transcript provides them.
9. The previous-notes context is only to avoid repetition. Do not rewrite it. Add genuinely new information, or briefly clarify a previous point only when this segment explicitly develops it.
10. Organize new material in strictly increasing lecture-time order. Never place a later idea before an earlier idea just because it appears in the attached still frame.
11. Begin each major concept heading with its earliest supported transcript timestamp (for example, a heading like ### [01:39] Concept). Do not invent timestamps.
12. Do not output screenshot headings, Obsidian image embeds, image paths, or Markdown image links. The extension inserts selected images itself.
13. Do not repeat a definition or explanation already present in previous notes. When a concept is revisited, document only the genuinely new development.
14. Output only the new Markdown section(s). Do not reproduce YAML frontmatter or the document title. If the segment contains no new technical content, output: <!-- No new technical content in this segment. -->`;
  }

  // Load configuration from chrome.storage.local
  async initConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        ['gemini_keys', 'active_key_index', 'gemini_model', 'custom_endpoint_url', 'custom_api_key', 'custom_model'],
        (res) => {
          if (res.gemini_keys && Array.isArray(res.gemini_keys)) {
            this.geminiKeys = res.gemini_keys;
          }
          if (typeof res.active_key_index === 'number') {
            this.activeKeyIndex = res.active_key_index;
          }
          this.activeModel = res.gemini_model || this.primaryModel;
          if (res.custom_endpoint_url) {
            this.customEndpointUrl = res.custom_endpoint_url.trim();
          }
          if (res.custom_api_key) {
            this.customApiKey = res.custom_api_key.trim();
          }
          if (res.custom_model) {
            this.customModel = res.custom_model.trim();
          }
          resolve(true);
        }
      );
    });
  }

  // Save updated configuration
  async saveConfig(keys, activeIndex, customUrl, customKey, customModel, model) {
    this.geminiKeys = keys || this.geminiKeys;
    this.activeKeyIndex = typeof activeIndex === 'number' ? activeIndex : this.activeKeyIndex;
    this.activeModel = model || this.primaryModel;
    this.sessionPreferredModel = null;
    this.customEndpointUrl = customUrl !== undefined ? customUrl.trim() : this.customEndpointUrl;
    this.customApiKey = customKey !== undefined ? customKey.trim() : this.customApiKey;
    this.customModel = customModel || this.customModel;

    return new Promise((resolve) => {
      chrome.storage.local.set({
        gemini_keys: this.geminiKeys,
        active_key_index: this.activeKeyIndex,
        gemini_model: this.activeModel,
        custom_endpoint_url: this.customEndpointUrl,
        custom_api_key: this.customApiKey,
        custom_model: this.customModel
      }, () => resolve(true));
    });
  }

  // Retrieve valid non-empty Gemini keys
  getAvailableGeminiKeys() {
    return this.geminiKeys
      .map((k, idx) => ({ key: k ? k.trim() : '', index: idx }))
      .filter(item => item.key.length > 0);
  }

  // Rotate to next Gemini key on 429 or 403 quota exhaustion
  async rotateToNextKey() {
    const available = this.getAvailableGeminiKeys();
    if (available.length <= 1) return null;

    const currentPos = available.findIndex(k => k.index === this.activeKeyIndex);
    const nextPos = (currentPos + 1) % available.length;
    this.activeKeyIndex = available[nextPos].index;

    await chrome.storage.local.set({ active_key_index: this.activeKeyIndex });
    console.warn(`[HoverNotes AI] Rotated to Gemini Key #${this.activeKeyIndex + 1}`);
    return available[nextPos].key;
  }

  // Query Google ModelService.ListModels to verify key and list models
  async fetchAvailableModels(apiKey) {
    const key = apiKey || (this.geminiKeys[0] ? this.geminiKeys[0].trim() : '');
    if (!key) throw new Error('Please enter a Gemini API Key first.');

    const url = 'https://generativelanguage.googleapis.com/v1beta/models';
    const res = await fetch(url, { headers: { 'x-goog-api-key': key } });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      const msg = errorData.error?.message || `HTTP ${res.status}: ${res.statusText}`;
      throw new Error(`Authentication failed: ${msg}`);
    }

    const data = await res.json();
    const allModels = data.models || [];
    const generateModels = allModels
      .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''));

    return generateModels;
  }

  // Test connection for settings modal
  async testConnection(keyIndexToTest = null) {
    await this.initConfig();

    if (keyIndexToTest !== null) {
      const key = this.geminiKeys[keyIndexToTest]?.trim();
      if (!key) throw new Error(`Gemini Key #${keyIndexToTest + 1} is empty`);

      // 1. Verify key authenticity via ModelService
      const availableModels = await this.fetchAvailableModels(key);

      // Determine model: prefer primary gemini-3.8-flash, else fallback gemini-3.5-flash-lite, else first available
      let testModel = this.primaryModel;
      if (!availableModels.includes(testModel)) {
        testModel = availableModels.includes(this.fallbackModel) ? this.fallbackModel : availableModels[0];
      }

      this.activeModel = testModel;
      this.sessionPreferredModel = null;
      await chrome.storage.local.set({ gemini_model: testModel });

      // 2. Perform a model-compatible ping. The configured primary supports
      // thinkingConfig; the selected fallback model is sent without that option.
      const genUrl = `https://generativelanguage.googleapis.com/v1beta/models/${testModel}:generateContent`;
      const pingPayload = {
        contents: [{ parts: [{ text: 'Ping test. Respond with: OK' }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 10,
          ...(testModel === this.primaryModel ? { thinkingConfig: { thinkingBudget: 0 } } : {})
        }
      };
      let genRes = await fetch(genUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(pingPayload)
      });

      // Keep a compatibility retry only when the primary rejected thinkingConfig.
      if (genRes.status === 400 && pingPayload.generationConfig.thinkingConfig) {
        const retryPayload = { ...pingPayload };
        retryPayload.generationConfig = { temperature: 0.2, maxOutputTokens: 10 };
        genRes = await fetch(genUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(retryPayload)
        });
      }

      if (!genRes.ok) {
        const errData = await genRes.json().catch(() => ({}));
        const msg = errData.error?.message || `HTTP ${genRes.status}: ${genRes.statusText}`;
        throw new Error(msg);
      }

      return {
        success: true,
        models: availableModels,
        activeModel: testModel,
        message: `✓ Key #${keyIndexToTest + 1} verified & connected with ${testModel}!`
      };
    }

    if (this.customEndpointUrl) {
      let endpoint = this.customEndpointUrl.replace(/\/+$/, '');
      if (!endpoint.endsWith('/chat/completions')) endpoint += '/chat/completions';
      const headers = { 'Content-Type': 'application/json' };
      if (this.customApiKey) headers['Authorization'] = `Bearer ${this.customApiKey}`;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.customModel || 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Ping. Output "OK"' }],
          max_tokens: 10
        })
      });
      if (!res.ok) throw new Error(`Custom endpoint HTTP ${res.status}: ${res.statusText}`);
      return { success: true, message: 'Custom endpoint connected successfully!' };
    }

    const available = this.getAvailableGeminiKeys();
    if (available.length === 0) throw new Error('No API keys configured.');
    return this.testConnection(available[0].index);
  }

  // Remove extension-managed image blocks from previous-note context. The model
  // must not copy screenshot links; the extension owns screenshot insertion.
  sanitizePreviousNotes(markdown) {
    const lines = String(markdown || '').split(/\r?\n/);
    const output = [];
    for (let i = 0; i < lines.length; i++) {
      const isManagedImage = /^\s*!\[\[HoverNotes\/images\/[^\]]+\]\]\s*$/.test(lines[i]);
      if (isManagedImage) {
        const previous = output[output.length - 1] || '';
        if (/^\s*###\s+\[[^\]]+\]\(https?:\/\/[^)]+\)\s*$/.test(previous)) output.pop();
        continue;
      }
      if (/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(lines[i])) continue;
      output.push(lines[i]);
    }
    return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Sort major timestamped Markdown sections after generation. Streaming may
  // briefly show model order, but the persisted note is normalized chronologically.
  sortTimestampedSections(markdown) {
    const lines = String(markdown || '').split(/\r?\n/);
    const starts = [];
    const timestampPattern = /^\s*#{2,3}\s+.*?\[((?:\d{1,2}:)?\d{2}:\d{2})(?:\s*[–-]\s*(?:\d{1,2}:)?\d{2}:\d{2})?\]/;
    for (let index = 0; index < lines.length; index++) {
      const match = lines[index].match(timestampPattern);
      if (!match) continue;
      const parts = match[1].split(':').map(Number);
      const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
      starts.push({ index, seconds, originalIndex: starts.length });
    }
    if (starts.length < 2) return lines.join('\n').trim();
    const prefix = lines.slice(0, starts[0].index);
    const blocks = starts.map((start, i) => ({
      ...start,
      lines: lines.slice(start.index, i + 1 < starts.length ? starts[i + 1].index : lines.length)
    }));
    blocks.sort((a, b) => a.seconds - b.seconds || a.originalIndex - b.originalIndex);
    return [...prefix, ...blocks.flatMap(block => block.lines)].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Spec 4: Ultra-Fast SSE Stream Generator with Zero Thinking Delay & Multi-Key Failover
  async generateNotesStream({
    videoTitle,
    currentTimestamp,
    transcriptChunk,
    frameBase64,
    frameTimestamp = null,
    modeLabel = 'Lecture Notes',
    onChunk,
    onComplete,
    onError,
    onDiagnostics,
    existingNotes = '',
    signal
  }) {
    const configStartedAt = performance.now();
    await this.initConfig();
    const configLoadMs = Math.round(performance.now() - configStartedAt);
    this.emitDiagnostics(onDiagnostics, {
      type: 'config-ready',
      configLoadMs,
      configuredGeminiKeySlots: this.getAvailableGeminiKeys().map(item => item.index + 1),
      primaryModel: this.primaryModel,
      fallbackModel: this.fallbackModel,
      activeModel: this.sessionPreferredModel || this.activeModel || this.primaryModel,
      sessionFallbackActive: Boolean(this.sessionPreferredModel),
      firstTokenTimeoutMs: this.firstTokenTimeoutMs,
      customEndpointConfigured: Boolean(this.customEndpointUrl)
    });

    const available = this.getAvailableGeminiKeys();
    if (available.length === 0 && !this.customEndpointUrl) {
      const err = new Error('No Gemini API key configured. Open Settings (⚙️) to add your API keys.');
      if (onError) onError(err);
      throw err;
    }

    if (signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError');

    const priorContext = this.sanitizePreviousNotes(existingNotes).slice(-12000);
    const userPrompt = `Video title: ${videoTitle}
Lecture timestamp range: ${currentTimestamp}
Generation mode: ${modeLabel}
Visual evidence timestamp: ${frameBase64 && frameTimestamp ? frameTimestamp : '[No visual frame attached]'}

TRANSCRIPT EVIDENCE (primary source):
"""
${transcriptChunk || '[No transcript text was supplied. Do not invent spoken content. Describe only clearly visible information in the attached frame, and state that audio content is unavailable.]'}
"""

PREVIOUS NOTE CONTEXT (use only to avoid repeating material; do not copy it):
"""
${priorContext || '[No earlier notes in this run.]'}
"""

Create the new notes for this timestamp range only. Ground every factual statement in the transcript or visibly legible frame. Preserve the instructor's examples and numbers exactly. Never add generic GATE/DSA material to fill space. Do not label an AI-generated example as an instructor example. If there is insufficient evidence, write less rather than guess.

CHRONOLOGY AND ASSET RULES:
- Follow the transcript cue timestamps in strictly ascending order.
- Put each major topic under a heading beginning with its earliest supported timestamp.
- The attached frame was captured at ${frameBase64 && frameTimestamp ? frameTimestamp : 'an unspecified time'}; visual-only observations belong at that time, never earlier in the interval.
- Never output image Markdown, Obsidian wiki-links, screenshot headings, image filenames, or copied previous-note media. The extension inserts selected screenshots after generation.
- Do not restate definitions already covered in previous notes; add only new information from this interval.`;

    const preferredModel = this.sessionPreferredModel || this.activeModel || this.primaryModel;
    const modelsToTry = [preferredModel, this.primaryModel, this.fallbackModel]
      .filter((m, i, arr) => m && arr.indexOf(m) === i);

    let lastError = null;
    let attempts = 0;
    const maxKeyAttempts = Math.max(available.length, 1);
    let modelAttemptNumber = 0;

    while (attempts < maxKeyAttempts && available.length > 0) {
      const activeObj = available.find(k => k.index === this.activeKeyIndex) || available[0];
      const activeKey = activeObj.key;
      attempts++;

      for (const model of modelsToTry) {
        modelAttemptNumber++;
        const attemptStartedAt = performance.now();
        this.emitDiagnostics(onDiagnostics, {
          type: 'attempt-start',
          provider: 'gemini',
          model,
          keySlot: activeObj.index + 1,
          keyAttempt: attempts,
          modelAttempt: modelAttemptNumber,
          firstTokenTimeoutMs: this.firstTokenTimeoutMs
        });
        try {
          const generated = await this.streamGeminiSSE({
            apiKey: activeKey,
            model,
            promptText: userPrompt,
            frameBase64,
            onChunk,
            onComplete,
            signal,
            onDiagnostics
          });
          // Once a fallback proves healthy, keep using it for the rest of this
          // extension session instead of paying the first-token timeout on every
          // subsequent interval. Saving model settings or reloading resets this.
          this.sessionPreferredModel = model !== this.primaryModel ? model : null;
          this.emitDiagnostics(onDiagnostics, {
            type: 'attempt-success',
            provider: 'gemini',
            model,
            keySlot: activeObj.index + 1,
            keyAttempt: attempts,
            modelAttempt: modelAttemptNumber,
            durationMs: Math.round(performance.now() - attemptStartedAt),
            generatedCharacters: generated.length
          });
          return generated;
        } catch (err) {
          lastError = err;
          this.emitDiagnostics(onDiagnostics, {
            type: 'attempt-failed',
            provider: 'gemini',
            model,
            keySlot: activeObj.index + 1,
            keyAttempt: attempts,
            modelAttempt: modelAttemptNumber,
            durationMs: Math.round(performance.now() - attemptStartedAt),
            httpStatus: Number.isFinite(err.status) ? err.status : null,
            errorName: err.name || 'Error',
            timeoutMs: Number.isFinite(err.timeoutMs) ? err.timeoutMs : null,
            aborted: err.name === 'AbortError' || Boolean(signal?.aborted)
          });
          console.warn(`[HoverNotes AI] Model ${model} on Key #${activeObj.index + 1} error:`, err.message);

          // If rate limit (429) or quota exceeded (403), break model loop to rotate key
          if (err.name === 'AbortError' || signal?.aborted) throw err;
          if (err.status === 429 || err.status === 403 || err.status === 401 || err.message?.includes('RESOURCE_EXHAUSTED')) {
            break;
          }
          // If model deprecated or 404, try next model in fallback cascade
          if (err.status === 404 || err.message?.includes('not found') || err.message?.includes('no longer available')) {
            continue;
          }
        }
      }

      const nextKey = await this.rotateToNextKey();
      if (!nextKey) break;
    }

    // Fallback: Custom OpenAI-compatible endpoint
    if (this.customEndpointUrl) {
      const customStartedAt = performance.now();
      this.emitDiagnostics(onDiagnostics, {
        type: 'attempt-start',
        provider: 'openai-compatible',
        model: this.customModel || 'gpt-4o-mini',
        keySlot: this.customApiKey ? 'custom-key-configured' : 'no-key-configured',
        modelAttempt: modelAttemptNumber + 1
      });
      try {
        console.warn('[HoverNotes AI] Falling back to custom OpenAI-compatible endpoint...');
        const generated = await this.streamOpenAIExtension({
          promptText: userPrompt,
          frameBase64,
          onChunk,
          onComplete,
          signal,
          onDiagnostics
        });
        this.emitDiagnostics(onDiagnostics, {
          type: 'attempt-success',
          provider: 'openai-compatible',
          model: this.customModel || 'gpt-4o-mini',
          durationMs: Math.round(performance.now() - customStartedAt),
          generatedCharacters: generated.length
        });
        return generated;
      } catch (customErr) {
        lastError = customErr;
        this.emitDiagnostics(onDiagnostics, {
          type: 'attempt-failed',
          provider: 'openai-compatible',
          model: this.customModel || 'gpt-4o-mini',
          durationMs: Math.round(performance.now() - customStartedAt),
          httpStatus: Number.isFinite(customErr.status) ? customErr.status : null,
          errorName: customErr.name || 'Error',
          aborted: customErr.name === 'AbortError' || Boolean(signal?.aborted)
        });
      }
    }

    const finalError = lastError || new Error('All AI models and endpoints were unavailable.');
    if (onError) onError(finalError);
    throw finalError;
  }

  emitDiagnostics(callback, event) {
    if (typeof callback !== 'function') return;
    try {
      callback({
        ...event,
        at: new Date().toISOString()
      });
    } catch (err) {
      // Diagnostics must never interfere with note generation.
      console.warn('[HoverNotes AI] Diagnostics callback failed:', err?.message || err);
    }
  }

  // Internal SSE Stream Implementation
  async streamGeminiSSE({ apiKey, model, promptText, frameBase64, onChunk, onComplete, onDiagnostics, signal }) {
    const requestStartedAt = performance.now();
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;

    const parts = [{ text: promptText }];

    if (frameBase64) {
      const cleanBase64 = frameBase64.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
      parts.unshift({
        inlineData: {
          mimeType: 'image/jpeg',
          data: cleanBase64
        }
      });
    }

    const payload = {
      contents: [{ role: 'user', parts }],
      systemInstruction: {
        parts: [{ text: this.systemPrompt }]
      },
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 8192,
        ...(model === this.primaryModel ? { thinkingConfig: { thinkingBudget: 0 } } : {})
      }
    };

    // A request-local controller lets a slow first response fall through to the
    // fallback model without cancelling the complete AI Notes run.
    const requestController = new AbortController();
    let firstTokenTimedOut = false;
    const timeoutMs = Math.max(1000, Number(this.firstTokenTimeoutMs) || 30000);
    const relayParentAbort = () => requestController.abort();
    if (signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    signal?.addEventListener('abort', relayParentAbort, { once: true });
    const timeoutId = setTimeout(() => {
      firstTokenTimedOut = true;
      requestController.abort();
    }, timeoutMs);
    const clearFirstTokenTimeout = () => clearTimeout(timeoutId);
    const normalizeRequestError = (error) => {
      if (firstTokenTimedOut) {
        const timeoutError = new Error(`Gemini did not produce its first text token within ${timeoutMs} ms.`);
        timeoutError.name = 'FirstTokenTimeoutError';
        timeoutError.code = 'FIRST_TOKEN_TIMEOUT';
        timeoutError.timeoutMs = timeoutMs;
        return timeoutError;
      }
      if (signal?.aborted) return new DOMException('Generation cancelled.', 'AbortError');
      return error;
    };

    try {
    let response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload),
      signal: requestController.signal
    });
    let responseHeadersMs = Math.round(performance.now() - requestStartedAt);

    // If 400 due to thinkingConfig unsupported on a fallback model, retry once without thinkingConfig
    if (response.status === 400 && payload.generationConfig.thinkingConfig) {
      this.emitDiagnostics(onDiagnostics, {
        type: 'request-retry',
        provider: 'gemini',
        model,
        reason: 'thinking-config-unsupported',
        firstHttpStatus: 400,
        elapsedMs: Math.round(performance.now() - requestStartedAt)
      });
      const retryPayload = { ...payload };
      retryPayload.generationConfig = { temperature: 0.2, maxOutputTokens: 8192 };
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(retryPayload),
        signal: requestController.signal
      });
      responseHeadersMs = Math.round(performance.now() - requestStartedAt);
    }

    this.emitDiagnostics(onDiagnostics, {
      type: 'http-response',
      provider: 'gemini',
      model,
      httpStatus: response.status,
      responseHeadersMs
    });

    if (!response.ok) {
      clearFirstTokenTimeout();
      let errorMsg = `HTTP ${response.status}: ${response.statusText}`;
      try {
        const errJson = await response.json();
        if (errJson.error?.message) errorMsg = errJson.error.message;
      } catch (e) {}
      const err = new Error(errorMsg);
      err.status = response.status;
      throw err;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let accumulatedText = '';
    let firstTokenMs = null;

    while (true) {
      if (signal?.aborted) {
        try { await reader.cancel(); } catch (e) {}
        throw new DOMException('Generation cancelled.', 'AbortError');
      }
      let readResult;
      try {
        readResult = await reader.read();
      } catch (readError) {
        throw normalizeRequestError(readError);
      }
      const { value, done } = readResult;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep uncompleted remainder

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.substring(6).trim();
          if (jsonStr === '[DONE]') continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const deltaText = (parsed.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('');
            if (deltaText) {
              if (firstTokenMs === null) {
                clearFirstTokenTimeout();
                firstTokenMs = Math.round(performance.now() - requestStartedAt);
                this.emitDiagnostics(onDiagnostics, {
                  type: 'first-token',
                  provider: 'gemini',
                  model,
                  firstTokenMs
                });
              }
              accumulatedText += deltaText;
              if (onChunk) onChunk(deltaText, accumulatedText);
            }
          } catch (jsonErr) {}
        }
      }
    }

    if (buffer.trim().startsWith('data: ')) {
      const jsonStr = buffer.trim().slice(6).trim();
      if (jsonStr && jsonStr !== '[DONE]') {
        try {
          const parsed = JSON.parse(jsonStr);
          const tailText = (parsed.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('');
          if (tailText) {
            if (firstTokenMs === null) {
              clearFirstTokenTimeout();
              firstTokenMs = Math.round(performance.now() - requestStartedAt);
              this.emitDiagnostics(onDiagnostics, {
                type: 'first-token',
                provider: 'gemini',
                model,
                firstTokenMs
              });
            }
            accumulatedText += tailText;
            if (onChunk) onChunk(tailText, accumulatedText);
          }
        } catch (e) { console.warn('[HoverNotes AI] Ignored incomplete final SSE event.'); }
      }
    }
    clearFirstTokenTimeout();
    this.emitDiagnostics(onDiagnostics, {
      type: 'stream-complete',
      provider: 'gemini',
      model,
      httpStatus: response.status,
      responseHeadersMs,
      firstTokenMs,
      totalRequestMs: Math.round(performance.now() - requestStartedAt),
      generatedCharacters: accumulatedText.length
    });
    if (onComplete) onComplete(accumulatedText);
    return accumulatedText;
    } catch (error) {
      const normalized = normalizeRequestError(error);
      if (normalized.name === 'FirstTokenTimeoutError') {
        this.emitDiagnostics(onDiagnostics, {
          type: 'first-token-timeout', provider: 'gemini', model, timeoutMs,
          elapsedMs: Math.round(performance.now() - requestStartedAt)
        });
      }
      throw normalized;
    } finally {
      clearFirstTokenTimeout();
      signal?.removeEventListener('abort', relayParentAbort);
    }
  }

  // Internal Custom OpenAI-compatible Fallback Stream
  async streamOpenAIExtension({ promptText, frameBase64, onChunk, onComplete, onDiagnostics, signal }) {
    const requestStartedAt = performance.now();
    let endpoint = this.customEndpointUrl.replace(/\/+$/, '');
    if (!endpoint.endsWith('/chat/completions')) endpoint += '/chat/completions';

    const userContent = [{ type: 'text', text: promptText }];
    if (frameBase64) {
      const dataUri = frameBase64.startsWith('data:') ? frameBase64 : `data:image/jpeg;base64,${frameBase64}`;
      userContent.push({ type: 'image_url', image_url: { url: dataUri } });
    }

    const payload = {
      model: this.customModel || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: userContent }
      ],
      stream: true,
      max_tokens: 4096,
      temperature: 0.2
    };

    const headers = { 'Content-Type': 'application/json' };
    if (this.customApiKey) headers['Authorization'] = `Bearer ${this.customApiKey}`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal
    });

    const responseHeadersMs = Math.round(performance.now() - requestStartedAt);
    this.emitDiagnostics(onDiagnostics, {
      type: 'http-response',
      provider: 'openai-compatible',
      model: this.customModel || 'gpt-4o-mini',
      httpStatus: response.status,
      responseHeadersMs
    });

    if (!response.ok) {
      const err = new Error(`Custom endpoint HTTP ${response.status}: ${response.statusText}`);
      err.status = response.status;
      throw err;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let accumulatedText = '';
    let firstTokenMs = null;

    while (true) {
      if (signal?.aborted) {
        try { await reader.cancel(); } catch (e) {}
        throw new DOMException('Generation cancelled.', 'AbortError');
      }
      let readResult;
      try {
        readResult = await reader.read();
      } catch (readError) {
        throw normalizeRequestError(readError);
      }
      const { value, done } = readResult;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.substring(6).trim();
          if (jsonStr === '[DONE]') continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.choices?.[0]?.delta?.content || '';
            const deltaText = typeof delta === 'string' ? delta : (Array.isArray(delta) ? delta.map(part => part.text || '').join('') : '');
            if (deltaText) {
              if (firstTokenMs === null) {
                clearFirstTokenTimeout();
                firstTokenMs = Math.round(performance.now() - requestStartedAt);
                this.emitDiagnostics(onDiagnostics, {
                  type: 'first-token',
                  provider: 'openai-compatible',
                  model: this.customModel || 'gpt-4o-mini',
                  firstTokenMs
                });
              }
              accumulatedText += deltaText;
              if (onChunk) onChunk(deltaText, accumulatedText);
            }
          } catch (e) {}
        }
      }
    }

    if (buffer.trim().startsWith('data: ')) {
      const jsonStr = buffer.trim().slice(6).trim();
      if (jsonStr && jsonStr !== '[DONE]') {
        try {
          const parsed = JSON.parse(jsonStr);
          const delta = parsed.choices?.[0]?.delta?.content || '';
          const tailText = typeof delta === 'string' ? delta : (Array.isArray(delta) ? delta.map(part => part.text || '').join('') : '');
          if (tailText) {
            if (firstTokenMs === null) {
              clearFirstTokenTimeout();
              firstTokenMs = Math.round(performance.now() - requestStartedAt);
              this.emitDiagnostics(onDiagnostics, {
                type: 'first-token',
                provider: 'openai-compatible',
                model: this.customModel || 'gpt-4o-mini',
                firstTokenMs
              });
            }
            accumulatedText += tailText;
            if (onChunk) onChunk(tailText, accumulatedText);
          }
        } catch (e) { console.warn('[HoverNotes AI] Ignored incomplete final SSE event.'); }
      }
    }
    this.emitDiagnostics(onDiagnostics, {
      type: 'stream-complete',
      provider: 'openai-compatible',
      model: this.customModel || 'gpt-4o-mini',
      httpStatus: response.status,
      responseHeadersMs,
      firstTokenMs,
      totalRequestMs: Math.round(performance.now() - requestStartedAt),
      generatedCharacters: accumulatedText.length
    });
    if (onComplete) onComplete(accumulatedText);
    return accumulatedText;
  }
}

// Global instance for sidebar
window.geminiClient = new GeminiAIClient();
