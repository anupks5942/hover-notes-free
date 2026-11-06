/**
 * HoverNotes source-grounded synthesis helpers.
 * Pure helpers only: no storage, network, filesystem, or API-key access.
 */
(() => {
  function readYamlTitle(frontmatter) {
    const match = String(frontmatter || '').match(/^\s*title:\s*(.*?)\s*$/m);
    if (!match) return '';
    const scalar = match[1].trim();
    if (!scalar) return '';
    if (scalar.startsWith('"') && scalar.endsWith('"')) {
      try { return String(JSON.parse(scalar)); } catch (_) { return scalar.slice(1, -1); }
    }
    if (scalar.startsWith("'") && scalar.endsWith("'")) {
      return scalar.slice(1, -1).replace(/''/g, "'");
    }
    return scalar;
  }

  function removeDuplicateTitleH1(preamble) {
    const lines = String(preamble || '').split('\n');
    const hasFrontmatter = lines[0]?.trim() === '---';
    if (!hasFrontmatter) return { preamble: lines.join('\n').trimEnd(), removed: false };
    const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (closingIndex < 0) return { preamble: lines.join('\n').trimEnd(), removed: false };
    const title = readYamlTitle(lines.slice(1, closingIndex).join('\n')).trim();
    if (!title) return { preamble: lines.join('\n').trimEnd(), removed: false };
    const headingIndex = lines.findIndex((line, index) => index > closingIndex && /^#\s+/.test(line));
    if (headingIndex < 0) return { preamble: lines.join('\n').trimEnd(), removed: false };
    const headingTitle = lines[headingIndex].replace(/^#\s+/, '').trim();
    // YouTube-derived frontmatter titles commonly append " - YouTube" while
    // the body heading uses the display title without that metadata suffix.
    const normalizeTitle = value => String(value || '').trim().replace(/\s+-\s+YouTube\s*$/i, '').trim();
    if (normalizeTitle(headingTitle) !== normalizeTitle(title)) {
      return { preamble: lines.join('\n').trimEnd(), removed: false };
    }
    lines.splice(headingIndex, 1);
    while (headingIndex < lines.length && !lines[headingIndex].trim() && headingIndex > closingIndex + 1) {
      lines.splice(headingIndex, 1);
    }
    return { preamble: lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd(), removed: true };
  }

  function splitDocument(markdown) {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    // YAML title is the document title. Remove a body H1 only when it exactly
    // duplicates that metadata; preserve distinct headings and all other prose.
    const bodyStart = lines.findIndex((line, index) => index > 0 && /^#{2,6}\s+/.test(line));
    if (bodyStart < 0) return { preamble: lines.join('\n').trimEnd(), body: '' };
    const cleaned = removeDuplicateTitleH1(lines.slice(0, bodyStart).join('\n'));
    return {
      preamble: cleaned.preamble,
      body: lines.slice(bodyStart).join('\n').trim(),
      removedDuplicateTitle: cleaned.removed
    };
  }


  /**
   * Remove only duplicated YouTube timestamp-link wrappers from cue lines.
   * Timestamps and spoken text remain unchanged and in their original order.
   */
  function normalizeTranscriptForAI(transcript) {
    return String(transcript || '').replace(/\r\n?/g, '\n').split('\n').map(line => {
      return line.replace(/^(\s*\[(?:\d{1,3}:)?\d{2}:\d{2}\])(?:\(https?:\/\/[^)]+\)){1,2}\s*/, '$1 ');
    }).join('\n').trim();
  }

  function parseTimestampSeconds(line) {
    const match = String(line || '').match(/^\s*\[(?:(\d{1,3}):)?(\d{2}):(\d{2})\]/);
    if (!match) return null;
    const hours = Number(match[1] || 0);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    if (minutes > 59 || seconds > 59) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }

  function formatTimestamp(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(value / 3600);
    const m = Math.floor((value % 3600) / 60);
    const s = value % 60;
    return h > 0
      ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  /**
   * Split timed transcript cues into bounded chunks without dropping, reordering,
   * or splitting a cue. The original timestamped lines are preserved verbatim.
   */
  function chunkTranscriptLines(lines, maxCharacters = 12000) {
    const sourceLines = (Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/))
      .map(line => String(line)).filter(line => line.trim());
    const limit = Math.max(1000, Number(maxCharacters) || 12000);
    const chunks = [];
    let current = [];
    let currentCharacters = 0;

    const flush = () => {
      if (!current.length) return;
      const start = parseTimestampSeconds(current[0]);
      const last = [...current].reverse().find(line => parseTimestampSeconds(line) !== null);
      const end = last ? parseTimestampSeconds(last) : start;
      chunks.push({
        index: chunks.length,
        startTime: start,
        endTime: end,
        startLabel: start === null ? null : formatTimestamp(start),
        endLabel: end === null ? null : formatTimestamp(end),
        lines: current,
        transcriptText: current.join('\n'),
        characterCount: currentCharacters
      });
      current = [];
      currentCharacters = 0;
    };

    for (const line of sourceLines) {
      const lineLength = line.length + (current.length ? 1 : 0);
      if (current.length && currentCharacters + lineLength > limit) flush();
      current.push(line);
      currentCharacters += line.length + (current.length > 1 ? 1 : 0);
    }
    flush();
    return chunks;
  }

  function chunkKnowledgeBlocks(blocks, maxCharacters = 26000) {
    const sourceBlocks = (Array.isArray(blocks) ? blocks : []).map(String).filter(x => x.trim());
    const limit = Math.max(4000, Number(maxCharacters) || 26000);
    const groups = [];
    let current = [];
    let length = 0;
    for (const block of sourceBlocks) {
      const blockLength = block.length + (current.length ? 2 : 0);
      if (current.length && length + blockLength > limit) {
        groups.push(current);
        current = [];
        length = 0;
      }
      current.push(block);
      length += block.length + (current.length > 1 ? 2 : 0);
    }
    if (current.length) groups.push(current);
    return groups;
  }

  function protectManagedScreenshotBlocks(markdown) {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    const assets = [];
    const anchorPattern = /^\s*(?:###\s+|\*\*)?\[((?:\d{1,3}:)?\d{2}:\d{2})\]\((https?:\/\/[^)]+)\)(?:\*\*)?\s*$/;
    const imagePattern = /^\s*(!\[\[HoverNotes\/images\/[^\]]+\]\])\s*$/;

    for (let index = 0; index < lines.length; index++) {
      const anchor = lines[index].match(anchorPattern);
      if (!anchor) {
        output.push(lines[index]);
        continue;
      }
      let imageIndex = index + 1;
      while (imageIndex < lines.length && !lines[imageIndex].trim()) imageIndex++;
      const image = imageIndex < lines.length ? lines[imageIndex].match(imagePattern) : null;
      if (!image) {
        output.push(lines[index]);
        continue;
      }
      const token = `[[HN_VISUAL_ASSET_${String(assets.length + 1).padStart(2, '0')}]]`;
      assets.push({ token, timestamp: anchor[1], url: anchor[2], imageLine: image[1] });
      output.push(token);
      index = imageIndex;
    }
    return { markdown: output.join('\n').replace(/\n{3,}/g, '\n\n').trim(), assets };
  }

  function restoreManagedScreenshotBlocks(markdown, assets) {
    let result = String(markdown || '').trim();
    const missing = [];
    for (const asset of assets || []) {
      const block = `**[${asset.timestamp}](${asset.url})**\n${asset.imageLine}`;
      const escaped = asset.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const tokenPattern = new RegExp(escaped, 'g');
      const occurrences = result.match(tokenPattern)?.length || 0;
      if (occurrences === 0) {
        missing.push(block);
        continue;
      }
      let first = true;
      result = result.replace(tokenPattern, () => {
        if (first) { first = false; return block; }
        return '';
      });
    }
    if (missing.length) result += `\n\n### Visual References\n\n${missing.join('\n\n')}`;
    return result.replace(/\n{3,}/g, '\n\n').trim();
  }


  /**
   * Extract small context windows around selected visual anchors. This retains
   * slide-derived details from the live draft as a secondary hint without
   * allowing the lossy incremental draft to replace the original transcript.
   */
  function extractVisualContext(markdown, assets, maxCharacters = 16000) {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    const tokens = (Array.isArray(assets) ? assets : []).map(asset => String(asset?.token || '')).filter(Boolean);
    if (!tokens.length || !lines.length) return '';

    const selected = new Set();
    for (const token of tokens) {
      const index = lines.findIndex(line => line.includes(token));
      if (index < 0) continue;
      let heading = index;
      while (heading > 0 && !/^#{2,4}\s+/.test(lines[heading])) heading--;
      const start = Math.max(heading, index - 8);
      const end = Math.min(lines.length, index + 9);
      for (let i = start; i < end; i++) selected.add(i);
    }

    const ordered = [...selected].sort((a, b) => a - b);
    const sections = [];
    let current = [];
    let previous = -2;
    for (const index of ordered) {
      if (index > previous + 1 && current.length) {
        sections.push(current.join('\n'));
        current = [];
      }
      current.push(lines[index]);
      previous = index;
    }
    if (current.length) sections.push(current.join('\n'));

    let result = sections.join('\n\n').replace(/\[\[HN_VISUAL_ASSET_\d{2}\]\]/g, '').trim();
    const limit = Math.max(1000, Number(maxCharacters) || 16000);
    if (result.length > limit) {
      // Context is supplementary only; truncate on a line boundary and record
      // the exact retained character count in diagnostics at the call site.
      const bounded = result.slice(0, limit);
      const lastNewline = bounded.lastIndexOf('\n');
      result = (lastNewline > limit * 0.7 ? bounded.slice(0, lastNewline) : bounded).trim();
    }
    return result;
  }


  /**
   * Build deterministic 30-second source windows from the original cue lines.
   * Their provenance is maintained by extension code, not by model-generated
   * marker strings that can be omitted or paraphrased.
   */
  function buildCoverageWindows(lines, intervalSeconds = 30) {
    const interval = Math.max(15, Math.min(120, Number(intervalSeconds) || 30));
    const buckets = new Map();
    const sourceLines = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
    for (const line of sourceLines) {
      const seconds = parseTimestampSeconds(line);
      if (seconds === null) continue;
      const bucket = Math.floor(seconds / interval);
      if (!buckets.has(bucket)) buckets.set(bucket, { bucket, startSeconds: bucket * interval, endSeconds: bucket * interval + interval - 1, cueCount: 0 });
      buckets.get(bucket).cueCount++;
    }
    return [...buckets.values()].sort((a, b) => a.bucket - b.bucket).map((item, index) => ({
      ...item,
      index,
      startLabel: formatTimestamp(item.startSeconds),
      endLabel: formatTimestamp(item.endSeconds),
      windowId: `window-${String(index + 1).padStart(4, '0')}`
    }));
  }

  /**
   * Verify deterministic source-to-packet coverage without asking the model to
   * reproduce machine-generated tokens. Provenance belongs to extension code,
   * not generated prose.
   */
  function validateCoverageAssignment(chunks, windows, intervalSeconds = 30) {
    const interval = Math.max(15, Math.min(120, Number(intervalSeconds) || 30));
    const sourceChunks = Array.isArray(chunks) ? chunks : [];
    const sourceWindows = Array.isArray(windows) ? windows : [];
    const assigned = [];
    for (const chunk of sourceChunks) {
      const bucketIds = new Set((chunk?.lines || []).map(line => {
        const seconds = parseTimestampSeconds(line);
        return seconds === null ? null : Math.floor(seconds / interval);
      }).filter(value => value !== null));
      for (const window of sourceWindows) {
        if (bucketIds.has(window.bucket)) assigned.push(window.windowId);
      }
    }
    const counts = new Map();
    for (const id of assigned) counts.set(id, (counts.get(id) || 0) + 1);
    const missing = sourceWindows.filter(window => !counts.has(window.windowId)).map(window => window.windowId);
    const duplicated = [...counts.entries()].filter(([, count]) => count !== 1).map(([id]) => id);
    return { valid: missing.length === 0 && duplicated.length === 0, assigned, missing, duplicated };
  }

  function minimumTopicHeadings(lines, intervalSeconds = 30) {
    const windows = buildCoverageWindows(lines, intervalSeconds);
    // This is a soft editorial prompt target, not a validity floor. Real
    // lectures vary: one concept may span several minutes, while several
    // distinct concepts may appear close together. Never reject a complete
    // note solely because it has fewer headings than this estimate.
    return Math.max(1, Math.min(48, Math.ceil(windows.length / 3)));
  }

  /**
   * Chunk cues without splitting a 30-second source window across packets.
   * This lets extension code associate each window with exactly one packet.
   */
  function chunkTranscriptByTimeWindows(lines, maxCharacters = 5200, intervalSeconds = 30) {
    const sourceLines = (Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/))
      .map(line => String(line)).filter(line => line.trim());
    const interval = Math.max(15, Math.min(120, Number(intervalSeconds) || 30));
    const limit = Math.max(1000, Number(maxCharacters) || 5200);
    const buckets = new Map();
    for (const line of sourceLines) {
      const seconds = parseTimestampSeconds(line);
      const bucket = seconds === null ? (buckets.size ? [...buckets.keys()].at(-1) : 0) : Math.floor(seconds / interval);
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket).push(line);
    }
    const chunks = [];
    let current = [];
    let currentCharacters = 0;
    const flush = () => {
      if (!current.length) return;
      const firstCueSeconds = parseTimestampSeconds(current[0]);
      const last = [...current].reverse().find(line => parseTimestampSeconds(line) !== null);
      const lastCueSeconds = last ? parseTimestampSeconds(last) : firstCueSeconds;
      const start = firstCueSeconds === null ? null : Math.floor(firstCueSeconds / interval) * interval;
      const end = lastCueSeconds === null ? start : Math.floor(lastCueSeconds / interval) * interval + interval - 1;
      chunks.push({
        index: chunks.length,
        startTime: start,
        endTime: end,
        startLabel: start === null ? null : formatTimestamp(start),
        endLabel: end === null ? null : formatTimestamp(end),
        lines: current,
        transcriptText: current.join('\n'),
        characterCount: currentCharacters
      });
      current = [];
      currentCharacters = 0;
    };
    for (const bucketLines of buckets.values()) {
      const bucketLength = bucketLines.reduce((sum, line) => sum + line.length + 1, 0);
      if (current.length && currentCharacters + bucketLength > limit) flush();
      current.push(...bucketLines);
      currentCharacters += bucketLength;
    }
    flush();
    return chunks;
  }

  /**
   * Split transcript chunks into bounded second-pass audit batches. Each batch
   * is associated with its exact source text by extension code, not model IDs.
   */
  function buildSemanticAuditBatches(chunks, maxChunksPerBatch = 3) {
    const source = Array.isArray(chunks) ? chunks : [];
    const batchSize = Math.max(1, Math.min(5, Number(maxChunksPerBatch) || 3));
    const batches = [];
    for (let index = 0; index < source.length; index += batchSize) {
      const group = source.slice(index, index + batchSize);
      const first = group[0];
      const last = group[group.length - 1];
      batches.push({
        index: batches.length,
        chunks: group,
        startTime: first?.startTime ?? null,
        endTime: last?.endTime ?? null,
        startLabel: first?.startLabel || 'unknown',
        endLabel: last?.endLabel || 'unknown',
        transcriptText: group.map(chunk => chunk.transcriptText || (chunk.lines || []).join('\n')).filter(Boolean).join('\n')
      });
    }
    return batches;
  }

  /**
   * Parse the second-pass semantic reviewer response. Accept a JSON object
   * wrapped in a Markdown fence or brief surrounding prose, but require the
   * two finding arrays so malformed/empty model output cannot silently pass.
   */
  function parseSemanticAuditResponse(responseText) {
    const source = String(responseText || '').trim();
    if (!source) throw new Error('Semantic coverage audit returned an empty response.');

    const candidates = [];
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) candidates.push(fenced[1].trim());

    const firstBrace = source.indexOf('{');
    if (firstBrace >= 0) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = firstBrace; index < source.length; index++) {
        const char = source[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') depth++;
        else if (char === '}') {
          depth--;
          if (depth === 0) {
            candidates.push(source.slice(firstBrace, index + 1));
            break;
          }
        }
      }
    }

    let parsed = null;
    for (const candidate of candidates) {
      try { parsed = JSON.parse(candidate); break; } catch (_) { /* Try next bounded JSON candidate. */ }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Semantic coverage audit did not return a parseable JSON object.');
    }

    const omissions = parsed.omissions ?? parsed.missing_points ?? parsed.missingPoints;
    const unsupported = parsed.unsupported_claims ?? parsed.unsupportedClaims ?? parsed.unsupported;
    if (!Array.isArray(omissions) || !Array.isArray(unsupported)) {
      throw new Error('Semantic coverage audit JSON is missing the required omissions and unsupported_claims arrays.');
    }

    const normalizeFinding = (item, kind) => {
      if (typeof item === 'string') {
        const value = item.trim();
        return value ? { point: value.slice(0, 1200), sourceExcerpt: '', sourceTimestamp: '', reason: '' } : null;
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const point = String(
        kind === 'omission'
          ? (item.missing_point ?? item.missingPoint ?? item.point ?? item.description ?? '')
          : (item.claim ?? item.note_excerpt ?? item.noteExcerpt ?? item.point ?? item.description ?? '')
      ).trim();
      if (!point) return null;
      return {
        point: point.slice(0, 1200),
        sourceExcerpt: String(item.source_excerpt ?? item.sourceExcerpt ?? item.evidence ?? '').trim().slice(0, 800),
        sourceTimestamp: String(item.source_timestamp ?? item.sourceTimestamp ?? item.timestamp ?? '').trim().slice(0, 32),
        reason: String(item.reason ?? item.problem ?? '').trim().slice(0, 800)
      };
    };

    const normalizedOmissions = omissions.map(item => normalizeFinding(item, 'omission')).filter(Boolean);
    const normalizedUnsupported = unsupported.map(item => normalizeFinding(item, 'unsupported')).filter(Boolean);
    if (normalizedOmissions.length !== omissions.length || normalizedUnsupported.length !== unsupported.length) {
      throw new Error('Semantic coverage audit contains a finding with an empty or invalid claim.');
    }
    if (normalizedOmissions.some(item => !item.sourceExcerpt && !item.sourceTimestamp)) {
      throw new Error('Semantic coverage audit omissions must include a source excerpt or timestamp.');
    }
    if (normalizedUnsupported.some(item => !item.reason)) {
      throw new Error('Semantic coverage audit unsupported claims must include a reason.');
    }
    if (normalizedOmissions.length > 80 || normalizedUnsupported.length > 80) {
      throw new Error('Semantic coverage audit returned an unreasonable number of findings.');
    }
    return { omissions: normalizedOmissions, unsupportedClaims: normalizedUnsupported };
  }

  function measureReferenceStyle(markdown) {
    const text = String(markdown || '').replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    const bullets = lines.filter(line => /^\s*[-*]\s+/.test(line));
    const mainTopicHeadings = lines.filter(line => /^###\s+\S/.test(line)).length;
    const boldCallouts = lines.filter(line => /^\s*-\s+\*\*\[[^\]]+\]\*/.test(line)).length;
    const words = (text.match(/\b[\p{L}\p{N}_]+(?:['’.-][\p{L}\p{N}_]+)*\b/gu) || []).length;
    return {
      words,
      mainTopicHeadings,
      topicHeadings: lines.filter(line => /^#{2,4}\s+\S/.test(line)).length,
      timestampHeadings: lines.filter(line => /^#{2,4}\s+\[(?:\d{1,3}:)?\d{2}:\d{2}/.test(line)).length,
      topLevelHyphenBullets: lines.filter(line => /^-\s+/.test(line)).length,
      hyphenBullets: bullets.filter(line => /^\s*-\s+/.test(line)).length,
      asteriskBullets: bullets.filter(line => /^\s*\*\s+/.test(line)).length,
      nestedHyphenBullets: lines.filter(line => /^ {4,}-\s+/.test(line)).length,
      boldCallouts,
      calloutsPerMainHeading: mainTopicHeadings ? Math.round((boldCallouts / mainTopicHeadings) * 100) / 100 : 0,
      mermaidDiagrams: (text.match(/^```mermaid\s*$/gm) || []).length,
      displayEquations: Math.floor((text.match(/\$\$/g) || []).length / 2),
      markdownTables: lines.filter(line => /^\s*\|.*\|\s*$/.test(line)).length,
      blockquotes: lines.filter(line => /^\s*>\s?/.test(line)).length
    };
  }

  function editorialStyleWarnings(markdown, preferredHeadings = 0) {
    const metrics = measureReferenceStyle(markdown);
    const warnings = [];
    const preferred = Math.max(0, Number(preferredHeadings) || 0);
    // Timestamp-led headings and missing reference structures are hard style
    // defects; the editor gets one chance to repair them before acceptance.
    if (metrics.timestampHeadings > 0) {
      warnings.push({
        code: 'timestamp-led-headings',
        severity: 'hard',
        actual: metrics.timestampHeadings,
        message: `The note still has ${metrics.timestampHeadings} timestamp-led headings. Replace them with descriptive concept headings; keep timestamps only on screenshot anchors.`
      });
    }
    if ((metrics.mainTopicHeadings >= 3 || preferred >= 3) && metrics.nestedHyphenBullets === 0) {
      warnings.push({
        code: 'missing-nested-hierarchy',
        severity: 'hard',
        actual: 0,
        message: 'The note has no nested hyphen bullets. Put explanations, examples and qualifications beneath their parent concepts.'
      });
    }
    if ((metrics.mainTopicHeadings >= 3 || preferred >= 3) && metrics.boldCallouts === 0) {
      warnings.push({
        code: 'missing-selective-callouts',
        severity: 'hard',
        actual: 0,
        message: 'The note has no bold bracketed concept callouts. Add only a small number where a definition, key insight or teaching strategy materially benefits from a label.'
      });
    }
    // The reference and human-authored benchmark use callouts selectively.
    const calloutLimit = Math.max(3, Math.ceil(metrics.mainTopicHeadings * 2));
    if (metrics.mainTopicHeadings >= 3 && metrics.boldCallouts > calloutLimit) {
      warnings.push({
        code: 'excessive-bold-callouts',
        severity: 'hard',
        actual: metrics.boldCallouts,
        maximum: calloutLimit,
        message: `The note uses ${metrics.boldCallouts} bold bracketed callouts for ${metrics.mainTopicHeadings} main topic headings; use them selectively (about ${calloutLimit} or fewer).`
      });
    }
    if (preferred > 0 && metrics.mainTopicHeadings < preferred) {
      warnings.push({
        code: 'fewer-than-preferred-topic-headings',
        severity: 'soft',
        actual: metrics.mainTopicHeadings,
        preferred,
        message: `The note has ${metrics.mainTopicHeadings} main topic headings; the source-length heuristic suggests about ${preferred}. Check whether distinct teaching topics have been collapsed, but do not split a single concept just to meet a number.`
      });
    }
    return warnings;
  }

  function countToken(markdown, token) {
    return String(markdown || '').split(token).length - 1;
  }

  function validateOutput(markdown, sourceLength, options = {}) {
    let result = String(markdown || '').trim();
    // Strip an outer model-added Markdown wrapper only when the entire response
    // is enclosed by it. Never strip the final fence of a legitimate code or
    // Mermaid block at the end of the study note.
    const outerMarkdownFence = result.match(/^```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
    if (outerMarkdownFence) result = outerMarkdownFence[1].trim();
    result = result
      .replace(/^---\s*[\s\S]*?\n---\s*/m, '')
      .replace(/^#\s+[^\n]+\n+/, '')
      .trim();

    const ratio = Number.isFinite(options.minimumRatio) ? options.minimumRatio : 0.08;
    const minChars = Number.isFinite(options.minimumCharacters) ? options.minimumCharacters : 350;
    const minimumLength = Math.max(minChars, Math.floor(Number(sourceLength || 0) * ratio));
    if (result.length < minimumLength) {
      return { valid: false, reason: `Final synthesis was unexpectedly short (${result.length} characters; minimum ${minimumLength}); the original draft was retained.`, markdown: result };
    }

    const fenceCount = (result.match(/^```/gm) || []).length;
    if (fenceCount % 2 !== 0) {
      return { valid: false, reason: 'Final synthesis returned an unclosed code or Mermaid fence; the original draft was retained.', markdown: result };
    }
    const headingLines = result.split('\n').filter(line => /^#{2,4}\s+\S/.test(line));
    const minimumHeadings = Number.isFinite(options.minimumHeadings) ? options.minimumHeadings : 2;
    if (headingLines.length < minimumHeadings) {
      return { valid: false, reason: `Final synthesis produced too few topic headings (${headingLines.length}; minimum ${minimumHeadings}); the original draft was retained.`, markdown: result };
    }
    if (!options.allowTimestampHeadings && headingLines.some(line => /^#{2,4}\s+\[(?:\d{1,3}:)?\d{2}:\d{2}/.test(line))) {
      return { valid: false, reason: 'Final synthesis still uses timestamp-led section headings instead of topic-based headings; the original draft was retained.', markdown: result };
    }
    if (options.requireNestedBullets && !/^ {4,}[-*]\s+/m.test(result)) {
      return { valid: false, reason: 'Final synthesis lacks the nested explanatory bullet structure used by the reference notes; the original draft was retained.', markdown: result };
    }
    if (options.requireBoldLabels && !/^[-*]\s+\*\*\[[^\]]+\]\*\*/m.test(result)) {
      return { valid: false, reason: 'Final synthesis lacks labeled concept callouts used by the reference notes; the original draft was retained.', markdown: result };
    }
    if (options.requireHyphenBullets) {
      const bulletLines = result.split('\n').filter(line => /^\s*[-*]\s+/.test(line));
      const hyphenLines = bulletLines.filter(line => /^\s*-\s+/.test(line));
      if (bulletLines.length && hyphenLines.length / bulletLines.length < 0.85) {
        return { valid: false, reason: "Final synthesis does not follow the reference export hyphen-bullet convention; the original draft was retained.", markdown: result };
      }
    }

    const requiredTokens = Array.isArray(options.requiredTokens) ? options.requiredTokens : [];
    for (const token of requiredTokens) {
      const count = countToken(result, token);
      if (count !== 1) {
        return { valid: false, reason: `Final synthesis did not preserve source/asset marker ${token} exactly once (found ${count}); the original draft was retained.`, markdown: result };
      }
    }
    return { valid: true, markdown: result };
  }

  function stripInternalMarkers(markdown, markers = []) {
    let result = String(markdown || '');
    for (const marker of markers || []) {
      result = result.split(marker).join('');
    }
    return result.replace(/^\s*\n/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function findWindowAnchorPositions(text, startLabel) {
    if (!text || !startLabel) return [];
    const escaped = String(startLabel).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const altLabel = String(startLabel).replace(/^0(\d:)/, '$1');
    const escapedAlt = altLabel !== startLabel
      ? altLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      : null;
    const labelGroup = escapedAlt ? `(?:${escaped}|${escapedAlt})` : escaped;

    // An anchor must begin a Markdown line. A timestamp mentioned inside prose,
    // a hyperlink, or an example is not evidence that a source window was mapped.
    const pattern = new RegExp(
      `(?:^|\\n)[\\t ]*(?:(?:#{1,6}|[-*+])\\s*)?(?:\\*\\*)?\\[\\s*${labelGroup}(?:\\s*[-–—]\\s*(?:\\d{1,2}:)?\\d{2}:\\d{2})?\\s*\\](?:\\*\\*)?(?=[\\t ]|:|$)`,
      'gim'
    );
    const positions = [];
    let match;
    while ((match = pattern.exec(String(text))) !== null) {
      positions.push({
        index: match.index,
        endIndex: pattern.lastIndex,
        raw: match[0],
        label: startLabel
      });
    }
    return positions;
  }

  function validateEvidencePacket(packetText, sourceWindows = []) {
    const rawText = String(packetText || '').trim();
    const windows = Array.isArray(sourceWindows) ? sourceWindows : [];
    if (!windows.length) {
      return {
        valid: rawText.length > 0,
        totalWindows: 0,
        coveredWindows: 0,
        missingWindows: [],
        emptyWindows: [],
        duplicateAnchors: [],
        outOfOrderWindows: [],
        repeatedWindowContent: [],
        outputCharacters: rawText.length,
        reasons: rawText.length === 0 ? ['Evidence packet is empty.'] : []
      };
    }

    if (!rawText) {
      return {
        valid: false,
        totalWindows: windows.length,
        coveredWindows: 0,
        missingWindows: windows.map(w => w.startLabel || formatTimestamp(w.bucket * 30)),
        emptyWindows: [],
        duplicateAnchors: [],
        outOfOrderWindows: [],
        repeatedWindowContent: [],
        outputCharacters: 0,
        reasons: ['Evidence packet is empty.']
      };
    }

    const fenceCount = (rawText.match(/^```/gm) || []).length;
    const hasUnclosedFence = fenceCount % 2 !== 0;
    const allPositions = [];
    const missingWindows = [];
    const duplicateAnchors = [];
    const outOfOrderWindows = [];

    windows.forEach((win, windowIndex) => {
      const label = win.startLabel || formatTimestamp(win.bucket * 30);
      const matches = findWindowAnchorPositions(rawText, label);
      if (!matches.length) {
        missingWindows.push(label);
        return;
      }
      if (matches.length > 1) duplicateAnchors.push(label);
      allPositions.push({
        startLabel: label,
        window: win,
        windowIndex,
        index: matches[0].index,
        endIndex: matches[0].endIndex
      });
    });

    allPositions.sort((a, b) => a.index - b.index);
    for (let i = 1; i < allPositions.length; i++) {
      if (allPositions[i].windowIndex <= allPositions[i - 1].windowIndex) {
        outOfOrderWindows.push(allPositions[i].startLabel);
      }
    }

    const emptyWindows = [];
    const normalizedWindowBodies = new Map();
    for (let i = 0; i < allPositions.length; i++) {
      const current = allPositions[i];
      const nextStart = i + 1 < allPositions.length ? allPositions[i + 1].index : rawText.length;
      const contentSlice = rawText.slice(current.endIndex, nextStart).trim();
      const stripped = contentSlice
        .replace(/^[-*#:>\s]+/, '')
        .replace(/[-*#:>\s]+$/, '')
        .trim();
      const isPlaceholder = /^(?:n\/?a|none|placeholder|\.\.\.|nothing|no content|nil|null|empty)[.\s]*$/i.test(stripped);
      if (stripped.length < 15 || isPlaceholder) emptyWindows.push(current.startLabel);

      // Exact whole-window repetition is a common placeholder failure. Compare
      // normalized complete bodies, not individual repeated terms, so normal
      // recurring terminology does not trigger this guard.
      const normalizedBody = stripped
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^[-*+]\s+/gm, '')
        .replace(/[*_~`]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLocaleLowerCase();
      if (normalizedBody.length >= 15) {
        if (!normalizedWindowBodies.has(normalizedBody)) normalizedWindowBodies.set(normalizedBody, []);
        normalizedWindowBodies.get(normalizedBody).push(current.startLabel);
      }
    }
    const repeatedWindowContent = [...normalizedWindowBodies.values()]
      .filter(labels => labels.length > 1)
      .flat();

    const reasons = [];
    if (missingWindows.length) {
      reasons.push(`Missing ${missingWindows.length} source window anchor(s): ${missingWindows.slice(0, 10).join(', ')}${missingWindows.length > 10 ? '...' : ''}`);
    }
    if (duplicateAnchors.length) {
      reasons.push(`Duplicate source window anchor(s): ${duplicateAnchors.slice(0, 10).join(', ')}${duplicateAnchors.length > 10 ? '...' : ''}`);
    }
    if (outOfOrderWindows.length) {
      reasons.push(`Out-of-order source window anchor(s): ${outOfOrderWindows.slice(0, 10).join(', ')}${outOfOrderWindows.length > 10 ? '...' : ''}`);
    }
    if (repeatedWindowContent.length) {
      reasons.push(`Identical whole-window evidence repeated across source windows: ${[...new Set(repeatedWindowContent)].slice(0, 10).join(', ')}`);
    }
    if (emptyWindows.length) {
      reasons.push(`Empty or placeholder evidence for ${emptyWindows.length} source window(s): ${emptyWindows.slice(0, 10).join(', ')}${emptyWindows.length > 10 ? '...' : ''}`);
    }
    if (hasUnclosedFence) reasons.push('Unclosed code or markdown fence detected in evidence packet.');

    const coveredWindows = windows.length - missingWindows.length;
    const valid = missingWindows.length === 0 &&
      duplicateAnchors.length === 0 &&
      outOfOrderWindows.length === 0 &&
      repeatedWindowContent.length === 0 &&
      emptyWindows.length === 0 &&
      !hasUnclosedFence;

    return {
      valid,
      totalWindows: windows.length,
      coveredWindows,
      missingWindows,
      emptyWindows,
      duplicateAnchors,
      outOfOrderWindows,
      repeatedWindowContent: [...new Set(repeatedWindowContent)],
      outputCharacters: rawText.length,
      reasons
    };
  }

  function mergeEvidenceEntries(initialText, repairText, sourceWindows = []) {
    const windows = Array.isArray(sourceWindows) ? sourceWindows : [];
    if (!windows.length) return [initialText, repairText].filter(Boolean).join('\n\n');

    const extractEntries = text => {
      const source = String(text || '');
      const positions = [];
      for (const win of windows) {
        const label = win.startLabel || formatTimestamp(win.bucket * 30);
        for (const match of findWindowAnchorPositions(source, label)) {
          positions.push({ label, index: match.index, endIndex: match.endIndex, raw: match.raw });
        }
      }
      positions.sort((a, b) => a.index - b.index);
      const preamble = positions.length ? source.slice(0, positions[0].index).trim() : source.trim();
      const entriesByLabel = new Map();
      for (let i = 0; i < positions.length; i++) {
        const current = positions[i];
        const nextStart = i + 1 < positions.length ? positions[i + 1].index : source.length;
        const body = source.slice(current.endIndex, nextStart).trim();
        if (!entriesByLabel.has(current.label)) entriesByLabel.set(current.label, []);
        entriesByLabel.get(current.label).push(body);
      }
      return { entriesByLabel, preamble };
    };

    const initialExtracted = extractEntries(initialText);
    const repairExtracted = extractEntries(repairText);
    const initialMap = initialExtracted.entriesByLabel;
    const repairMap = repairExtracted.entriesByLabel;
    const mergedBlocks = [];

    for (const win of windows) {
      const label = win.startLabel || formatTimestamp(win.bucket * 30);
      const fragments = [
        ...(initialMap.get(label) || []),
        ...(repairMap.get(label) || [])
      ].map(value => String(value || '').trim()).filter(Boolean);

      // Remove only byte-for-byte/whitespace-equivalent duplicate fragments.
      // Never choose the repair packet instead of the original packet: retain
      // every distinct initial and repair detail for this source window.
      const seenLines = new Set();
      const preservedFragments = fragments.map(fragment => {
        const uniqueLines = String(fragment).split(/\r?\n/).filter(line => {
          const canonical = line.replace(/\s+/g, ' ').trim();
          if (!canonical) return true;
          if (seenLines.has(canonical)) return false;
          seenLines.add(canonical);
          return true;
        });
        return uniqueLines.join('\n').trim();
      }).filter(Boolean);
      if (preservedFragments.length) {
        mergedBlocks.push(`### [${label}]\n${preservedFragments.join('\n\n')}`);
      }
    }

    if (!mergedBlocks.length) return [initialText, repairText].filter(Boolean).join('\n\n');

    const preambleLines = [initialExtracted.preamble, repairExtracted.preamble]
      .flatMap(value => String(value || '').split(/\r?\n/))
      .map(line => line.trimEnd());
    const seenPreamble = new Set();
    const preservedPreamble = preambleLines.filter(line => {
      const canonical = line.replace(/\s+/g, ' ').trim();
      if (!canonical) return true;
      if (seenPreamble.has(canonical)) return false;
      seenPreamble.add(canonical);
      return true;
    }).join('\n').trim();

    return [preservedPreamble, mergedBlocks.join('\n\n')].filter(Boolean).join('\n\n');
  }

  function splitChunkByWindows(chunk, sourceWindows, parts = 2, intervalSeconds = 30) {
    const windows = Array.isArray(sourceWindows) ? sourceWindows : (chunk?.windows || []);
    const count = Math.max(2, Math.min(windows.length, Number(parts) || 2));
    if (windows.length <= 1) return [chunk];

    const interval = Math.max(15, Math.min(120, Number(intervalSeconds) || 30));
    const splitSize = Math.ceil(windows.length / count);
    const childChunks = [];

    for (let p = 0; p < count; p++) {
      const subset = windows.slice(p * splitSize, (p + 1) * splitSize);
      if (!subset.length) continue;

      const startBucket = subset[0].bucket;
      const endBucket = subset[subset.length - 1].bucket;
      const startTime = startBucket * interval;
      const endTime = (endBucket + 1) * interval - 1;

      const childLines = (chunk.lines || []).filter(line => {
        const sec = parseTimestampSeconds(line);
        if (sec === null) return false;
        const b = Math.floor(sec / interval);
        return b >= startBucket && b <= endBucket;
      });

      const childTranscriptText = childLines.join('\n');
      childChunks.push({
        lines: childLines,
        transcriptText: childTranscriptText,
        characterCount: childTranscriptText.length,
        startTime,
        endTime,
        startLabel: subset[0].startLabel,
        endLabel: subset[subset.length - 1].endLabel,
        windows: subset
      });
    }

    return childChunks;
  }

  function getTranscriptLinesForWindows(lines, windowLabels, intervalSeconds = 30) {
    const targetLabels = new Set(Array.isArray(windowLabels) ? windowLabels : [windowLabels]);
    const interval = Math.max(15, Math.min(120, Number(intervalSeconds) || 30));
    return (lines || []).filter(line => {
      const sec = parseTimestampSeconds(line);
      if (sec === null) return false;
      const bucket = Math.floor(sec / interval);
      const label = formatTimestamp(bucket * interval);
      return targetLabels.has(label);
    }).join('\n');
  }

  window.HoverNotesNoteSynthesis = Object.freeze({
    splitDocument,
    parseTimestampSeconds,
    normalizeTranscriptForAI,
    formatTimestamp,
    chunkTranscriptLines,
    chunkKnowledgeBlocks,
    buildCoverageWindows,
    validateCoverageAssignment,
    minimumTopicHeadings,
    chunkTranscriptByTimeWindows,
    buildSemanticAuditBatches,
    parseSemanticAuditResponse,
    measureReferenceStyle,
    editorialStyleWarnings,
    readYamlTitle,
    removeDuplicateTitleH1,
    protectManagedScreenshotBlocks,
    restoreManagedScreenshotBlocks,
    extractVisualContext,
    validateOutput,
    stripInternalMarkers,
    validateEvidencePacket,
    mergeEvidenceEntries,
    splitChunkByWindows,
    getTranscriptLinesForWindows
  });
})();
