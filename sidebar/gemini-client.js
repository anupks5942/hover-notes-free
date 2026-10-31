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
