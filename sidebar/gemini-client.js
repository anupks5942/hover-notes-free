/**
 * HoverNotes Clone - Production Multi-Key Gemini AI Streamer
 * Locks to gemini-3.8-flash (fallback gemini-3.5-flash-lite) with zero thinking budget,
 * live SSE token streaming, and GATE-grade academic lecture synthesis.
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
7. Clearly distinguish instructor material from uncertain extraction. Do not add practice questions or supplementary teaching unless explicitly requested.
8. Use the timestamp range in the user message. Add concise timestamp anchors to major concepts when the transcript provides them.
9. The previous-notes context is only to avoid repetition. Do not rewrite it. Add genuinely new information, or briefly clarify a previous point only when this segment explicitly develops it.
10. Output only the new Markdown section(s). Do not reproduce YAML frontmatter or the document title. If the segment contains no new technical content, output: <!-- No new technical content in this segment. -->`;
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
      await chrome.storage.local.set({ gemini_model: testModel });

      // 2. Perform ping generation with zero thinking delay
      const genUrl = `https://generativelanguage.googleapis.com/v1beta/models/${testModel}:generateContent`;
      let genRes = await fetch(genUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Ping test. Respond with: OK' }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 10,
            thinkingConfig: { thinkingBudget: 0 }
          }
        })
      });

      // If 400 on thinkingConfig, retry without it
      if (genRes.status === 400) {
        genRes = await fetch(genUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'Ping test. Respond with: OK' }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 10 }
          })
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

  // Spec 4: Ultra-Fast SSE Stream Generator with Zero Thinking Delay & Multi-Key Failover
  async generateNotesStream({
    videoTitle,
    currentTimestamp,
    transcriptChunk,
    frameBase64,
    modeLabel = 'Lecture Notes',
    onChunk,
    onComplete,
    onError,
    existingNotes = '',
    signal
  }) {
    await this.initConfig();

    const available = this.getAvailableGeminiKeys();
    if (available.length === 0 && !this.customEndpointUrl) {
      const err = new Error('No Gemini API key configured. Open Settings (⚙️) to add your API keys.');
      if (onError) onError(err);
      throw err;
    }

    if (signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError');

    const priorContext = String(existingNotes || '').slice(-12000);
    const userPrompt = `Video title: ${videoTitle}
Lecture timestamp range: ${currentTimestamp}
Generation mode: ${modeLabel}

TRANSCRIPT EVIDENCE (primary source):
"""
${transcriptChunk || '[No transcript text was supplied. Do not invent spoken content. Describe only clearly visible information in the attached frame, and state that audio content is unavailable.]'}
"""

PREVIOUS NOTE CONTEXT (use only to avoid repeating material; do not copy it):
"""
${priorContext || '[No earlier notes in this run.]'}
"""

Create the new notes for this timestamp range only. Ground every factual statement in the transcript or visibly legible frame. Preserve the instructor's examples and numbers exactly. Never add generic GATE/DSA material to fill space. Do not label an AI-generated example as an instructor example. If there is insufficient evidence, write less rather than guess.`;

    const modelsToTry = [this.activeModel || this.primaryModel, this.primaryModel, this.fallbackModel]
      .filter((m, i, arr) => m && arr.indexOf(m) === i);

    let lastError = null;
    let attempts = 0;
    const maxKeyAttempts = Math.max(available.length, 1);

    while (attempts < maxKeyAttempts && available.length > 0) {
      const activeObj = available.find(k => k.index === this.activeKeyIndex) || available[0];
      const activeKey = activeObj.key;
      attempts++;

      for (const model of modelsToTry) {
        try {
          return await this.streamGeminiSSE({
            apiKey: activeKey,
            model,
            promptText: userPrompt,
            frameBase64,
            onChunk,
            onComplete,
            signal
          });
        } catch (err) {
          lastError = err;
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
      try {
        console.warn('[HoverNotes AI] Falling back to custom OpenAI-compatible endpoint...');
        return await this.streamOpenAIExtension({
          promptText: userPrompt,
          frameBase64,
          onChunk,
          onComplete,
          signal
        });
      } catch (customErr) {
        lastError = customErr;
      }
    }

    const finalError = lastError || new Error('All AI models and endpoints were unavailable.');
    if (onError) onError(finalError);
    throw finalError;
  }

  // Internal SSE Stream Implementation
  async streamGeminiSSE({ apiKey, model, promptText, frameBase64, onChunk, onComplete, signal }) {
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
        thinkingConfig: {
          thinkingBudget: 0
        }
      }
    };

    let response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload),
      signal
    });

    // If 400 due to thinkingConfig unsupported on a fallback model, retry once without thinkingConfig
    if (response.status === 400) {
      const retryPayload = { ...payload };
      retryPayload.generationConfig = { temperature: 0.2, maxOutputTokens: 8192 };
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(retryPayload),
        signal
      });
    }

    if (!response.ok) {
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

    while (true) {
      if (signal?.aborted) {
        try { await reader.cancel(); } catch (e) {}
        throw new DOMException('Generation cancelled.', 'AbortError');
      }
      const { value, done } = await reader.read();
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
            accumulatedText += tailText;
            if (onChunk) onChunk(tailText, accumulatedText);
          }
        } catch (e) { console.warn('[HoverNotes AI] Ignored incomplete final SSE event.'); }
      }
    }
    if (onComplete) onComplete(accumulatedText);
    return accumulatedText;
  }

  // Internal Custom OpenAI-compatible Fallback Stream
  async streamOpenAIExtension({ promptText, frameBase64, onChunk, onComplete, signal }) {
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

    if (!response.ok) {
      const err = new Error(`Custom endpoint HTTP ${response.status}: ${response.statusText}`);
      err.status = response.status;
      throw err;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let accumulatedText = '';

    while (true) {
      if (signal?.aborted) {
        try { await reader.cancel(); } catch (e) {}
        throw new DOMException('Generation cancelled.', 'AbortError');
      }
      const { value, done } = await reader.read();
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
            accumulatedText += tailText;
            if (onChunk) onChunk(tailText, accumulatedText);
          }
        } catch (e) { console.warn('[HoverNotes AI] Ignored incomplete final SSE event.'); }
      }
    }
    if (onComplete) onComplete(accumulatedText);
    return accumulatedText;
  }
}

// Global instance for sidebar
window.geminiClient = new GeminiAIClient();
