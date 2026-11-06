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
5. Cover all substantive instructional content in this segment without padding. Instructional content includes technical facts and procedures, but also conceptual framing, why a subject or idea matters, learning objectives, the instructor's reasoning, distinctions between memorization and understanding, examples, analogies, and explanations of how ideas fit together. Do not require a formula, definition, or operation for a passage to count as educational content. Do not expand a brief mention into a full textbook explanation. Do not include a subject-specific formula unless it appears in the supplied evidence.
6. Preserve important notation and equations. Use LaTeX only when the expression is present or unambiguously derivable from the supplied evidence. Do not fabricate complexity bounds.
7. Clearly distinguish instructor material from uncertain extraction. Attribute the instructor's promises, guarantees, opinions, and personal claims explicitly (for example, ‘The instructor claims…’); do not present them as independently verified facts. Do not add practice questions or supplementary teaching unless explicitly requested.
8. Use the timestamp range in the user message. Add concise timestamp anchors to major concepts when the transcript provides them.
9. The previous-notes context is only to avoid repetition. Do not rewrite it. Add genuinely new information, or briefly clarify a previous point only when this segment explicitly develops it.
10. Organize new material in strictly increasing lecture-time order. Never place a later idea before an earlier idea just because it appears in the attached still frame.
11. Begin each major concept heading with its earliest supported transcript timestamp (for example, a heading like ### [01:39] Concept). Do not invent timestamps.
12. Do not output screenshot headings, Obsidian image embeds, image paths, or Markdown image links. The extension inserts selected images itself.
13. Do not repeat a definition or explanation already present in previous notes. When a concept is revisited, document only the genuinely new development.
14. If a slide and the instructor's speech present the same definition, combine them into one concise note and mention that the slide supports the spoken explanation; do not repeat the definition in a separate visual-observation section.
15. Format time ranges consistently as [MM:SS–MM:SS] (or [HH:MM:SS–HH:MM:SS] when needed). Use only timestamps present in the transcript.
16. Output only the new Markdown section(s). Do not reproduce YAML frontmatter or the document title. Use the no-content comment only when the interval contains no new substantive instructional learning—for example, only greetings, unrelated banter, administrative announcements, promotion, or exact repetition. Never use it merely because the interval contains no formula, definition, data-structure operation, or worked technical problem. A teacher's explanation of why DSA requires conceptual clarity and why students should understand the subject's purpose is meaningful instructional content and must be summarized when present.`;
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
    const lines = this.normalizeMarkdownBlockBoundaries(markdown).split(/\r?\n/);
    const output = [];
    for (let i = 0; i < lines.length; i++) {
      const isManagedImage = /^\s*!\[\[HoverNotes\/images\/[^\]]+\]\]\s*$/.test(lines[i]);
      if (isManagedImage) {
        const previous = output[output.length - 1] || '';
        // Both legacy screenshot headings and the current inline timestamp anchors
        // belong to the extension; keep neither in Gemini's previous-note context.
        if (/^\s*(?:###\s+)?(?:\*\*)?\[[^\]]+\]\(https?:\/\/[^)]+\)(?:\*\*)?\s*$/.test(previous)) output.pop();
        continue;
      }
      if (/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(lines[i])) continue;
      output.push(lines[i]);
    }
    return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Repair block boundaries that can be lost when a new streamed segment is
  // appended immediately after an extension-owned screenshot embed or heading.
  // This is deliberately narrow: it only separates managed image embeds and
  // timestamped Markdown headings when they have been concatenated onto a line.
  normalizeMarkdownBlockBoundaries(markdown) {
    let text = String(markdown || '').replace(/\r\n?/g, '\n');
    text = text.replace(
      /(!\[\[HoverNotes\/images\/[^\]\n]+\]\])[ \t]*(?=\S)/g,
      '$1\n\n'
    );
    text = text.replace(
      /([^\n#])([ \t]*)(?=#{2,3}\s+\[(?:\d{1,2}:)?\d{2}:\d{2}\])/g,
      '$1\n\n'
    );
    return text.replace(/\n{3,}/g, '\n\n');
  }

  normalizeTimestampFormatting(markdown) {
    let text = this.normalizeMarkdownBlockBoundaries(markdown);
    // Repair a known model formatting defect such as [00:00 - 0]:10] -> [00:00–00:10].
    // Only this unambiguous malformed shape is rewritten; all other timestamps are preserved.
    text = text.replace(/\[(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2})\]:(\d{2})\]/g, (_match, start, endMinutes, endSeconds) => {
      const normalizedMinutes = String(Number(endMinutes)).padStart(2, '0');
      return `[${start}–${normalizedMinutes}:${endSeconds}]`;
    });
    return text;
  }

  timestampToSeconds(value) {
    const parts = String(value || '').split(':').map(part => Number(part));
    if (parts.some(part => !Number.isFinite(part) || part < 0)) return Infinity;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return Infinity;
  }

  deduplicateRepeatedDefinitionSentences(markdown) {
    const seen = new Set();
    // Match complete canonical definition sentences only. This deliberately avoids deleting
    // a longer sentence whose later clause contains genuinely new lecture information.
    const definitionPatterns = [
      {
        key: 'computer-science-definition',
        pattern: /^computer\s+science\s+is\s+about\s+solving\s+problems\s+by\s+designing\s+algorithms(?:\s+that\s+can\s+be\s+converted\s+into\s+efficient\s+programs)?(?:\s*[,;:]?\s*(?:the\s+key\s+challenge\s+is\s+optimizing\s+for\s+)?time\s+and\s+memory)?[.!]?$/i
      },
      {
        key: 'algorithm-definition',
        pattern: /^an?\s+algorithm\s+is\s+a\s+systematic(?:,)?\s+step[- ]by[- ]step\s+(?:procedure|process)(?:\s+(?:for\s+solving\s+a\s+problem|that\s+can\s+be\s+translated\s+into\s+a\s+computer\s+program(?:\s+using\s+a\s+programming\s+language)?\s+and\s+executed\s+on\s+a\s+computer))?[.!]?$/i
      },
      {
        key: 'efficient-program-equation',
        pattern: /^efficient\s+program\s*=\s*data\s+structure\s*\+\s*algorithm[.!]?$/i
      }
    ];
    return String(markdown || '').split(/\r?\n/).map(line => {
      if (!line.trim() || /^\s*#{1,6}\s/.test(line) || /^\s*!\[\[/.test(line)) return line;
      const sentences = line.match(/[^.!?]+[.!?]?/g) || [line];
      const kept = [];
      for (const sentence of sentences) {
        const plain = sentence.replace(/[*_`]/g, '').replace(/^\s*[-*+]\s*/, '')
          .replace(/^[^:]{1,90}:\s*/, '').replace(/\s+/g, ' ').trim();
        const definition = definitionPatterns.find(item => item.pattern.test(plain));
        if (!definition) { kept.push(sentence); continue; }
        if (seen.has(definition.key)) continue;
        seen.add(definition.key);
        kept.push(sentence);
      }
      const result = kept.join('').trimEnd();
      if (/^\s*[-*+]\s*(?:\*\*[^*]+\*\*\s*:?)?\s*$/.test(result)) return '';
      return result;
    }).join('\n').replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n');
  }

  // Extract extension-owned screenshot heading/embed pairs before sorting note content.
  // A screenshot is an inline event inside its parent topic, not a peer section.
  extractManagedScreenshotBlocks(markdown) {
    const lines = this.normalizeMarkdownBlockBoundaries(markdown).split(/\r?\n/);
    const removed = new Set();
    const blocks = [];
    const seenFiles = new Set();
    const headingPattern = /^\s*(?:#{2,3}\s+)?(?:\*\*)?\[((?:\d{1,2}:)?\d{2}:\d{2})\]\((https?:\/\/[^)]+)\)(?:\*\*)?\s*$/;
    const imagePattern = /^\s*!\[\[HoverNotes\/images\/([^\]]+)\]\]\s*$/;

    for (let index = 0; index < lines.length; index++) {
      const heading = lines[index].match(headingPattern);
      if (!heading) continue;
      let imageIndex = index + 1;
      while (imageIndex < lines.length && !lines[imageIndex].trim() && imageIndex <= index + 2) imageIndex++;
      if (imageIndex >= lines.length) continue;
      const image = lines[imageIndex].match(imagePattern);
      if (!image) continue;

      const fileName = image[1];
      if (!seenFiles.has(fileName)) {
        blocks.push({
          timestamp: heading[1],
          seconds: this.timestampToSeconds(heading[1]),
          url: heading[2],
          fileName,
          imageLine: `![[HoverNotes/images/${fileName}]]`,
          originalIndex: blocks.length
        });
        seenFiles.add(fileName);
      }
      for (let removeIndex = index; removeIndex <= imageIndex; removeIndex++) removed.add(removeIndex);
      index = imageIndex;
    }

    const body = lines.filter((_line, index) => !removed.has(index))
      .join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return { markdown: body, blocks };
  }

  // Model output can occasionally nest an earlier timestamped visual observation
  // under a later bullet. Within each timestamped topic section, restore the
  // timestamped bullet blocks to lecture order. Supporting lines stay with the
  // timestamped bullet that precedes them.
  sortTimestampedBulletBlocksWithinSections(markdown) {
    const lines = String(markdown || '').split(/\r?\n/);
    const headingPattern = /^\s*#{2,3}\s+/;
    const sectionRanges = [];
    for (let index = 0; index < lines.length; index++) {
      if (!headingPattern.test(lines[index])) continue;
      let end = index + 1;
      while (end < lines.length && !/^\s*#{1,3}\s+/.test(lines[end])) end++;
      sectionRanges.push({ start: index, end });
    }

    // Work from the end so replacing one section cannot invalidate earlier ranges.
    for (let rangeIndex = sectionRanges.length - 1; rangeIndex >= 0; rangeIndex--) {
      const range = sectionRanges[rangeIndex];
      const starts = [];
      for (let index = range.start + 1; index < range.end; index++) {
        const bullet = lines[index].match(/^(\s*)([-*+])\s+/);
        if (!bullet) continue;
        const timestamp = lines[index].match(/\[((?:\d{1,2}:)?\d{2}:\d{2})(?:\s*[–-]\s*((?:\d{1,2}:)?\d{2}:\d{2}))?\]/);
        if (!timestamp) continue;
        starts.push({
          index,
          seconds: this.timestampToSeconds(timestamp[1]),
          indent: bullet[1].length,
          originalIndex: starts.length
        });
      }
      if (starts.length < 2) continue;
      const isMonotonic = starts.every((item, index) => index === 0 || starts[index - 1].seconds <= item.seconds);
      if (isMonotonic) continue;

      const baseIndent = Math.min(...starts.map(item => item.indent));
      const prefix = lines.slice(range.start, starts[0].index);
      const blocks = starts.map((item, index) => ({
        ...item,
        lines: lines.slice(item.index, index + 1 < starts.length ? starts[index + 1].index : range.end)
      }));
      blocks.sort((a, b) => a.seconds - b.seconds || a.originalIndex - b.originalIndex);
      const sortedBlocks = blocks.map(block => {
        const blockLines = block.lines.slice();
        // An out-of-order timestamped bullet is an independent lecture point;
        // promote it to the section's common list indentation rather than leave
        // it visually nested beneath a later topic.
        blockLines[0] = blockLines[0].replace(/^\s*/, ' '.repeat(baseIndent));
        return blockLines;
      }).flat();
      lines.splice(range.start, range.end - range.start, ...prefix, ...sortedBlocks);
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Place a captured image inside the latest timestamped topic section at or before
  // its capture time. Prefer an exact timestamped bullet, then a covering range,
  // then the closest preceding bullet. Keep the image as an inline event (not a
  // peer ### heading), so the parent topic remains structurally intact.
  insertScreenshotIntoTimestampedSection(markdown, screenshot) {
    const lines = String(markdown || '').split(/\r?\n/);
    const sectionPattern = /^\s*#{2,3}\s+.*?\[((?:\d{1,2}:)?\d{2}:\d{2})(?:\s*[–-]\s*(?:\d{1,2}:)?\d{2}:\d{2})?\]/;
    const anyHeadingPattern = /^\s*#{1,3}\s+/;
    const target = Number(screenshot.seconds);
    let sectionStart = -1;
    let sectionTime = -Infinity;
    for (let index = 0; index < lines.length; index++) {
      const match = lines[index].match(sectionPattern);
      if (!match) continue;
      const seconds = this.timestampToSeconds(match[1]);
      if (seconds <= target && seconds >= sectionTime) {
        sectionStart = index;
        sectionTime = seconds;
      }
    }

    const anchor = `**[${screenshot.timestamp}](${screenshot.url})**`;
    const screenshotBlock = `${anchor}\n${screenshot.imageLine}`;
    if (sectionStart < 0) {
      // No preceding topic section: preserve the legacy top-level timestamped
      // screenshot behaviour, inserting it before the first later timestamped heading.
      let insertAt = lines.length;
      for (let index = 0; index < lines.length; index++) {
        const match = lines[index].match(sectionPattern);
        if (match && this.timestampToSeconds(match[1]) > target) { insertAt = index; break; }
      }
      const before = lines.slice(0, insertAt).join('\n').trimEnd();
      const after = lines.slice(insertAt).join('\n').trimStart();
      const topLevelBlock = `### [${screenshot.timestamp}](${screenshot.url})\n${screenshot.imageLine}`;
      return [before, topLevelBlock, after].filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n');
    }

    let sectionEnd = lines.length;
    for (let index = sectionStart + 1; index < lines.length; index++) {
      if (anyHeadingPattern.test(lines[index])) { sectionEnd = index; break; }
    }

    const bulletPattern = /^(\s*)([-*+])\s+/;
    const candidates = [];
    for (let index = sectionStart + 1; index < sectionEnd; index++) {
      if (!bulletPattern.test(lines[index])) continue;
      const match = lines[index].match(/\[((?:\d{1,2}:)?\d{2}:\d{2})(?:\s*[–-]\s*((?:\d{1,2}:)?\d{2}:\d{2}))?\]/);
      if (!match) continue;
      candidates.push({
        index,
        start: this.timestampToSeconds(match[1]),
        end: match[2] ? this.timestampToSeconds(match[2]) : this.timestampToSeconds(match[1])
      });
    }

    let insertAt = sectionStart + 1;
    if (candidates.length) {
      const exact = candidates.find(item => item.start === target);
      const covering = candidates.filter(item => item.start <= target && item.end >= target)
        .sort((a, b) => b.start - a.start)[0];
      const preceding = candidates.filter(item => item.start <= target).slice(-1)[0];
      const following = candidates.find(item => item.start > target);
      const chosen = exact || covering || preceding;
      if (chosen) {
        const nextCandidate = candidates.find(item => item.index > chosen.index);
        insertAt = nextCandidate ? nextCandidate.index : sectionEnd;
      } else if (following) {
        insertAt = following.index;
      }
    }

    const before = lines.slice(0, insertAt).join('\n').trimEnd();
    const after = lines.slice(insertAt).join('\n').trimStart();
    return [before, screenshotBlock, after].filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n');
  }

  // Sort timestamped topic sections, then timestamped teaching bullets within each
  // section. Managed screenshots are extracted first and reinserted at their exact
  // lecture position afterward; this prevents an image from being sorted after the
  // entire parent section merely because it used to be represented as a heading.
  sortTimestampedSections(markdown) {
    const normalized = this.normalizeTimestampFormatting(markdown);
    const extracted = this.extractManagedScreenshotBlocks(normalized);
    const lines = extracted.markdown.split(/\r?\n/);
    const starts = [];
    const timestampPattern = /^\s*#{2,3}\s+.*?\[((?:\d{1,2}:)?\d{2}:\d{2})(?:\s*[–-]\s*(?:\d{1,2}:)?\d{2}:\d{2})?\]/;
    for (let index = 0; index < lines.length; index++) {
      const match = lines[index].match(timestampPattern);
      if (!match) continue;
      starts.push({ index, seconds: this.timestampToSeconds(match[1]), originalIndex: starts.length });
    }
    let sorted = lines.join('\n').trim();
    if (starts.length >= 2) {
      const prefix = lines.slice(0, starts[0].index);
      const blocks = starts.map((start, index) => ({
        ...start,
        lines: lines.slice(start.index, index + 1 < starts.length ? starts[index + 1].index : lines.length)
      }));
      blocks.sort((a, b) => a.seconds - b.seconds || a.originalIndex - b.originalIndex);
      sorted = [...prefix, ...blocks.flatMap(block => block.lines)].join('\n')
        .replace(/\n{3,}/g, '\n\n').trim();
    }

    sorted = this.sortTimestampedBulletBlocksWithinSections(sorted);
    const output = [];
    const seenImages = new Set();
    const sortedLines = sorted.split(/\r?\n/);
    for (const line of sortedLines) {
      const imageMatch = line.match(/^\s*!\[\[HoverNotes\/images\/([^\]]+)\]\]\s*$/);
      if (imageMatch) {
        if (seenImages.has(imageMatch[1])) continue;
        seenImages.add(imageMatch[1]);
      }
      output.push(line);
    }

    let result = this.deduplicateRepeatedDefinitionSentences(output.join('\n'))
      .replace(/\n{3,}/g, '\n\n').trim();
    extracted.blocks.sort((a, b) => a.seconds - b.seconds || a.originalIndex - b.originalIndex);
    for (const screenshot of extracted.blocks) {
      result = this.insertScreenshotIntoTimestampedSection(result, screenshot);
    }
    return result.replace(/\n{3,}/g, '\n\n').trim();
  }

  normalizeNoteDocument(markdown) {
    return this.sortTimestampedSections(this.normalizeMarkdownBlockBoundaries(this.normalizeTimestampFormatting(markdown)));
  }

  // Insert screenshot anchor+embed at its actual timestamp. Normalization extracts
  // the temporary heading form and reinserts it inside the matching parent section.
  insertTimestampedBlockChronologically(markdown, block, timestampSeconds) {
    const current = this.normalizeTimestampFormatting(markdown);
    const lines = current.split(/\r?\n/);
    const target = Number(timestampSeconds);
    const pattern = /^\s*#{2,3}\s+.*?\[((?:\d{1,2}:)?\d{2}:\d{2})(?:\s*[–-]\s*(?:\d{1,2}:)?\d{2}:\d{2})?\]/;
    let insertAt = lines.length;
    for (let index = 0; index < lines.length; index++) {
      const match = lines[index].match(pattern);
      if (!match) continue;
      if (this.timestampToSeconds(match[1]) > target) { insertAt = index; break; }
    }
    const blockLines = String(block || '').trim().split(/\r?\n/);
    const before = lines.slice(0, insertAt).join('\n').trimEnd();
    const after = lines.slice(insertAt).join('\n').trimStart();
    const inserted = [before, blockLines.join('\n'), after].filter(Boolean).join('\n\n');
    return this.normalizeNoteDocument(inserted);
  }

  // Spec 4: Ultra-Fast SSE Stream Generator with Zero Thinking Delay & Multi-Key Failover
  async generateNotesStream({
    videoTitle,
    currentTimestamp,
    transcriptChunk,
    frameBase64,
    frameImages = [],
    frameTimestamp = null,
    modeLabel = 'Lecture Notes',
    onChunk,
    onComplete,
    onError,
    onDiagnostics,
    existingNotes = '',
    signal,
    promptOverride = null,
    systemPromptOverride = null,
    maxOutputTokens = 8192,
    returnMetadata = false
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
    const generatedSegmentPrompt = `Video title: ${videoTitle}
Lecture timestamp range: ${currentTimestamp}
Generation mode: ${modeLabel}
Visual evidence timestamps: ${[...(frameBase64 && frameTimestamp ? [frameTimestamp] : []), ...(Array.isArray(frameImages) ? frameImages.map((_, index) => `attached frame ${index + 1}`) : [])].join(', ') || '[No visual frame attached]'}

TRANSCRIPT EVIDENCE (primary source):
"""
${transcriptChunk || '[No transcript text was supplied. Do not invent spoken content. Describe only clearly visible information in the attached frame, and state that audio content is unavailable.]'}
"""

PREVIOUS NOTE CONTEXT (use only to avoid repeating material; do not copy it):
"""
${priorContext || '[No earlier notes in this run.]'}
"""

Create the new notes for this timestamp range only. Ground every factual statement in the transcript or visibly legible frame. Preserve the instructor's examples and numbers exactly. Never add generic GATE/DSA material to fill space. Do not label an AI-generated example as an instructor example. If there is insufficient evidence, write less rather than guess.

CONTENT COVERAGE — DO NOT OMIT INSTRUCTIONAL FRAMING:
- Preserve substantive teaching even when it is introductory or conceptual rather than a formula, formal definition, data-structure operation, or worked problem.
- Summarize why the instructor says the subject matters, what students are expected to understand, why conceptual clarity/depth is needed, and how the upcoming material fits into problem-solving.
- Distinguish educational explanation from course advertising. Omit only the promotional/administrative statements themselves; do not discard the educational explanation surrounding them.
- Before returning the no-new-content comment, check whether the transcript contains any new rationale, learning objective, conceptual motivation, distinction, analogy, or instructor explanation. If it does, write a concise timestamped section instead.
- Do not omit a meaningful passage merely because a later segment will introduce formal definitions or operations.

CHRONOLOGY AND ASSET RULES:
- Follow the transcript cue timestamps in strictly ascending order.
- Put each major topic under a heading beginning with its earliest supported timestamp.
- The attached frame was captured at ${frameBase64 && frameTimestamp ? frameTimestamp : 'an unspecified time'}; visual-only observations belong at that time, never earlier in the interval.
- Never output image Markdown, Obsidian wiki-links, screenshot headings, image filenames, or copied previous-note media. The extension inserts selected screenshots after generation.
- Do not restate definitions already covered in previous notes; add only new information from this interval.
- If a slide and the instructor's speech present the same definition, combine them into one concise note and mention that the slide supports the spoken explanation; do not repeat the definition in a separate visual-observation section.
- Format time ranges consistently as [MM:SS–MM:SS] (or [HH:MM:SS–HH:MM:SS] when needed). Use only timestamps present in the transcript.`;
    const userPrompt = typeof promptOverride === 'string' && promptOverride.trim()
      ? promptOverride
      : generatedSegmentPrompt;
    const activeSystemPrompt = typeof systemPromptOverride === 'string' && systemPromptOverride.trim()
      ? systemPromptOverride
      : this.systemPrompt;

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
            frameImages,
            onChunk,
            onComplete,
            signal,
            onDiagnostics,
            systemPrompt: activeSystemPrompt,
            maxOutputTokens,
            returnMetadata
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
            generatedCharacters: returnMetadata ? (generated?.text || '').length : (generated || '').length
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
          frameImages,
          onChunk,
          onComplete,
          signal,
          onDiagnostics,
          systemPrompt: activeSystemPrompt,
          maxOutputTokens,
          returnMetadata
        });
        this.emitDiagnostics(onDiagnostics, {
          type: 'attempt-success',
          provider: 'openai-compatible',
          model: this.customModel || 'gpt-4o-mini',
          durationMs: Math.round(performance.now() - customStartedAt),
          generatedCharacters: returnMetadata ? (generated?.text || '').length : (generated || '').length
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

  // Final study notes always pass through evidence extraction, even for short
  // transcripts. Direct transcript-to-final rendering previously bypassed the
  // only stage designed to preserve every distinct teaching point.
  async synthesizeStudyDocument({ videoTitle, stopTime, sourceTranscript, videoDescription = '', visualAssets = [], supplementaryVisualNotes = '', onDiagnostics, signal }) {
    const rawTranscript = String(sourceTranscript || '').trim();
    if (!rawTranscript) throw new Error('The complete source transcript could not be retrieved. The incremental draft was retained.');
    if (signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    const helpers = window.HoverNotesNoteSynthesis;
    if (!helpers) throw new Error('The source-grounded synthesis helpers did not load.');
    const transcript = helpers.normalizeTranscriptForAI(rawTranscript);
    if (!transcript) throw new Error('Transcript normalization returned no usable cue text.');

    const lines = transcript.split(/\r?\n/).filter(line => line.trim());
    const coverageWindows = helpers.buildCoverageWindows(lines, 30);
    if (!coverageWindows.length) throw new Error('The source transcript has no usable timestamped cues.');
    const visualTokens = (Array.isArray(visualAssets) ? visualAssets : []).map(x => String(x?.token || '').trim()).filter(Boolean);
    const assetInstructions = visualAssets.length
      ? visualAssets.map(x => `${x.token} — OPTIONAL placement hint for the preserved screenshot at ${x.timestamp}. The extension restores the actual image independently.`).join('\n')
      : '[No screenshot assets selected.]';

    const systemPrompt = `You are an expert educational note editor translating timestamped Hindi/Hinglish lecture transcripts into accurate, comprehensive English study notes.

FACTUAL RULES:
- The supplied timestamped transcript and any attached original screenshot frames are the only factual sources for instructional content. Use frames only for text or relationships visibly legible in the image; do not infer hidden slide content.
- Do not use video title, YouTube description, channel metadata, earlier AI drafts, or guesses as factual evidence. They are metadata or potentially lossy material, not lecture evidence.
- Do not invent instructor credentials, years of experience, institutions, syllabus guarantees, course features, examples, formulas, code, complexity bounds, diagrams, or claims.
- Preserve claims as claims made by the instructor; do not silently correct or endorse them.
- Preserve every distinct explanation, reason, example, analogy, comparison, qualification, numerical detail, definition, procedure, and teaching point.
- Translate faithfully. If the transcript is unclear, retain uncertainty rather than guessing.
- Remove greetings and repeated filler only when they add no instructional or course information.
- Consolidate repeated explanations of the same concept across the lecture. Preserve each distinct reason or example, but do not restate a definition, formula, or conclusion in multiple sections.
- Prefer compact, information-dense notes over repeated prose. Do not add connective sentences that merely repeat the preceding bullet.
- Never compress merely to reduce length. Completeness and source fidelity take priority over brevity.`;

    const stage = (name, details = {}) => this.emitDiagnostics(onDiagnostics, { stage: name, ...details });
    const startedAt = performance.now();
    // Evidence extraction is mandatory for all transcript sizes. A 6-minute
    // lecture must not bypass the coverage-preserving stage just because it is
    // smaller than a model context threshold.
    const chunkLimit = 9000;
    const chunks = helpers.chunkTranscriptByTimeWindows(lines, chunkLimit, 30);
    if (!chunks.length) throw new Error('The transcript could not be divided into source-grounded chunks.');
    stage('source-map-start', {
      strategy: 'evidence-first-all-lengths',
      chunkCount: chunks.length,
      inputCharacters: transcript.length,
      chunkLimit,
      coverageWindowCount: coverageWindows.length,
      coverageWindowSeconds: 30
    });

    let packets = [];
    let packetWindows = [];
    let packetFallbacks = [];
    let extractionCount = 0;
    let reductionCount = 0;
    const coverageAssignment = helpers.validateCoverageAssignment(chunks, coverageWindows, 30);
    if (!coverageAssignment.valid) {
      throw new Error(`Transcript chunking did not map every source window exactly once (missing: ${coverageAssignment.missing.join(', ') || 'none'}; duplicated: ${coverageAssignment.duplicated.join(', ') || 'none'}). The original draft was retained.`);
    }

    const extractChunkWithRecovery = async (chunk, chunkWindows, chunkVisualAssets, depth = 0) => {
      if (signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
      const rangeManifest = chunkWindows.map(x => `${x.startLabel}–${x.endLabel} (${x.cueCount} transcript cues)`).join('\n');
      const visualManifest = chunkVisualAssets.length
        ? chunkVisualAssets.map(asset => `Original slide/frame attached at ${asset.timestamp}; inspect only visibly legible content.`).join('\n')
        : '[No original screenshot frame is available for this source segment.]';

      const prompt = `Build a comprehensive, loss-minimizing evidence packet from this original lecture segment. This is NOT a summary and NOT the final study document.

VIDEO CONTEXT (metadata only): ${videoTitle || 'Untitled lecture'}
SEGMENT: ${chunk.index != null ? `${chunk.index + 1}/${chunks.length}` : 'recovery segment'}
SOURCE RANGE: ${chunk.startLabel || 'unknown'}–${chunk.endLabel || 'unknown'}
SOURCE WINDOWS INCLUDED IN THIS PACKET:
${rangeManifest}

ORIGINAL TIMESTAMPED TRANSCRIPT:
<transcript>
${chunk.transcriptText}
</transcript>

ORIGINAL VISUAL EVIDENCE:
${visualManifest}
The attached original frames are supporting sources. Capture only text, labels, equations, examples, classifications, or relationships that are actually visible and readable. Attribute visual-only information to the slide/frame; do not invent what is obscured.

EVIDENCE EXTRACTION REQUIREMENTS:
1. Account for every substantive statement across the full source range above. The extension tracks the source-window metadata separately; do not reproduce machine-generated IDs, hidden markers, or tokens.
2. Preserve the lecture's progression and all distinct ideas. Do not skip introductory rationale, motivation, conceptual framing, teaching strategy, or why a topic matters.
3. Capture definitions, explanations, reasoning, examples, analogies, comparisons, caveats, named entities, numbers, claims, procedures, and exam/course information when actually spoken.
4. Translate Hindi/Hinglish faithfully into clear English. Preserve the instructor's intended meaning and attribute personal opinions/claims.
5. Combine repeated wording only when it is genuinely redundant. Do not merge separate ideas into a vague sentence.
6. Use topic labels and nested bullets. Group evidence chronologically by source window, with the window timestamp anchor (e.g., [${chunkWindows[0]?.startLabel || '00:00'}], etc.) at the start of each window's evidence block, so that every source window is explicitly represented.
7. Do not add general textbook knowledge or details from the video description.
8. Do not impose a word-count target. The packet must retain enough detail to reconstruct the segment without replaying it.
9. Return Markdown only. Do not add a YAML frontmatter block or a video title.

The source windows listed above are authoritative coverage metadata. They are already associated with this packet by the extension. Never invent, omit, or rewrite that metadata; simply extract the content from the transcript.`;

      let rawResult = null;
      let packetText = '';
      let metadata = {};
      try {
        rawResult = await this.generateNotesStream({
          videoTitle,
          currentTimestamp: `${chunk.startLabel || ''}–${chunk.endLabel || ''}`,
          transcriptChunk: chunk.transcriptText,
          modeLabel: 'Timestamp-windowed comprehensive evidence extraction',
          promptOverride: prompt,
          systemPromptOverride: systemPrompt,
          frameImages: chunkVisualAssets.map(asset => asset.dataUrl),
          maxOutputTokens: 8192,
          signal,
          returnMetadata: true,
          onDiagnostics: event => stage('source-map-attempt', {
            chunk: (chunk.index != null ? chunk.index + 1 : 1),
            chunkCount: chunks.length,
            sourceWindowCount: chunkWindows.length,
            visualFrameCount: chunkVisualAssets.length,
            depth,
            ...event
          })
        });
        packetText = String(rawResult?.text || rawResult || '').trim();
        metadata = rawResult?.metadata || {};
      } catch (err) {
        if (signal?.aborted || err.code === 'SAFETY_BLOCKED' || err.name === 'AbortError') throw err;
        stage('source-map-attempt-error', { chunk: (chunk.index != null ? chunk.index + 1 : 1), depth, error: err.message });
      }

      stage('source-map-stream-complete', {
        chunk: (chunk.index != null ? chunk.index + 1 : 1),
        chunkCount: chunks.length,
        durationMs: metadata.totalRequestMs || 0,
        outputCharacters: packetText.length,
        finishReason: metadata.finishReason ?? null,
        completionStatus: metadata.completionStatus || 'unknown_completion',
        hasTerminalSignal: metadata.hasTerminalSignal ?? null,
        isComplete: metadata.isComplete ?? null,
        isTruncated: Boolean(metadata.isTruncated),
        streamEndedNormally: Boolean(metadata.streamEndedNormally)
      });

      // Deterministic source-window validation
      const val = helpers.validateEvidencePacket(packetText, chunkWindows);
      stage('source-map-validation', {
        chunk: (chunk.index != null ? chunk.index + 1 : 1),
        valid: val.valid,
        coveredWindows: val.coveredWindows,
        missingWindows: val.missingWindows,
        emptyWindows: val.emptyWindows,
        duplicateAnchors: val.duplicateAnchors,
        outOfOrderWindows: val.outOfOrderWindows,
        repeatedWindowContent: val.repeatedWindowContent,
        outputCharacters: val.outputCharacters
      });

      // If valid and not truncated by MAX_TOKENS: accept immediately! (Scenario B)
      const completionUnverified = metadata.hasTerminalSignal === false;
      if (val.valid && !metadata.isTruncated && !completionUnverified) {
        return {
          text: packetText,
          windows: chunkWindows,
          isFallback: false
        };
      }

      // Tier 1 Recovery: Targeted completion for missing source windows
      // (Only if not truncated by MAX_TOKENS and has partial content)
      if (!metadata.isTruncated && !completionUnverified && val.missingWindows.length > 0 && val.missingWindows.length < chunkWindows.length) {
        stage('source-map-repair-attempt', {
          chunk: (chunk.index != null ? chunk.index + 1 : 1),
          missingWindows: val.missingWindows,
          missingWindowCount: val.missingWindows.length
        });

        const missingLines = helpers.getTranscriptLinesForWindows(chunk.lines, val.missingWindows, 30);
        const missingWindowsManifest = chunkWindows
          .filter(w => val.missingWindows.includes(w.startLabel))
          .map(x => `${x.startLabel}–${x.endLabel} (${x.cueCount} cues)`)
          .join('\n');

        const repairPrompt = `TARGETED EVIDENCE EXTRACTION REPAIR:
The initial extraction omitted evidence for specific source windows. Extract comprehensive evidence for ONLY the missing source windows listed below.

MISSING SOURCE WINDOWS:
${missingWindowsManifest}

TRANSCRIPT CUES FOR MISSING WINDOWS:
<transcript>
${missingLines}
</transcript>

REQUIREMENTS:
1. Extract every distinct instructional statement for each listed missing window.
2. Group evidence chronologically by source window, with the window timestamp anchor (e.g., [${val.missingWindows[0]}]) at the start of each block.
3. Do not re-extract already-covered windows.
4. Return Markdown only.`;

        try {
          const repairResult = await this.generateNotesStream({
            videoTitle,
            currentTimestamp: `repair for ${val.missingWindows.join(', ')}`,
            transcriptChunk: missingLines,
            modeLabel: 'Targeted missing source-window evidence completion',
            promptOverride: repairPrompt,
            systemPromptOverride: systemPrompt,
            maxOutputTokens: 8192,
            signal,
            returnMetadata: true,
            onDiagnostics: event => stage('source-map-repair-diag', event)
          });
          const repairText = String(repairResult?.text || repairResult || '').trim();
          const repairMetadata = repairResult?.metadata || {};

          const mergedText = helpers.mergeEvidenceEntries(packetText, repairText, chunkWindows);
          const repairVal = helpers.validateEvidencePacket(mergedText, chunkWindows);
          stage('source-map-repair-complete', {
            chunk: (chunk.index != null ? chunk.index + 1 : 1),
            valid: repairVal.valid,
            outputCharacters: mergedText.length,
            missingWindows: repairVal.missingWindows,
            duplicateAnchors: repairVal.duplicateAnchors,
            outOfOrderWindows: repairVal.outOfOrderWindows,
            repeatedWindowContent: repairVal.repeatedWindowContent,
            repairedWindows: val.missingWindows.filter(w => !repairVal.missingWindows.includes(w))
          });

          if (repairVal.valid && !repairMetadata.isTruncated && repairMetadata.hasTerminalSignal !== false) {
            return {
              text: mergedText,
              windows: chunkWindows,
              isFallback: false
            };
          }
        } catch (repairErr) {
          if (signal?.aborted || repairErr.code === 'SAFETY_BLOCKED' || repairErr.name === 'AbortError') throw repairErr;
          stage('source-map-repair-failed', { chunk: (chunk.index != null ? chunk.index + 1 : 1), error: repairErr.message });
        }
      }

      // Tier 2 Recovery: Adaptive source splitting at 30-second window boundaries
      // (Triggered if truncated by MAX_TOKENS or if targeted completion did not resolve missing windows)
      if (depth < 2 && chunkWindows.length >= 2) {
        stage('source-map-split-start', {
          chunk: (chunk.index != null ? chunk.index + 1 : 1),
          depth: depth + 1,
          reason: metadata.isTruncated ? 'max_tokens' : (completionUnverified ? 'completion_unverified' : 'missing_windows'),
          windowCount: chunkWindows.length
        });

        try {
          const childChunks = helpers.splitChunkByWindows(chunk, chunkWindows, 2, 30);
          const childPackets = [];
          for (let c = 0; c < childChunks.length; c++) {
            const childChunk = childChunks[c];
            const childWindows = childChunk.windows;
            const childAssets = visualAssets.filter(asset => {
              if (!asset?.dataUrl || !Number.isFinite(childChunk.startTime) || !Number.isFinite(childChunk.endTime)) return false;
              const seconds = helpers.parseTimestampSeconds(`[${asset.timestamp || ''}]`);
              return seconds !== null && seconds >= childChunk.startTime && seconds <= childChunk.endTime;
            }).slice(0, 4);

            const childResult = await extractChunkWithRecovery(childChunk, childWindows, childAssets, depth + 1);
            childPackets.push(childResult);
          }

          const mergedChildrenText = childPackets.map(p => p.text).join('\n\n');
          stage('source-map-split-complete', {
            chunk: (chunk.index != null ? chunk.index + 1 : 1),
            depth: depth + 1,
            parts: childPackets.length,
            outputCharacters: mergedChildrenText.length
          });

          const splitVal = helpers.validateEvidencePacket(mergedChildrenText, chunkWindows);
          if (splitVal.valid) {
            return {
              text: mergedChildrenText,
              windows: chunkWindows,
              isFallback: childPackets.some(p => p.isFallback)
            };
          }
        } catch (splitErr) {
          if (signal?.aborted || splitErr.code === 'SAFETY_BLOCKED' || splitErr.name === 'AbortError') throw splitErr;
          stage('source-map-split-failed', { chunk: (chunk.index != null ? chunk.index + 1 : 1), depth: depth + 1, error: splitErr.message });
        }
      }

      // Tier 3 Recovery: Last-Resort Raw-Source Fallback Packet
      // Retain original timestamped transcript in a clearly marked raw-source fallback packet
      stage('source-map-source-fallback', {
        chunk: (chunk.index != null ? chunk.index + 1 : 1),
        reason: metadata.isTruncated ? 'max_tokens_unresolved' : (completionUnverified ? 'completion_unverified' : (val.reasons?.join('; ') || 'unresolved_extraction_failure')),
        transcriptCharacters: chunk.characterCount,
        windowCount: chunkWindows.length
      });

      const rawFallbackText = `### Raw Source Transcript Fallback [${chunk.startLabel || '00:00'}–${chunk.endLabel || 'end'}]
[Unprocessed source transcript preserved below due to extraction failure. The final renderer must faithfully translate and extract all instructional content from this raw source.]

${chunk.transcriptText}`;

      return {
        text: rawFallbackText,
        windows: chunkWindows,
        isFallback: true
      };
    };

    for (let i = 0; i < chunks.length; i++) {
      if (signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
      const chunk = chunks[i];
      const chunkBuckets = new Set(chunk.lines.map(line => {
        const seconds = helpers.parseTimestampSeconds(line);
        return seconds === null ? null : Math.floor(seconds / 30);
      }).filter(x => x !== null));
      const chunkWindows = coverageWindows.filter(window => chunkBuckets.has(window.bucket));
      const chunkVisualAssets = visualAssets.filter(asset => {
        if (!asset?.dataUrl || !Number.isFinite(chunk.startTime) || !Number.isFinite(chunk.endTime)) return false;
        const seconds = helpers.parseTimestampSeconds(`[${asset.timestamp || ''}]`);
        return seconds !== null && seconds >= chunk.startTime && seconds <= chunk.endTime;
      }).slice(0, 4);

      const packetResult = await extractChunkWithRecovery(chunk, chunkWindows, chunkVisualAssets, 0);

      packets.push(packetResult.text);
      packetWindows.push(chunkWindows.map(window => ({
        windowId: window.windowId,
        bucket: window.bucket,
        startLabel: window.startLabel,
        endLabel: window.endLabel,
        cueCount: window.cueCount
      })));
      packetFallbacks.push(packetResult.isFallback);
      extractionCount++;
      stage('source-map-complete', {
        chunk: i + 1,
        chunkCount: chunks.length,
        inputCharacters: chunk.characterCount,
        outputCharacters: packetResult.text.length,
        sourceWindowsMapped: chunkWindows.length,
        isFallback: packetResult.isFallback
      });
    }

    // Source-window provenance remains in a code-owned sidecar. The model is
    // never asked to echo IDs, so paraphrasing or omitting a token cannot abort
    // an otherwise valid evidence packet.
    const uniqueWindowRecords = records => {
      const byId = new Map();
      for (const record of records || []) if (!byId.has(record.windowId)) byId.set(record.windowId, record);
      return [...byId.values()].sort((a, b) => a.bucket - b.bucket);
    };

    // Reduce only when needed. The sidecar is merged deterministically while
    // the model consolidates the text; provenance is not encoded in model output.
    let level = 0;
    const ledgerLimit = 36000;
    while (packets.join('\n\n').length > ledgerLimit && level < 5) {
      level++;
      const groups = helpers.chunkKnowledgeBlocks(packets, 24000);
      if (!groups.length) break;
      const reduced = [];
      const reducedWindows = [];
      const reducedFallbacks = [];
      let packetCursor = 0;
      for (let g = 0; g < groups.length; g++) {
        if (signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
        const group = groups[g];
        const groupPackets = packetWindows.slice(packetCursor, packetCursor + group.length);
        const groupFallbacks = packetFallbacks.slice(packetCursor, packetCursor + group.length);
        packetCursor += group.length;
        const groupWindows = uniqueWindowRecords(groupPackets.flat());
        const groupHasFallback = groupFallbacks.some(Boolean);
        const rangeManifest = groupWindows.map(x => `${x.startLabel}–${x.endLabel} (${x.cueCount} cues)`).join('\n');
        const groupText = group.join('\n\n');
        const prompt = `Loss-minimizing consolidation of comprehensive evidence packets. Do not write final notes yet.

SOURCE WINDOWS REPRESENTED IN THIS GROUP (authoritative coverage metadata):
${rangeManifest}

EVIDENCE PACKETS:
<packets>
${groupText}
</packets>

CONSOLIDATION REQUIREMENTS:
1. Preserve every distinct definition, explanation, motivation, example, analogy, number, claim, caveat, comparison, procedure, course detail and exam detail across the evidence packets above.
2. Remove only exact duplicates and truly redundant wording across packets. Do not collapse nuances, explanations, or examples into vague summaries.
3. Group evidence chronologically by source window, preserving the window timestamp anchor (e.g., [${groupWindows[0]?.startLabel || '00:00'}]) at the start of each window's evidence block, so that every source window is explicitly represented.
4. Translate any remaining Hindi/Hinglish faithfully into clear English.
5. The extension tracks source-window coverage separately; do not reproduce machine-generated IDs, hidden markers, or tokens. Add no external knowledge.
6. Return Markdown only. Do not add YAML frontmatter or a video title.`;

        stage('source-reduce-attempt', {
          level,
          group: g + 1,
          groupCount: groups.length,
          sourceWindowCount: groupWindows.length
        });

        let consolidationAccepted = false;
        try {
          const result = await this.generateNotesStream({
            videoTitle,
            currentTimestamp: `evidence consolidation level ${level}`,
            transcriptChunk: groupText,
            modeLabel: 'Loss-minimizing evidence consolidation',
            promptOverride: prompt,
            systemPromptOverride: systemPrompt,
            maxOutputTokens: 8192,
            signal,
            returnMetadata: true,
            onDiagnostics: event => stage('source-reduce-stream-diag', { level, group: g + 1, ...event })
          });
          const resultText = String(result?.text || result || '').trim();
          const resultMeta = result?.metadata || {};

          stage('source-reduce-stream-complete', {
            level,
            group: g + 1,
            outputCharacters: resultText.length,
            finishReason: resultMeta.finishReason ?? null,
            completionStatus: resultMeta.completionStatus || 'unknown_completion',
            hasTerminalSignal: resultMeta.hasTerminalSignal ?? null,
            isComplete: resultMeta.isComplete ?? null,
            isTruncated: Boolean(resultMeta.isTruncated)
          });

          const val = helpers.validateEvidencePacket(resultText, groupWindows);
          stage('source-reduce-validation', {
            level,
            group: g + 1,
            valid: val.valid,
            coveredWindows: val.coveredWindows,
            missingWindows: val.missingWindows,
            duplicateAnchors: val.duplicateAnchors,
            outOfOrderWindows: val.outOfOrderWindows,
            repeatedWindowContent: val.repeatedWindowContent
          });

          let mergedRepair = null;
          let repairResult = null;
          if (val.valid && !resultMeta.isTruncated && resultMeta.hasTerminalSignal !== false) {
            reduced.push(resultText);
            reducedWindows.push(groupWindows);
            reducedFallbacks.push(groupHasFallback);
            reductionCount++;
            consolidationAccepted = true;
            stage('source-reduce-complete', {
              level,
              group: g + 1,
              groupCount: groups.length,
              inputCharacters: groupText.length,
              outputCharacters: resultText.length,
              sourceWindowsMapped: groupWindows.length
            });
          } else if (!resultMeta.isTruncated && resultMeta.hasTerminalSignal !== false && val.missingWindows.length > 0 && val.missingWindows.length <= groupWindows.length) {
            // Targeted completion for missing windows in consolidation
            stage('source-reduce-repair-attempt', {
              level,
              group: g + 1,
              missingWindows: val.missingWindows
            });

            const missingWindowsManifest = groupWindows
              .filter(w => val.missingWindows.includes(w.startLabel))
              .map(x => `${x.startLabel}–${x.endLabel} (${x.cueCount} cues)`)
              .join('\n');

            const repairPrompt = `TARGETED CONSOLIDATION REPAIR:
Consolidation omitted evidence for these source windows:
${missingWindowsManifest}

Extract and preserve comprehensive evidence for ONLY these missing windows from the packets below:
<packets>
${groupText}
</packets>

REQUIREMENTS:
1. Extract distinct evidence for each missing window listed above.
2. Group evidence chronologically by source window, with the window timestamp anchor (e.g., [${val.missingWindows[0]}]) at the start of each block.
3. Return Markdown only.`;

            repairResult = await this.generateNotesStream({
              videoTitle,
              currentTimestamp: `consolidation repair level ${level} group ${g + 1}`,
              transcriptChunk: groupText,
              modeLabel: 'Consolidation missing-window repair',
              promptOverride: repairPrompt,
              systemPromptOverride: systemPrompt,
              maxOutputTokens: 8192,
              signal,
              returnMetadata: true
            });
            const repairText = String(repairResult?.text || repairResult || '').trim();
            mergedRepair = helpers.mergeEvidenceEntries(resultText, repairText, groupWindows);
            const repairVal = helpers.validateEvidencePacket(mergedRepair, groupWindows);
            stage('source-reduce-repair-complete', {
              level,
              group: g + 1,
              valid: repairVal.valid,
              missingWindows: repairVal.missingWindows,
              duplicateAnchors: repairVal.duplicateAnchors,
              outOfOrderWindows: repairVal.outOfOrderWindows,
              repeatedWindowContent: repairVal.repeatedWindowContent
            });

            if (repairVal.valid && !repairResult?.metadata?.isTruncated && repairResult?.metadata?.hasTerminalSignal !== false) {
              reduced.push(mergedRepair);
              reducedWindows.push(groupWindows);
              reducedFallbacks.push(groupHasFallback);
              reductionCount++;
              consolidationAccepted = true;
              stage('source-reduce-complete', {
                level,
                group: g + 1,
                groupCount: groups.length,
                inputCharacters: groupText.length,
                outputCharacters: mergedRepair.length,
                sourceWindowsMapped: groupWindows.length
              });
            }
          }

          // Resilient consolidation acceptance:
          // If targeted repair or model output completed without truncation and produced substantial,
          // reduced Markdown evidence, accept it rather than dropping to an uncompressed ledger.
          // Provenance is deterministically maintained in the sidecar reducedWindows.
          if (!consolidationAccepted && !resultMeta.isTruncated && resultMeta.hasTerminalSignal !== false) {
            const candidateText = (typeof mergedRepair === 'string' && mergedRepair.trim()) ? mergedRepair.trim() : resultText;
            const candidateMeta = (typeof mergedRepair === 'string' && mergedRepair.trim()) ? (repairResult?.metadata || resultMeta) : resultMeta;
            if (!candidateMeta.isTruncated && candidateMeta.hasTerminalSignal !== false &&
                candidateText.length >= Math.max(500, Math.floor(groupText.length * 0.15)) &&
                candidateText.length < groupText.length &&
                (candidateText.match(/^```/gm) || []).length % 2 === 0 &&
                candidateMeta.completionStatus !== 'blocked') {
              stage('source-reduce-coverage-tolerated', {
                level,
                group: g + 1,
                missingWindows: (val.missingWindows || []).length,
                coveredWindows: val.coveredWindows || 0,
                outputCharacters: candidateText.length
              });
              reduced.push(candidateText);
              reducedWindows.push(groupWindows);
              reducedFallbacks.push(groupHasFallback);
              reductionCount++;
              consolidationAccepted = true;
              stage('source-reduce-complete', {
                level,
                group: g + 1,
                groupCount: groups.length,
                inputCharacters: groupText.length,
                outputCharacters: candidateText.length,
                sourceWindowsMapped: groupWindows.length
              });
            }
          }
        } catch (reduceErr) {
          if (signal?.aborted || reduceErr.code === 'SAFETY_BLOCKED' || reduceErr.name === 'AbortError') throw reduceErr;
          stage('source-reduce-error', { level, group: g + 1, error: reduceErr.message });
        }

        // Safe Fallback: If consolidation was invalid, truncated, or threw an error:
        // Retain the original group items! Never discard unvalidated evidence!
        if (!consolidationAccepted) {
          stage('source-reduce-fallback-retained', {
            level,
            group: g + 1,
            retainedItemCount: group.length,
            reason: 'consolidation_unvalidated_or_failed'
          });
          reduced.push(...group);
          reducedWindows.push(...groupPackets);
          reducedFallbacks.push(...groupFallbacks);
        }
      }
      if (packetCursor !== packets.length) throw new Error('Evidence consolidation did not account for every source packet.');
      const previousSize = packets.join('\n\n').length;
      const nextSize = reduced.join('\n\n').length;
      if (nextSize >= previousSize) {
        // Consolidation did not reduce size further
        break;
      }
      packets = reduced;
      packetWindows = reducedWindows;
      packetFallbacks = reducedFallbacks;
    }

    const mappedWindowRecords = uniqueWindowRecords(packetWindows.flat());
    const mappedWindowIds = new Set(mappedWindowRecords.map(x => x.windowId));
    const missingMappedWindows = coverageWindows.filter(x => !mappedWindowIds.has(x.windowId));
    if (missingMappedWindows.length) {
      throw new Error(`The evidence ledger is missing ${missingMappedWindows.length} source windows after extraction/consolidation. The original draft was retained.`);
    }
    const ledgerSize = packets.join('\n\n').length;
    if (ledgerSize > ledgerLimit) throw new Error(`The lecture evidence is still too large for safe final synthesis (${ledgerSize} > ${ledgerLimit}). The original draft was retained.`);

    const hasRawFallback = packetFallbacks.some(Boolean);
    const fallbackInstructions = hasRawFallback ? `

SPECIAL RAW-SOURCE TRANSCRIPT INSTRUCTIONS:
One or more evidence packets below contain raw source transcript fallback (marked with "[RAW SOURCE TRANSCRIPT FALLBACK]").
For these fallback sections:
- Faithfully translate the raw Hindi/Hinglish transcript into accurate English study notes.
- Extract every distinct instructional statement, explanation, example, analogy, definition, and formula.
- Seamlessly integrate them under appropriate descriptive topic headings in the reference style.
- Ensure no instructional content from the raw source transcript is omitted.` : '';

    const evidence = packets.map((packetText, index) => {
      const windows = uniqueWindowRecords(packetWindows[index] || []);
      const rangeLabel = windows.length ? `${windows[0].startLabel}–${windows[windows.length - 1].endLabel}` : 'unknown range';
      const windowList = windows.map(x => `${x.startLabel}–${x.endLabel}`).join(', ');
      const fallbackBadge = packetFallbacks[index] ? ' [RAW SOURCE TRANSCRIPT FALLBACK]' : '';
      return `### Evidence packet ${index + 1} (${rangeLabel})${fallbackBadge}\nSource windows represented: ${windowList}\n\n${packetText}`;
    }).join('\n\n');

    if (signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    const rangeManifest = coverageWindows.map(x => `${x.startLabel}–${x.endLabel} (${x.cueCount} transcript cues)`).join('\n');
    const sourceManifest = packets.map((packetText, index) => {
      const windows = uniqueWindowRecords(packetWindows[index] || []);
      const fallbackBadge = packetFallbacks[index] ? ' (raw transcript fallback)' : '';
      return `Evidence packet ${index + 1}: ${windows.length ? `${windows[0].startLabel}–${windows[windows.length - 1].endLabel}` : 'unknown range'}; ${windows.length} source windows${fallbackBadge}`;
    }).join('\n');
    const styleReference = `REFERENCE EXPORT STYLE — reproduce the FORMAT, not the example's subject matter:

### Core Concept

- State the concept directly using only information supported by the lecture.
    - Put the explanation, reason, qualification, and source-supported examples beneath this parent point.
- **[Key Insight]** Use a bracketed callout only for an especially useful distinction or conclusion.

### Applying the Concept

- Group related ideas under a descriptive topic heading instead of splitting one concept across several overlapping headings.
- Place examples and analogies beneath the concept they explain.
- Use a comparison table only when the lecture actually compares alternatives.

FORMAT RULES OBSERVED IN THE REFERENCE:
- Use descriptive ### topic headings and occasional #### subheadings; do not make a heading for every timestamp or every secondary explanation.
- Use the reference's nested bullet structure with Markdown hyphen bullets. Nest supporting details four spaces below the parent bullet.
- Use bold bracketed labels such as **[Definition]**, **[Teaching Strategy]**, **[Key Insight]**, or **[Example]** selectively. Most bullets should be plain statements; a callout is not a prefix required for every concept or example. As a rule of thumb, use no more than one callout in a main topic section unless a second label adds a genuinely different function.
- Avoid repeated sections: explain a concept once, then add distinct details/examples as nested bullets in that same section.
- Put standalone formulas in display LaTeX. Use comparison tables only for genuine comparisons.
- Use a Mermaid mindmap/flowchart when the lecture presents a clear relationship, classification, or process. In particular, when several parallel real-world examples illustrate the same abstract concept, a compact mindmap may group those examples under that concept. Do not invent extra examples or categories.
- Use blockquotes sparingly for a memorable instructor statement or key takeaway.
- The reference is topic-organized, detailed, and explanatory—not a chronological transcript and not a short executive summary.`;

    const finalPrompt = `Create the final study notes for this captured lecture segment in the editorial style of the supplied HoverNotes reference export.

VIDEO TITLE (metadata only): ${videoTitle || 'Untitled lecture'}
CAPTURED THROUGH: ${stopTime || 'the captured stopping point'}

${styleReference}${fallbackInstructions}

SOURCE PACKET MAP — provenance is maintained by the extension and does not need to appear as IDs in the notes:
${sourceManifest}

SOURCE COVERAGE WINDOWS — every non-empty interval is represented in the evidence ledger. Use all relevant material, but group it by concept rather than by time:
${rangeManifest}

EVIDENCE LEDGER — this is the factual source. Preserve all distinct instructional content:
<lecture_evidence>
${evidence}
</lecture_evidence>

OPTIONAL SCREENSHOT PLACEHOLDERS:
${assetInstructions}

FINAL EDITORIAL INSTRUCTIONS:
1. Organize the notes by concepts actually taught, following the source's topic progression. Merge closely related points under one coherent topic heading, but preserve a separate heading when the instructor moves to a genuinely different teaching objective or concept.
2. Do not collapse several distinct lecture topics into one broad heading merely to reduce heading count. Equally, do not split one concept into separate headings for its definition, importance, examples, practical implication, and restatement when these belong together. Use nested bullets to express those relationships. The source-length heading estimate is guidance only, never a numerical quota.
3. Preserve course overview and exam-strategy information that is actually spoken. Preserve instructor background only if explicitly stated in the transcript. Do not use the video description, YouTube metadata, prior AI drafts, or external knowledge to add facts.
4. Match the reference's information hierarchy: concise parent bullets state the point; nested bullets carry explanations, reasons, examples, analogies, operations, and qualifications. Do not promote every supporting detail to a top-level bullet.
5. Use bold bracketed labels sparingly. Most bullets should begin with plain text. Normally use one or two bracketed callouts per main topic heading at most; avoid labelling every definition, analogy, or conclusion. Do not create multiple labels for the same underlying idea.
6. Consolidate repeated wording across the entire capture. State each definition/formula/core conclusion once, then add distinct details under it. Preserve all distinct information; remove only true repetition and empty restatements. Do not pad the notes with repeated transitions or generic conclusions.
7. When three or more parallel examples illustrate the same abstract idea and their relationship is explicit in the source, include a compact Mermaid mindmap or flowchart that groups them beneath that idea. Use only source-supported labels/examples; do not force a diagram where no clear relationship exists.
8. No word-count ratio and no arbitrary compression target. Keep the note as concise as possible while retaining every distinct substantive point. Do not expand a source point into general textbook teaching.
9. Use a table, equation, code fence, Mermaid diagram, or blockquote only when supported and useful. Never invent code, formulas, complexity, examples, or a diagram's relationships.
10. Do not put timestamps in ordinary headings or bullets. Screenshots are restored by the extension.
11. Do not include YAML frontmatter or repeat the video title; the extension preserves both.
12. Do not include internal IDs, source-window codes, or synthetic marker tokens in the final document. Source provenance is tracked by the extension outside the generated Markdown.
13. Return only the Markdown body, without an introduction, conclusion about the video, or outer code fence.

FINAL COVERAGE AUDIT:
Before responding, compare the notes with every source packet and every source-window range. Preserve all distinct substantive teaching points across the entire captured interval. Do not satisfy coverage with generic wording or one vague bullet. The output must be comprehensive lecture notes in the supplied reference's style, not a summary.`;

    stage('final-render-start', {
      strategy: 'evidence-first-all-lengths',
      inputCharacters: evidence.length,
      sourceTranscriptCharacters: transcript.length,
      rawSourceTranscriptCharacters: rawTranscript.length,
      normalizedSourceTranscriptCharacters: transcript.length,
      sourcePacketCount: packets.length,
      coverageWindowCount: mappedWindowRecords.length,
      visualAssets: visualTokens.length,
      cachedVisualFrames: visualAssets.filter(asset => Boolean(asset?.dataUrl)).length,
      ignoredVideoDescriptionCharacters: String(videoDescription || '').length,
      ignoredSupplementaryVisualNotesCharacters: String(supplementaryVisualNotes || '').length,
      extractionCount,
      reductionCount
    });
    const renderStartedAt = performance.now();
    let generated = await this.generateNotesStream({
      videoTitle,
      currentTimestamp: `through ${stopTime || 'the captured stopping point'}`,
      transcriptChunk: '',
      modeLabel: 'Reference-calibrated source-grounded study-note rendering',
      promptOverride: finalPrompt,
      systemPromptOverride: systemPrompt,
      maxOutputTokens: 8192,
      signal,
      onDiagnostics: event => stage('final-render-attempt', event)
    });

    // A heading-per-time-window floor rejected coherent notes even when the
    // model had preserved the lecture. Validate basic document integrity here;
    // treat topic count and editorial form as recoverable style checks below.
    const validation = helpers.validateOutput(generated, transcript.length, {
      minimumRatio: 0.10,
      minimumCharacters: Math.min(9000, Math.max(500, Math.floor(transcript.length * 0.25))),
      minimumHeadings: 1,
      allowTimestampHeadings: true,
      requireNestedBullets: false,
      requireBoldLabels: false,
      requireHyphenBullets: true
    });
    if (!validation.valid) throw new Error(validation.reason);

    // Reference-style guard: the previous renderer treated the presence of at
    // least one callout as success, even when nearly every bullet was labelled.
    // Run one bounded editorial repair only when callout density is excessive.
    // The source-to-note semantic audit below then checks that this style pass
    // did not remove any distinct source-supported content.
    let candidateForAudit = validation.markdown;
    const initialStyleMetrics = helpers.measureReferenceStyle(candidateForAudit);
    const preferredHeadingCount = helpers.minimumTopicHeadings(lines, 30);
    const editorialWarnings = helpers.editorialStyleWarnings(candidateForAudit, preferredHeadingCount);
    stage('editorial-style-measured', {
      metrics: initialStyleMetrics,
      warnings: editorialWarnings
    });
    if (editorialWarnings.length) {
      const warningCodes = new Set(editorialWarnings.map(item => item.code));
      const recoveryInstructions = [];
      if (warningCodes.has('timestamp-led-headings')) recoveryInstructions.push('- Replace every timestamp-led section heading with a concise descriptive topic heading. Keep timestamps only for preserved screenshot anchors.');
      if (warningCodes.has('fewer-than-preferred-topic-headings')) recoveryInstructions.push('- Review whether several distinct teaching objectives are currently collapsed under broad headings. Split only genuinely distinct topics; do not create one heading per time interval or split a concept from its examples. The heuristic count is not a target quota.');
      if (warningCodes.has('missing-nested-hierarchy')) recoveryInstructions.push('- Restore the reference hierarchy: concise parent hyphen bullets followed by four-space nested bullets for explanations, reasons, examples, analogies and qualifications.');
      if (warningCodes.has('missing-selective-callouts')) recoveryInstructions.push('- Add a few bold bracketed labels only where they genuinely help identify a definition, teaching strategy or key insight. Most bullets must remain unlabelled.');
      if (warningCodes.has('excessive-bold-callouts')) recoveryInstructions.push('- Convert routine labelled bullets into plain statements. Retain only distinct, useful callouts (normally no more than two per main topic section).');
      const styleRepairPrompt = `EDITORIAL STRUCTURE RECOVERY — preserve the complete source meaning while aligning the candidate with the supplied HoverNotes formatting contract.

STYLE FINDINGS:
${JSON.stringify(editorialWarnings, null, 2)}

APPLY THESE TARGETED CORRECTIONS:
${recoveryInstructions.join('\n')}

REFERENCE STYLE REMINDERS:
- Group related material under coherent topic headings; combine headings that merely split a definition, its motivation, examples, and its implications.
- Use concise parent hyphen bullets and four-space nested bullets for supporting details.
- Use bold bracketed callouts selectively. Most bullets must be plain statements, not labelled callouts.
- Group parallel analogies/examples beneath the concept they explain. Add a compact Mermaid mindmap/flowchart when several source-stated examples clearly illustrate one common concept; do not add unsupported examples or categories.
- Keep the correct display equation, existing Mermaid diagrams, and screenshot placeholders if present.

SOURCE EVIDENCE — sole factual authority:
<lecture_evidence>
${evidence}
</lecture_evidence>

CURRENT CANDIDATE NOTES:
<candidate_notes>
${candidateForAudit}
</candidate_notes>

REFINEMENT RULES:
1. Preserve every distinct source-supported fact, explanation, reason, analogy, example, numerical detail, qualification, and teaching point. Do not shorten by deleting content.
2. Remove only repeated wording or repeated statements of the same point. Consolidate related sections and nested structure without losing distinctions.
3. Reduce excessive bracketed labels by converting routine labelled bullets into plain, direct statements. Keep only labels that meaningfully improve scanning.
4. Do not invent or import facts, examples, formulas, categories, or exam advice.
5. Keep source-supported equations, diagrams and visual placement markers. Do not delete screenshot placeholders.
6. Return the complete corrected Markdown body only. No frontmatter, title, explanation, JSON, or outer code fence.`;

      stage('editorial-repair-start', {
        warningCount: editorialWarnings.length,
        before: initialStyleMetrics
      });
      try {
        const styleRepaired = await this.generateNotesStream({
          videoTitle,
          currentTimestamp: `editorial refinement through ${stopTime || 'captured boundary'}`,
          transcriptChunk: '',
          modeLabel: 'Reference-style editorial refinement',
          promptOverride: styleRepairPrompt,
          systemPromptOverride: systemPrompt,
          maxOutputTokens: 8192,
          signal,
          onDiagnostics: event => stage('editorial-repair-attempt', event)
        });
        const finalHeadingFloor = coverageWindows.length >= 3 ? 2 : 1;
        const styleValidation = helpers.validateOutput(styleRepaired, transcript.length, {
          minimumRatio: 0.10,
          minimumCharacters: Math.min(9000, Math.max(500, Math.floor(transcript.length * 0.25))),
          minimumHeadings: finalHeadingFloor,
          requireNestedBullets: coverageWindows.length >= 3,
          requireBoldLabels: coverageWindows.length >= 3,
          requireHyphenBullets: true
        });
        const refinedMetrics = styleValidation.valid
          ? helpers.measureReferenceStyle(styleValidation.markdown)
          : null;
        const refinedWarnings = styleValidation.valid
          ? helpers.editorialStyleWarnings(styleValidation.markdown, preferredHeadingCount)
          : [];
        const initialWarningCodes = new Set(editorialWarnings.map(item => item.code));
        const refinedHardWarnings = refinedWarnings.filter(item => item.severity === 'hard');
        const headingImproved = !initialWarningCodes.has('fewer-than-preferred-topic-headings') ||
          refinedMetrics?.mainTopicHeadings > initialStyleMetrics.mainTopicHeadings ||
          refinedMetrics?.mainTopicHeadings >= preferredHeadingCount;
        const calloutsImproved = !initialWarningCodes.has('excessive-bold-callouts') ||
          (refinedMetrics && refinedMetrics.boldCallouts < initialStyleMetrics.boldCallouts);
        const styleRepairUseful = headingImproved && calloutsImproved && refinedHardWarnings.length === 0;
        if (styleValidation.valid && styleRepairUseful) {
          candidateForAudit = styleValidation.markdown;
          stage('editorial-repair-accepted', {
            before: initialStyleMetrics,
            after: refinedMetrics,
            preferredHeadingCount,
            remainingSoftWarnings: refinedWarnings.filter(item => item.severity !== 'hard'),
            outputCharacters: candidateForAudit.length
          });
        } else {
          const reason = !styleValidation.valid
            ? styleValidation.reason
            : refinedHardWarnings.length
              ? `The refined candidate still has hard editorial defects: ${refinedHardWarnings.map(item => item.code).join(', ')}.`
              : 'The refinement did not improve the measured structural issues; the original final render was retained.';
          stage('editorial-repair-not-applied', {
            reason,
            before: initialStyleMetrics,
            after: refinedMetrics,
            preferredHeadingCount,
            remainingStyleWarnings: refinedWarnings
          });
          const initialHardWarnings = editorialWarnings.filter(item => item.severity === 'hard');
          if (initialHardWarnings.length) throw new Error(`Editorial structure recovery failed: ${initialHardWarnings.map(item => item.code).join(', ')}. The original incremental draft was retained.`);
        }
      } catch (styleError) {
        if (signal?.aborted) throw styleError;
        stage('editorial-repair-failed', {
          reason: String(styleError?.message || styleError),
          fallback: 'original-final-render-retained'
        });
        const initialHardWarnings = editorialWarnings.filter(item => item.severity === 'hard');
        if (initialHardWarnings.length) {
          throw new Error(`Editorial structure recovery could not repair hard defects (${initialHardWarnings.map(item => item.code).join(', ')}): ${String(styleError?.message || styleError)}. The original incremental draft was retained.`);
        }
      }
    }

    // Run a separate second-pass comparison of the rendered note with the original transcript.
    // Deterministic source-window assignment proves provenance only; this review
    // checks whether the meaning of each original source segment survived.
    const auditBatches = helpers.buildSemanticAuditBatches(chunks, 3);
    const auditSystemPrompt = `You are a separate second-pass educational-content coverage reviewer using the same configured AI provider as the note writer. You must evaluate the candidate document critically; this is a separate review pass, not an independent third-party model.

SOURCE RULES:
- The timestamped transcript is the authoritative record of spoken lecture content.
- Attached original frames may support only clearly visible and legible slide content.
- Do not use video titles, descriptions, channel metadata, external knowledge, or assumptions.
- Treat instructor opinions, guarantees, and personal claims as claims, not verified facts.

AUDIT RULES:
- Identify substantive instructional or course-context points present in this source segment but absent or materially distorted in the candidate notes.
- Count a point as covered when its meaning is faithfully expressed, even if the wording, heading, or location differs.
- Do not flag greetings, filler, repeated wording, calls to like/subscribe/comment, or purely administrative chatter.
- Do retain meaningful course overview, teaching approach, prerequisites, syllabus scope, instructor-stated experience, motivation, conceptual framing, definitions, reasoning, examples, analogies, caveats, and exam context.
- Do not demand verbatim coverage or one note bullet per transcript cue. Group related ideas when nothing substantive is lost.
- For unsupported claims, report only a claim that is directly contradicted by this source segment or that clearly adds a specific fact that this segment itself disproves. Do not flag a claim merely because it is absent from this batch: it may be supported by another part of the lecture.
- Do not critique Markdown style here; this pass evaluates factual coverage only.

Return one valid JSON object and nothing else with this exact shape:
{"omissions":[{"missing_point":"accurate concise English statement of a missing source-supported point","source_excerpt":"short exact excerpt from supplied transcript","source_timestamp":"MM:SS"}],"unsupported_claims":[{"claim":"short exact excerpt from candidate notes","reason":"why supplied transcript and attached frames do not support it"}]}
If nothing is missing or unsupported, return {"omissions":[],"unsupported_claims":[]}. Do not add other keys.`;

    const runSemanticAudit = async (candidateMarkdown, passLabel) => {
      const findings = { omissions: [], unsupportedClaims: [], auditedBatchCount: 0 };
      for (const batch of auditBatches) {
        if (signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
        const batchVisualAssets = visualAssets.filter(asset => {
          if (!asset?.dataUrl || !Number.isFinite(batch.startTime) || !Number.isFinite(batch.endTime)) return false;
          const seconds = helpers.parseTimestampSeconds(`[${asset.timestamp || ''}]`);
          return seconds !== null && seconds >= batch.startTime && seconds <= batch.endTime;
        }).slice(0, 4);
        const visualManifestForAudit = batchVisualAssets.length
          ? batchVisualAssets.map(asset => `An original screenshot captured at ${asset.timestamp} is attached in the same order.`).join('\n')
          : '[No original screenshot is attached for this source batch.]';
        const auditPrompt = `SECOND-PASS SOURCE-TO-NOTE COVERAGE AUDIT

SOURCE RANGE: ${batch.startLabel}–${batch.endLabel}

ORIGINAL TIMESTAMPED TRANSCRIPT (primary evidence):
<source_transcript>
${batch.transcriptText}
</source_transcript>

ORIGINAL VISUAL EVIDENCE:
${visualManifestForAudit}

CANDIDATE FINAL STUDY NOTES (audit against this entire document; other sections may already cover this segment):
<candidate_notes>
${candidateMarkdown}
</candidate_notes>

Compare every substantive point in the source range with the entire candidate note. Report material omissions and only claims directly contradicted by the supplied source range. Do not label a claim unsupported merely because it is absent from this batch; it may be supported elsewhere in the lecture. A paraphrase under a different topic heading counts as covered. Do not flag a fact just because its exact timestamp is not printed. Do not require marketing calls-to-action or filler. Preserve course details and the instructor's explicitly stated background/claims when relevant, as the reference export does.

Return the exact JSON schema required by your system instructions. Empty arrays mean no findings. Do not use internal IDs or Markdown fences.`;

        const requestAudit = async (retry = false) => {
          const retryInstruction = retry
            ? '\n\nRETRY: The prior response was not valid JSON. Return exactly one syntactically valid JSON object with both required arrays. No prose, no Markdown fence.'
            : '';
          const raw = await this.generateNotesStream({
            videoTitle,
            currentTimestamp: `${batch.startLabel}–${batch.endLabel}`,
            transcriptChunk: batch.transcriptText,
            frameImages: batchVisualAssets.map(asset => asset.dataUrl),
            modeLabel: `Second-pass semantic coverage audit (${passLabel})`,
            promptOverride: auditPrompt + retryInstruction,
            systemPromptOverride: auditSystemPrompt,
            maxOutputTokens: 3072,
            signal,
            onDiagnostics: event => stage('semantic-audit-attempt', {
              pass: passLabel,
              batch: batch.index + 1,
              batchCount: auditBatches.length,
              sourceRange: `${batch.startLabel}–${batch.endLabel}`,
              retry,
              ...event
            })
          });
          return helpers.parseSemanticAuditResponse(raw);
        };

        let auditResult;
        try {
          auditResult = await requestAudit(false);
        } catch (firstAuditError) {
          if (signal?.aborted) throw firstAuditError;
          stage('semantic-audit-json-retry', {
            pass: passLabel,
            batch: batch.index + 1,
            sourceRange: `${batch.startLabel}–${batch.endLabel}`,
            reason: firstAuditError?.message || 'invalid audit response'
          });
          auditResult = await requestAudit(true);
        }

        findings.omissions.push(...auditResult.omissions.map(item => ({
          ...item,
          sourceRange: `${batch.startLabel}–${batch.endLabel}`,
          sourceTranscript: batch.transcriptText
        })));
        findings.unsupportedClaims.push(...auditResult.unsupportedClaims.map(item => ({
          ...item,
          sourceRange: `${batch.startLabel}–${batch.endLabel}`,
          sourceTranscript: batch.transcriptText
        })));
        findings.auditedBatchCount++;
        stage('semantic-audit-batch-complete', {
          pass: passLabel,
          batch: batch.index + 1,
          batchCount: auditBatches.length,
          sourceRange: `${batch.startLabel}–${batch.endLabel}`,
          omissionCount: auditResult.omissions.length,
          unsupportedClaimCount: auditResult.unsupportedClaims.length
        });
      }
      return findings;
    };

    let semanticAudit = await runSemanticAudit(candidateForAudit, 'initial');
    stage('semantic-audit-complete', {
      pass: 'initial',
      auditedBatchCount: semanticAudit.auditedBatchCount,
      omissionCount: semanticAudit.omissions.length,
      unsupportedClaimCount: semanticAudit.unsupportedClaims.length
    });

    let finalBody = candidateForAudit;
    let semanticRepairCount = 0;
    if (semanticAudit.omissions.length || semanticAudit.unsupportedClaims.length) {
      const repairFindings = {
        omissions: semanticAudit.omissions.map(({ point, sourceExcerpt, sourceTimestamp, sourceRange }) => ({ point, sourceExcerpt, sourceTimestamp, sourceRange })),
        unsupportedClaims: semanticAudit.unsupportedClaims.map(({ point, reason, sourceRange }) => ({ claim: point, reason, sourceRange }))
      };
      const repairSourceRanges = [...new Set([
        ...semanticAudit.omissions.map(item => item.sourceRange),
        ...semanticAudit.unsupportedClaims.map(item => item.sourceRange)
      ])];
      const repairSourceText = auditBatches
        .filter(batch => repairSourceRanges.includes(`${batch.startLabel}–${batch.endLabel}`))
        .map(batch => `### Original source ${batch.startLabel}–${batch.endLabel}\n${batch.transcriptText}`)
        .join('\n\n');
      const repairPrompt = `TARGETED SEMANTIC REPAIR OF THE CANDIDATE STUDY NOTES

The second-pass source-to-note audit found the following issues. Repair only these issues while preserving all already-correct content and the reference style.

AUDIT FINDINGS (JSON):
${JSON.stringify(repairFindings, null, 2)}

RELEVANT ORIGINAL SOURCE SEGMENTS:
<original_sources>
${repairSourceText}
</original_sources>

CURRENT CANDIDATE DOCUMENT:
<candidate_notes>
${finalBody}
</candidate_notes>

REPAIR RULES:
1. Add every listed missing point only when supported by the quoted original transcript. Incorporate it under the most relevant existing concept heading; create a new topic heading only if no existing heading fits.
2. Remove or correct each listed unsupported claim. Do not remove a claim if the supplied source actually supports it; the source excerpts take precedence over the audit's interpretation.
3. Do not rewrite, shorten, summarize, reorder, or delete unrelated correct material.
4. Preserve nested hyphen bullets and use bold bracketed concept labels selectively (normally no more than two per main topic heading), along with equations, tables, code, Mermaid diagrams, and screenshot placement hints where still relevant. Consolidate repeated headings and concepts without deleting distinct source details.
5. Do not add outside knowledge or make claims beyond the supplied source.
6. Return the complete corrected Markdown body only, with no frontmatter, title, explanation, JSON, or outer code fence.`;

      const repaired = await this.generateNotesStream({
        videoTitle,
        currentTimestamp: `semantic repair through ${stopTime || 'captured boundary'}`,
        transcriptChunk: repairSourceText,
        modeLabel: 'Targeted semantic coverage repair',
        promptOverride: repairPrompt,
        systemPromptOverride: systemPrompt,
        maxOutputTokens: 8192,
        signal,
        onDiagnostics: event => stage('semantic-repair-attempt', event)
      });
      const repairedValidation = helpers.validateOutput(repaired, transcript.length, {
        minimumRatio: 0.10,
        minimumCharacters: Math.min(9000, Math.max(500, Math.floor(transcript.length * 0.25))),
        minimumHeadings: coverageWindows.length >= 3 ? 2 : 1,
        requireNestedBullets: coverageWindows.length >= 3,
        requireBoldLabels: coverageWindows.length >= 3,
        requireHyphenBullets: true
      });
      if (!repairedValidation.valid) throw new Error(`Semantic repair returned structurally invalid notes: ${repairedValidation.reason}`);
      finalBody = repairedValidation.markdown;
      semanticRepairCount = 1;
      stage('semantic-repair-complete', {
        outputCharacters: finalBody.length,
        repairedOmissionCount: semanticAudit.omissions.length,
        removedUnsupportedClaimCount: semanticAudit.unsupportedClaims.length
      });

      const verificationAudit = await runSemanticAudit(finalBody, 'post-repair-verification');
      stage('semantic-audit-complete', {
        pass: 'post-repair-verification',
        auditedBatchCount: verificationAudit.auditedBatchCount,
        omissionCount: verificationAudit.omissions.length,
        unsupportedClaimCount: verificationAudit.unsupportedClaims.length
      });
      if (verificationAudit.omissions.length || verificationAudit.unsupportedClaims.length) {
        throw new Error(`Second-pass semantic audit still found ${verificationAudit.omissions.length} omissions and ${verificationAudit.unsupportedClaims.length} unsupported claims after one repair pass. The original incremental draft was retained.`);
      }
      semanticAudit = verificationAudit;
    }

    stage('semantic-coverage-accepted', {
      auditedBatchCount: semanticAudit.auditedBatchCount,
      semanticRepairCount,
      remainingOmissions: 0,
      remainingUnsupportedClaims: 0
    });
    const cleanBody = helpers.stripInternalMarkers(finalBody, visualTokens);
    if (cleanBody.length < Math.min(600, Math.max(250, Math.floor(transcript.length * 0.20)))) throw new Error('The final document was unexpectedly short after source and screenshot metadata cleanup. The original draft was retained.');
    stage('final-render-complete', {
      durationMs: Math.round(performance.now() - renderStartedAt),
      totalPipelineMs: Math.round(performance.now() - startedAt),
      outputCharacters: cleanBody.length,
      sourceTranscriptCharacters: transcript.length,
      rawSourceTranscriptCharacters: rawTranscript.length,
      extractionCount,
      reductionCount,
      coverageWindowCount: coverageWindows.length,
      mappedSourceWindowCount: mappedWindowRecords.length,
      semanticAuditBatchCount: semanticAudit.auditedBatchCount,
      semanticRepairCount,
      referenceStyleMetrics: helpers.measureReferenceStyle(cleanBody),
      semanticValidation: 'passed',
      validation: 'passed'
    });
    return cleanBody;
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
  async streamGeminiSSE({ apiKey, model, promptText, frameBase64, frameImages = [], onChunk, onComplete, onDiagnostics, signal, systemPrompt = this.systemPrompt, maxOutputTokens = 8192, returnMetadata = false }) {
    const requestStartedAt = performance.now();
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;

    const parts = [{ text: promptText }];

    const imageInputs = [
      ...(Array.isArray(frameImages) ? frameImages : []),
      ...(frameBase64 ? [frameBase64] : [])
    ].filter(Boolean).slice(0, 4);
    for (const imageInput of imageInputs) {
      const mimeMatch = String(imageInput).match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,/i);
      const cleanBase64 = String(imageInput).replace(/^data:image\/(png|jpeg|jpg|webp);base64,/i, '');
      parts.push({ inlineData: { mimeType: mimeMatch?.[1] || 'image/jpeg', data: cleanBase64 } });
    }

    const payload = {
      contents: [{ role: 'user', parts }],
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens,
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
    let finishReason = null;
    let finishMessage = null;
    let blockReason = null;
    let safetyRatings = null;
    let usageMetadata = null;
    let eventCount = 0;
    let textChunkCount = 0;
    let streamEndedNormally = false;
    let receivedDoneMarker = false;
    let readerReachedEof = false;

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
      if (done) {
        readerReachedEof = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep uncompleted remainder

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.substring(6).trim();
          if (jsonStr === '[DONE]') {
            receivedDoneMarker = true;
            continue;
          }
          eventCount++;
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.candidates?.[0]?.finishReason) finishReason = parsed.candidates[0].finishReason;
            if (parsed.candidates?.[0]?.finishMessage) finishMessage = parsed.candidates[0].finishMessage;
            if (parsed.candidates?.[0]?.safetyRatings) safetyRatings = parsed.candidates[0].safetyRatings;
            if (parsed.promptFeedback?.blockReason) blockReason = parsed.promptFeedback.blockReason;
            if (parsed.promptFeedback?.safetyRatings) safetyRatings = parsed.promptFeedback.safetyRatings;
            if (parsed.usageMetadata) usageMetadata = parsed.usageMetadata;

            const deltaText = (parsed.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('');
            if (deltaText) {
              textChunkCount++;
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
      if (jsonStr === '[DONE]') {
        receivedDoneMarker = true;
      } else if (jsonStr) {
        eventCount++;
        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed.candidates?.[0]?.finishReason) finishReason = parsed.candidates[0].finishReason;
          if (parsed.candidates?.[0]?.finishMessage) finishMessage = parsed.candidates[0].finishMessage;
          if (parsed.candidates?.[0]?.safetyRatings) safetyRatings = parsed.candidates[0].safetyRatings;
          if (parsed.promptFeedback?.blockReason) blockReason = parsed.promptFeedback.blockReason;
          if (parsed.promptFeedback?.safetyRatings) safetyRatings = parsed.promptFeedback.safetyRatings;
          if (parsed.usageMetadata) usageMetadata = parsed.usageMetadata;

          const tailText = (parsed.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('');
          if (tailText) {
            textChunkCount++;
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
    streamEndedNormally = readerReachedEof;

    const isTruncated = finishReason === 'MAX_TOKENS';
    const isSafetyBlocked = blockReason !== null || finishReason === 'SAFETY';
    const hasExplicitFinishReason = finishReason !== null;
    const hasTerminalSignal = hasExplicitFinishReason || receivedDoneMarker;
    const isComplete = hasTerminalSignal && !isTruncated && !isSafetyBlocked;
    const completionStatus = isSafetyBlocked
      ? 'blocked'
      : isTruncated
        ? 'truncated'
        : hasExplicitFinishReason
          ? (finishReason === 'STOP' ? 'completed' : 'finished_with_reason')
          : receivedDoneMarker
            ? 'done_marker_without_finish_reason'
            : 'unknown_completion';
    const responseMetadata = {
      finishReason,
      hasExplicitFinishReason,
      receivedDoneMarker,
      hasTerminalSignal,
      isComplete,
      completionStatus,
      finishMessage,
      blockReason,
      safetyRatings,
      usageMetadata,
      eventCount,
      textChunkCount,
      streamEndedNormally,
      readerReachedEof,
      isTruncated,
      errorCode: isTruncated ? 'MAX_TOKENS' : (isSafetyBlocked ? 'SAFETY_BLOCKED' : null),
      totalRequestMs: Math.round(performance.now() - requestStartedAt)
    };

    if (isSafetyBlocked) {
      const safetyErr = new Error(`Gemini response was blocked by safety policy (${blockReason || finishReason}).`);
      safetyErr.name = 'SafetyBlockError';
      safetyErr.code = 'SAFETY_BLOCKED';
      safetyErr.metadata = responseMetadata;
      throw safetyErr;
    }

    if (!accumulatedText.trim() && !signal?.aborted) {
      const emptyErr = new Error('Gemini response was empty.');
      emptyErr.name = 'EmptyResponseError';
      emptyErr.code = 'EMPTY_RESPONSE';
      emptyErr.metadata = responseMetadata;
      throw emptyErr;
    }

    this.emitDiagnostics(onDiagnostics, {
      type: 'stream-complete',
      provider: 'gemini',
      model,
      httpStatus: response.status,
      responseHeadersMs,
      firstTokenMs,
      totalRequestMs: responseMetadata.totalRequestMs,
      generatedCharacters: accumulatedText.length,
      finishReason: responseMetadata.finishReason,
      completionStatus: responseMetadata.completionStatus,
      hasTerminalSignal: responseMetadata.hasTerminalSignal,
      isComplete: responseMetadata.isComplete,
      blockReason: responseMetadata.blockReason,
      usageMetadata: responseMetadata.usageMetadata,
      isTruncated: responseMetadata.isTruncated,
      eventCount: responseMetadata.eventCount,
      textChunkCount: responseMetadata.textChunkCount,
      streamEndedNormally: responseMetadata.streamEndedNormally
    });
    this.lastResponseMetadata = responseMetadata;
    if (onComplete) onComplete(accumulatedText);
    return returnMetadata ? { text: accumulatedText, metadata: responseMetadata } : accumulatedText;
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
  async streamOpenAIExtension({ promptText, frameBase64, frameImages = [], onChunk, onComplete, onDiagnostics, signal, systemPrompt = this.systemPrompt, maxOutputTokens = 4096, returnMetadata = false }) {
    const requestStartedAt = performance.now();
    let endpoint = this.customEndpointUrl.replace(/\/+$/, '');
    if (!endpoint.endsWith('/chat/completions')) endpoint += '/chat/completions';

    const userContent = [{ type: 'text', text: promptText }];
    const imageInputs = [
      ...(Array.isArray(frameImages) ? frameImages : []),
      ...(frameBase64 ? [frameBase64] : [])
    ].filter(Boolean).slice(0, 4);
    for (const imageInput of imageInputs) {
      const dataUri = String(imageInput).startsWith('data:') ? imageInput : `data:image/jpeg;base64,${imageInput}`;
      userContent.push({ type: 'image_url', image_url: { url: dataUri } });
    }

    const payload = {
      model: this.customModel || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      stream: true,
      max_tokens: Math.min(8192, Math.max(1024, Number(maxOutputTokens) || 4096)),
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
    let finishReason = null;
    let usageMetadata = null;
    let eventCount = 0;
    let textChunkCount = 0;
    let streamEndedNormally = false;
    let receivedDoneMarker = false;
    let readerReachedEof = false;

    while (true) {
      if (signal?.aborted) {
        try { await reader.cancel(); } catch (e) {}
        throw new DOMException('Generation cancelled.', 'AbortError');
      }
      let readResult;
      try {
        readResult = await reader.read();
      } catch (readError) {
        throw signal?.aborted ? new DOMException('Generation cancelled.', 'AbortError') : readError;
      }
      const { value, done } = readResult;
      if (done) {
        readerReachedEof = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.substring(6).trim();
          if (jsonStr === '[DONE]') {
            receivedDoneMarker = true;
            continue;
          }
          eventCount++;
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.choices?.[0]?.finish_reason) {
              const fr = parsed.choices[0].finish_reason;
              finishReason = fr === 'length' ? 'MAX_TOKENS' : (fr === 'stop' ? 'STOP' : fr);
            }
            if (parsed.usage) usageMetadata = parsed.usage;

            const delta = parsed.choices?.[0]?.delta?.content || '';
            const deltaText = typeof delta === 'string' ? delta : (Array.isArray(delta) ? delta.map(part => part.text || '').join('') : '');
            if (deltaText) {
              textChunkCount++;
              if (firstTokenMs === null) {
                
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
      if (jsonStr === '[DONE]') {
        receivedDoneMarker = true;
      } else if (jsonStr) {
        eventCount++;
        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed.choices?.[0]?.finish_reason) {
            const fr = parsed.choices[0].finish_reason;
            finishReason = fr === 'length' ? 'MAX_TOKENS' : (fr === 'stop' ? 'STOP' : fr);
          }
          if (parsed.usage) usageMetadata = parsed.usage;

          const delta = parsed.choices?.[0]?.delta?.content || '';
          const tailText = typeof delta === 'string' ? delta : (Array.isArray(delta) ? delta.map(part => part.text || '').join('') : '');
          if (tailText) {
            textChunkCount++;
            if (firstTokenMs === null) {
              
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
    
    streamEndedNormally = readerReachedEof;

    const isTruncated = finishReason === 'MAX_TOKENS';
    const hasExplicitFinishReason = finishReason !== null;
    const hasTerminalSignal = hasExplicitFinishReason || receivedDoneMarker;
    const isComplete = hasTerminalSignal && !isTruncated;
    const completionStatus = isTruncated
      ? 'truncated'
      : hasExplicitFinishReason
        ? (finishReason === 'STOP' ? 'completed' : 'finished_with_reason')
        : receivedDoneMarker
          ? 'done_marker_without_finish_reason'
          : 'unknown_completion';
    const responseMetadata = {
      finishReason,
      hasExplicitFinishReason,
      receivedDoneMarker,
      hasTerminalSignal,
      isComplete,
      completionStatus,
      usageMetadata,
      eventCount,
      textChunkCount,
      streamEndedNormally,
      readerReachedEof,
      isTruncated,
      errorCode: isTruncated ? 'MAX_TOKENS' : null,
      totalRequestMs: Math.round(performance.now() - requestStartedAt)
    };

    if (!accumulatedText.trim() && !signal?.aborted) {
      const emptyErr = new Error('Custom endpoint response was empty.');
      emptyErr.name = 'EmptyResponseError';
      emptyErr.code = 'EMPTY_RESPONSE';
      emptyErr.metadata = responseMetadata;
      throw emptyErr;
    }

    this.emitDiagnostics(onDiagnostics, {
      type: 'stream-complete',
      provider: 'openai-compatible',
      model: this.customModel || 'gpt-4o-mini',
      httpStatus: response.status,
      responseHeadersMs,
      firstTokenMs,
      totalRequestMs: responseMetadata.totalRequestMs,
      generatedCharacters: accumulatedText.length,
      finishReason: responseMetadata.finishReason,
      completionStatus: responseMetadata.completionStatus,
      hasTerminalSignal: responseMetadata.hasTerminalSignal,
      isComplete: responseMetadata.isComplete,
      usageMetadata: responseMetadata.usageMetadata,
      isTruncated: responseMetadata.isTruncated,
      eventCount: responseMetadata.eventCount,
      textChunkCount: responseMetadata.textChunkCount,
      streamEndedNormally: responseMetadata.streamEndedNormally
    });
    this.lastResponseMetadata = responseMetadata;
    if (onComplete) onComplete(accumulatedText);
    return returnMetadata ? { text: accumulatedText, metadata: responseMetadata } : accumulatedText;
  }
}

// Global instance for sidebar
window.geminiClient = new GeminiAIClient();
