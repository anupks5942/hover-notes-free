/**
 * YouTube timed-text parsers and format-aware dispatcher.
 * Supports:
 * - JSON3 (events[].segs[].utf8/utf16/text, tStartMs, dDurationMs)
 * - XML legacy (<text start="..." dur="...">)
 * - XML SRV3 (<p t="..." d="..."><s>...</s></p>)
 * - WebVTT (WEBVTT cues)
 *
 * Provides safe structural diagnostics for unknown JSON schemas without leaking
 * transcript text, URLs, tokens, or cookies.
 */
(() => {
  function decodeEntities(value) {
    const raw = String(value || '');
    if (typeof document === 'undefined') {
      return raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    }
    const node = document.createElement('textarea');
    node.innerHTML = raw;
    return node.value.replace(/\n+/g, ' ').trim();
  }

  function validateAndSortCues(rawCues) {
    if (!Array.isArray(rawCues)) return [];
    const valid = [];
    for (const cue of rawCues) {
      if (!cue || typeof cue !== 'object') continue;
      const start = Number(cue.start);
      const duration = Number(cue.duration);
      const text = typeof cue.text === 'string' ? cue.text.trim() : '';
      if (!text) continue;
      if (!Number.isFinite(start) || start < 0) continue;
      if (!Number.isFinite(duration) || duration < 0) continue;
      valid.push({ start, duration, text });
    }
    return valid.sort((a, b) => a.start - b.start);
  }

  function parseJson3TimedText(json) {
    const events = Array.isArray(json?.events) ? json.events : [];
    const items = [];
    for (const event of events) {
      if (!Array.isArray(event?.segs)) continue;
      const startMs = Number(event.tStartMs);
      const durationMs = Number(event.dDurationMs || 0);
      if (!Number.isFinite(startMs) || startMs < 0) continue;
      if (!Number.isFinite(durationMs) || durationMs < 0) continue;

      const text = event.segs.map(segment =>
        segment?.utf8 ?? segment?.utf16 ?? segment?.text ?? ''
      ).join('').trim();
      if (!text) continue;

      items.push({
        start: startMs / 1000,
        duration: durationMs / 1000,
        text: decodeEntities(text)
      });
    }
    return validateAndSortCues(items);
  }

  function parseXmlTimedText(xmlText) {
    if (typeof DOMParser === 'undefined') return [];
    const raw = String(xmlText || '').trim();
    if (!raw) return [];

    let doc;
    try {
      doc = new DOMParser().parseFromString(raw, 'text/xml');
    } catch (_) {
      return [];
    }
    if (!doc || doc.querySelector('parsererror')) return [];
    const items = [];

    // Legacy timedtext: <text start="1.2" dur="2.3">...</text>
    for (const node of doc.querySelectorAll('text')) {
      const start = Number.parseFloat(node.getAttribute('start') || '0');
      const duration = Number.parseFloat(node.getAttribute('dur') || '0');
      const text = decodeEntities(node.textContent || '');
      if (text && Number.isFinite(start) && start >= 0 && Number.isFinite(duration) && duration >= 0) {
        items.push({ start, duration, text });
      }
    }

    // Modern srv3: <p t="1200" d="2300"><s>...</s></p> (t/d are ms).
    if (items.length === 0) {
      for (const node of doc.querySelectorAll('p[t], p[start]')) {
        const hasMsTime = node.hasAttribute('t');
        const startRaw = Number.parseFloat(node.getAttribute(hasMsTime ? 't' : 'start') || '0');
        const durationRaw = Number.parseFloat(node.getAttribute(node.hasAttribute('d') ? 'd' : 'dur') || '0');
        const start = hasMsTime ? startRaw / 1000 : startRaw;
        const duration = node.hasAttribute('d') ? durationRaw / 1000 : durationRaw;
        const segments = [...node.querySelectorAll('s')].map(s => s.textContent || '').join('');
        const text = decodeEntities(segments || node.textContent || '');
        if (text && Number.isFinite(start) && start >= 0 && Number.isFinite(duration) && duration >= 0) {
          items.push({ start, duration, text });
        }
      }
    }
    return validateAndSortCues(items);
  }

  function parseVttTimestamp(timestampStr) {
    const match = String(timestampStr || '').trim().match(/^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/);
    if (!match) return NaN;
    const hours = match[1] ? Number.parseInt(match[1], 10) : 0;
    const minutes = Number.parseInt(match[2], 10);
    const seconds = Number.parseInt(match[3], 10);
    const ms = Number.parseInt(match[4], 10);
    return hours * 3600 + minutes * 60 + seconds + ms / 1000;
  }

  function parseVttTimedText(vttText) {
    const raw = String(vttText || '').trim();
    if (!raw || !raw.startsWith('WEBVTT')) return [];

    const lines = raw.split(/\r?\n/);
    const items = [];
    let i = 0;

    // Skip WEBVTT header and any metadata up to first blank line
    while (i < lines.length && lines[i].trim() !== '') i++;

    while (i < lines.length) {
      while (i < lines.length && lines[i].trim() === '') i++;
      if (i >= lines.length) break;

      let line = lines[i].trim();
      // Optional cue identifier before timestamp line
      if (!line.includes('-->') && i + 1 < lines.length && lines[i + 1].includes('-->')) {
        i++;
        line = lines[i].trim();
      }

      if (line.includes('-->')) {
        const [startPart, endPart] = line.split('-->').map(s => s.trim().split(/\s+/)[0]);
        const start = parseVttTimestamp(startPart);
        const end = parseVttTimestamp(endPart);
        const duration = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : 0;
        i++;

        const textLines = [];
        while (i < lines.length && lines[i].trim() !== '') {
          const cleanLine = lines[i].replace(/<\/?[^>]+(>|$)/g, '').trim();
          if (cleanLine) textLines.push(cleanLine);
          i++;
        }

        const text = decodeEntities(textLines.join(' '));
        if (text && Number.isFinite(start) && start >= 0 && Number.isFinite(duration) && duration >= 0) {
          items.push({ start, duration, text });
        }
      } else {
        i++;
      }
    }

    return validateAndSortCues(items);
  }

  function performEventSchemaCensus(rawEvents, options = {}) {
    const events = Array.isArray(rawEvents) ? rawEvents : [];
    const maxNodeBudget = typeof options.maxNodeBudget === 'number' && options.maxNodeBudget > 0
      ? options.maxNodeBudget
      : 20000;
    const maxDepth = typeof options.maxDepth === 'number' && options.maxDepth > 0
      ? Math.min(options.maxDepth, 6)
      : 6;
    const maxRepresentativeShapes = typeof options.maxRepresentativeShapes === 'number' && options.maxRepresentativeShapes > 0
      ? options.maxRepresentativeShapes
      : 5;
    const maxSampleEvents = typeof options.maxSampleEvents === 'number' && options.maxSampleEvents > 0
      ? options.maxSampleEvents
      : 100;

    const totalEvents = events.length;
    const eventKeyFrequencies = Object.create(null);
    const keySignatures = Object.create(null);
    const segmentLikeFields = Object.create(null);
    const shapeRepresentativeIndices = Object.create(null);

    let eventsWithSegs = 0;
    let firstEventWithSegsIndex = null;
    let firstEventWithStringIndex = null;

    function hasNonEmptyString(val, depth, maxD) {
      if (depth > maxD || val === null || val === undefined) return false;
      if (typeof val === 'string') return val.trim().length > 0;
      if (typeof val === 'object') {
        if (Array.isArray(val)) {
          for (let j = 0; j < val.length; j++) {
            if (hasNonEmptyString(val[j], depth + 1, maxD)) return true;
          }
        } else {
          const keys = Object.keys(val);
          for (let j = 0; j < keys.length; j++) {
            if (hasNonEmptyString(val[keys[j]], depth + 1, maxD)) return true;
          }
        }
      }
      return false;
    }

    // 1. Full-pass event-level metrics (fast O(N) sweep)
    for (let i = 0; i < totalEvents; i++) {
      const event = events[i];
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        const nullSig = event === null ? 'null' : typeof event;
        keySignatures[nullSig] = (keySignatures[nullSig] || 0) + 1;
        continue;
      }

      const keys = Object.keys(event);
      const sig = keys.slice().sort().join(',');
      keySignatures[sig] = (keySignatures[sig] || 0) + 1;

      if (shapeRepresentativeIndices[sig] === undefined) {
        shapeRepresentativeIndices[sig] = i;
      }

      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        eventKeyFrequencies[key] = (eventKeyFrequencies[key] || 0) + 1;
        const val = event[key];
        if (Array.isArray(val)) {
          if (!segmentLikeFields[key]) {
            segmentLikeFields[key] = { count: 0, arrayCount: 0, objectCount: 0 };
          }
          segmentLikeFields[key].count++;
          segmentLikeFields[key].arrayCount++;
        } else if (val && typeof val === 'object') {
          if (!segmentLikeFields[key]) {
            segmentLikeFields[key] = { count: 0, arrayCount: 0, objectCount: 0 };
          }
          segmentLikeFields[key].count++;
          segmentLikeFields[key].objectCount++;
        }
      }

      if (event.segs !== undefined) {
        eventsWithSegs++;
        if (firstEventWithSegsIndex === null) {
          firstEventWithSegsIndex = i;
        }
      }

      if (firstEventWithStringIndex === null && hasNonEmptyString(event, 0, 4)) {
        firstEventWithStringIndex = i;
      }
    }

    // Helper to describe field value types safely without leaking content
    function summarizeFieldType(val) {
      if (val === null) return 'null';
      if (val === undefined) return 'undefined';
      const t = typeof val;
      if (t === 'string') return `string(len=${val.length})`;
      if (t === 'number') return Number.isInteger(val) ? 'integer' : 'number';
      if (t === 'boolean') return 'boolean';
      if (Array.isArray(val)) {
        if (val.length === 0) return 'Array(0)';
        const first = val[0];
        if (first && typeof first === 'object' && !Array.isArray(first)) {
          const subKeys = Object.keys(first).slice(0, 8).join(',');
          return `Array(${val.length}){${subKeys}}`;
        }
        const elemType = first === null ? 'null' : typeof first;
        return `Array(${val.length})[${elemType}]`;
      }
      if (t === 'object') {
        const subKeys = Object.keys(val).slice(0, 8).join(',');
        return `object{${subKeys}}`;
      }
      return t;
    }

    // 2. Select representative events
    const representativeEvents = [];
    const coveredIndices = new Set();

    function addRepresentative(index, reason) {
      if (index === null || index === undefined || index < 0 || index >= events.length) return;
      if (coveredIndices.has(index)) {
        const existing = representativeEvents.find(r => r.index === index);
        if (existing && !existing.reason.includes(reason)) {
          existing.reason += ` + ${reason}`;
        }
        return;
      }
      coveredIndices.add(index);
      const ev = events[index];
      const keySig = (ev && typeof ev === 'object' && !Array.isArray(ev))
        ? Object.keys(ev).sort().join(',')
        : (ev === null ? 'null' : typeof ev);
      const fieldTypes = Object.create(null);
      if (ev && typeof ev === 'object' && !Array.isArray(ev)) {
        for (const [k, v] of Object.entries(ev)) {
          fieldTypes[k] = summarizeFieldType(v);
        }
      }
      representativeEvents.push({
        index,
        reason,
        keySignature: keySig,
        fieldTypes
      });
    }

    if (totalEvents > 0) {
      addRepresentative(0, 'first-event');
    }
    if (firstEventWithSegsIndex !== null) {
      addRepresentative(firstEventWithSegsIndex, 'first-event-with-segs');
    }
    if (firstEventWithStringIndex !== null) {
      addRepresentative(firstEventWithStringIndex, 'first-event-with-string');
    }

    // Up to 5 additional distinct shapes
    let additionalCount = 0;
    const sortedSignatures = Object.keys(shapeRepresentativeIndices).sort((a, b) => {
      return (keySignatures[b] || 0) - (keySignatures[a] || 0);
    });

    for (const sig of sortedSignatures) {
      if (additionalCount >= maxRepresentativeShapes) break;
      const idx = shapeRepresentativeIndices[sig];
      if (!coveredIndices.has(idx)) {
        additionalCount++;
        addRepresentative(idx, `distinct-shape-${additionalCount}`);
      }
    }

    // 3. Nested structural traversal with traversal-node budget
    let nodesVisited = 0;
    let budgetExceeded = false;
    const structuralPaths = Object.create(null);
    const numericPaths = Object.create(null);
    const stringLeafPaths = Object.create(null);

    function recordPathType(path, type) {
      if (!path) return;
      if (!structuralPaths[path]) {
        structuralPaths[path] = { types: new Set(), occurrences: 0 };
      }
      structuralPaths[path].types.add(type);
      structuralPaths[path].occurrences++;
    }

    function traverseNode(val, currentPath, currentDepth) {
      if (budgetExceeded) return;
      nodesVisited++;
      if (nodesVisited >= maxNodeBudget) {
        budgetExceeded = true;
        return;
      }
      if (currentDepth > maxDepth) return;

      if (val === null || val === undefined) {
        recordPathType(currentPath, val === null ? 'null' : 'undefined');
        return;
      }

      const valType = typeof val;

      if (valType === 'string') {
        recordPathType(currentPath, 'string');
        if (!stringLeafPaths[currentPath]) {
          stringLeafPaths[currentPath] = {
            count: 0,
            emptyCount: 0,
            minLength: Infinity,
            maxLength: -Infinity,
            sampleLengths: []
          };
        }
        const slp = stringLeafPaths[currentPath];
        if (val.length === 0) {
          slp.emptyCount++;
        } else {
          slp.count++;
          if (val.length < slp.minLength) slp.minLength = val.length;
          if (val.length > slp.maxLength) slp.maxLength = val.length;
          if (slp.sampleLengths.length < 10) {
            slp.sampleLengths.push(val.length);
          }
        }
        return;
      }

      if (valType === 'number') {
        recordPathType(currentPath, 'number');
        if (Number.isFinite(val)) {
          if (!numericPaths[currentPath]) {
            const lastProp = currentPath.split('.').pop() || '';
            const likelyTimestamp = /time|start|dur|offset|ms|timestamp|tstart|dduration|^t$|^d$/i.test(lastProp);
            numericPaths[currentPath] = {
              count: 0,
              min: val,
              max: val,
              isInteger: Number.isInteger(val),
              likelyTimestamp
            };
          }
          const np = numericPaths[currentPath];
          np.count++;
          if (val < np.min) np.min = val;
          if (val > np.max) np.max = val;
          if (!Number.isInteger(val)) np.isInteger = false;
        }
        return;
      }

      if (valType === 'boolean') {
        recordPathType(currentPath, 'boolean');
        return;
      }

      if (Array.isArray(val)) {
        recordPathType(currentPath, 'array');
        const elemPath = `${currentPath}[]`;
        for (let i = 0; i < val.length; i++) {
          if (budgetExceeded) break;
          traverseNode(val[i], elemPath, currentDepth + 1);
        }
        return;
      }

      if (valType === 'object') {
        recordPathType(currentPath, 'object');
        const childKeys = Object.keys(val);
        for (let i = 0; i < childKeys.length; i++) {
          if (budgetExceeded) break;
          const childKey = childKeys[i];
          const childPath = currentPath ? `${currentPath}.${childKey}` : childKey;
          traverseNode(val[childKey], childPath, currentDepth + 1);
        }
      }
    }

    // Traverse representative events first
    for (const rep of representativeEvents) {
      if (budgetExceeded) break;
      const ev = events[rep.index];
      traverseNode(ev, 'events[]', 1);
    }

    // Traversal bounded sampling over remaining events
    const sampledIndices = new Set(representativeEvents.map(r => r.index));
    const step = Math.max(1, Math.floor(totalEvents / maxSampleEvents));
    for (let i = 0; i < totalEvents && sampledIndices.size < maxSampleEvents; i += step) {
      if (budgetExceeded) break;
      if (!sampledIndices.has(i)) {
        sampledIndices.add(i);
        traverseNode(events[i], 'events[]', 1);
      }
    }

    // Format finalized census collections
    const formattedNumericPaths = Object.entries(numericPaths).map(([path, info]) => ({
      path,
      count: info.count,
      min: info.min,
      max: info.max,
      isInteger: info.isInteger,
      likelyTimestamp: info.likelyTimestamp
    })).sort((a, b) => a.path.localeCompare(b.path));

    const formattedStringLeafPaths = Object.entries(stringLeafPaths).map(([path, info]) => ({
      path,
      count: info.count,
      emptyCount: info.emptyCount,
      minLength: info.minLength === Infinity ? 0 : info.minLength,
      maxLength: info.maxLength === -Infinity ? 0 : info.maxLength,
      sampleLengths: info.sampleLengths
    })).sort((a, b) => a.path.localeCompare(b.path));

    const formattedStructuralPaths = Object.entries(structuralPaths).map(([path, info]) => ({
      path,
      types: Array.from(info.types).sort(),
      occurrences: info.occurrences
    })).sort((a, b) => a.path.localeCompare(b.path));

    return {
      totalEvents,
      eventKeyFrequencies,
      eventsWithSegs,
      segmentLikeFields,
      keySignatures,
      firstEventWithSegsIndex,
      firstEventWithStringIndex,
      representativeEvents,
      structuralPaths: formattedStructuralPaths,
      numericPaths: formattedNumericPaths,
      stringLeafPaths: formattedStringLeafPaths,
      traversalBudget: {
        maxNodeBudget,
        nodesVisited,
        budgetExceeded
      }
    };
  }

  function performFullPassJson3Census(rawEvents, options = {}) {
    const events = Array.isArray(rawEvents) ? rawEvents : [];
    const maxEventsLimit = typeof options.maxEvents === 'number' && options.maxEvents > 0
      ? options.maxEvents
      : 50000;
    const totalEvents = events.length;
    const inspectCount = Math.min(totalEvents, maxEventsLimit);
    const allEventsInspected = inspectCount === totalEvents;

    let totalSegments = 0;
    let eventsMissingSegs = 0;
    let eventsEmptySegs = 0;
    let eventsWithNonEmptySegs = 0;

    const segmentFieldStats = Object.create(null);

    const utf8Stats = { present: 0, missing: 0, nullCount: 0, nonStringCount: 0, emptyCount: 0, whitespaceOnlyCount: 0, nonWhitespaceCount: 0 };
    const utf16Stats = { present: 0, missing: 0, nullCount: 0, nonStringCount: 0, emptyCount: 0, whitespaceOnlyCount: 0, nonWhitespaceCount: 0 };
    const textStats = { present: 0, missing: 0, nullCount: 0, nonStringCount: 0, emptyCount: 0, whitespaceOnlyCount: 0, nonWhitespaceCount: 0 };

    let totalNonWhitespaceChars = 0;
    const usableTextLengths = [];
    let firstUsableTextEventIndex = null;
    let firstUsableTextSegmentIndex = null;

    const timestampValidity = {
      validStart: 0,
      missingStart: 0,
      invalidStart: 0,
      validDuration: 0,
      missingDuration: 0,
      invalidDuration: 0,
      validBoth: 0
    };

    function inspectTextField(val, stats) {
      if (val === undefined) {
        stats.missing++;
        return 0;
      }
      stats.present++;
      if (val === null) {
        stats.nullCount++;
        return 0;
      }
      if (typeof val !== 'string') {
        stats.nonStringCount++;
        return 0;
      }
      if (val.length === 0) {
        stats.emptyCount++;
        return 0;
      }
      const trimmedLen = val.trim().length;
      if (trimmedLen === 0) {
        stats.whitespaceOnlyCount++;
        return 0;
      }
      stats.nonWhitespaceCount++;
      return trimmedLen;
    }

    for (let i = 0; i < inspectCount; i++) {
      const event = events[i];
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        eventsMissingSegs++;
        continue;
      }

      let hasValidStart = false;
      let hasValidDuration = false;
      if (event.tStartMs === undefined) {
        timestampValidity.missingStart++;
      } else {
        const start = Number(event.tStartMs);
        if (Number.isFinite(start) && start >= 0) {
          timestampValidity.validStart++;
          hasValidStart = true;
        } else {
          timestampValidity.invalidStart++;
        }
      }

      if (event.dDurationMs === undefined) {
        timestampValidity.missingDuration++;
      } else {
        const dur = Number(event.dDurationMs);
        if (Number.isFinite(dur) && dur >= 0) {
          timestampValidity.validDuration++;
          hasValidDuration = true;
        } else {
          timestampValidity.invalidDuration++;
        }
      }

      if (hasValidStart && (hasValidDuration || event.dDurationMs === undefined)) {
        timestampValidity.validBoth++;
      }

      if (!('segs' in event) || event.segs === undefined) {
        eventsMissingSegs++;
        continue;
      }
      if (!Array.isArray(event.segs)) {
        eventsMissingSegs++;
        continue;
      }
      if (event.segs.length === 0) {
        eventsEmptySegs++;
        continue;
      }

      eventsWithNonEmptySegs++;
      let eventHadUsableText = false;

      for (let s = 0; s < event.segs.length; s++) {
        totalSegments++;
        const seg = event.segs[s];
        if (!seg || typeof seg !== 'object' || Array.isArray(seg)) continue;

        for (const [k, v] of Object.entries(seg)) {
          if (!segmentFieldStats[k]) {
            segmentFieldStats[k] = { count: 0, types: new Set() };
          }
          segmentFieldStats[k].count++;
          segmentFieldStats[k].types.add(v === null ? 'null' : typeof v);
        }

        const u8Len = inspectTextField(seg.utf8, utf8Stats);
        const u16Len = inspectTextField(seg.utf16, utf16Stats);
        const tLen = inspectTextField(seg.text, textStats);

        const bestLen = u8Len || u16Len || tLen;
        if (bestLen > 0) {
          totalNonWhitespaceChars += bestLen;
          if (usableTextLengths.length < 5000) {
            usableTextLengths.push(bestLen);
          }
          if (firstUsableTextSegmentIndex === null) {
            firstUsableTextSegmentIndex = totalSegments - 1;
          }
          eventHadUsableText = true;
        }
      }

      if (eventHadUsableText && firstUsableTextEventIndex === null) {
        firstUsableTextEventIndex = i;
      }
    }

    const formattedSegmentFieldStats = Object.create(null);
    for (const [k, v] of Object.entries(segmentFieldStats)) {
      formattedSegmentFieldStats[k] = { count: v.count, types: Array.from(v.types).sort() };
    }

    let lengthStats = { count: usableTextLengths.length, min: 0, max: 0, p50: 0, p90: 0, p95: 0 };
    if (usableTextLengths.length > 0) {
      usableTextLengths.sort((a, b) => a - b);
      lengthStats = {
        count: usableTextLengths.length,
        min: usableTextLengths[0],
        max: usableTextLengths[usableTextLengths.length - 1],
        p50: usableTextLengths[Math.floor(usableTextLengths.length * 0.50)],
        p90: usableTextLengths[Math.floor(usableTextLengths.length * 0.90)],
        p95: usableTextLengths[Math.floor(usableTextLengths.length * 0.95)]
      };
    }

    return {
      totalEvents,
      eventsInspected: inspectCount,
      allEventsInspected,
      totalSegments,
      eventsMissingSegs,
      eventsEmptySegs,
      eventsWithNonEmptySegs,
      segmentFieldStats: formattedSegmentFieldStats,
      utf8: utf8Stats,
      utf16: utf16Stats,
      text: textStats,
      totalNonWhitespaceChars,
      textLengths: lengthStats,
      firstUsableTextEventIndex,
      firstUsableTextSegmentIndex,
      timestampValidity
    };
  }

  function extractSafeJsonSchemaDiagnostics(parsedJson, { format = '', contentType = '', attemptedAdapters = [], recognizedAdapters = [], cueCount = 0, maxNodeBudget = 20000, maxDepth = 6 } = {}) {
    const rawFmt = typeof format === 'string' ? format.trim() : '';
    const topLevelType = Array.isArray(parsedJson) ? 'array' : (parsedJson === null ? 'null' : typeof parsedJson);
    const topLevelKeys = (parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson))
      ? Object.keys(parsedJson).slice(0, 30)
      : [];

    const likelyCollections = [];
    if (parsedJson && typeof parsedJson === 'object') {
      if (Array.isArray(parsedJson)) {
        likelyCollections.push({ name: 'root', type: 'array', count: parsedJson.length });
      } else {
        for (const [key, value] of Object.entries(parsedJson)) {
          if (Array.isArray(value)) {
            likelyCollections.push({ name: key, type: 'array', count: value.length });
          } else if (value && typeof value === 'object') {
            const childKeys = Object.keys(value).slice(0, 10);
            for (const ck of childKeys) {
              if (Array.isArray(value[ck])) {
                likelyCollections.push({ name: `${key}.${ck}`, type: 'array', count: value[ck].length });
              }
            }
          }
        }
      }
    }

    let eventCount = null;
    let eventsArray = [];
    if (Array.isArray(parsedJson?.events)) {
      eventCount = parsedJson.events.length;
      eventsArray = parsedJson.events;
    } else if (Array.isArray(parsedJson)) {
      eventCount = parsedJson.length;
      eventsArray = parsedJson;
    } else if (likelyCollections.length > 0) {
      eventCount = likelyCollections[0].count;
    }

    let firstEventKeys = [];
    let firstSegmentKeys = [];

    const firstEvent = Array.isArray(parsedJson?.events)
      ? parsedJson.events[0]
      : (Array.isArray(parsedJson) ? parsedJson[0] : null);

    if (firstEvent && typeof firstEvent === 'object') {
      firstEventKeys = Object.keys(firstEvent).slice(0, 20);
      if (Array.isArray(firstEvent.segs) && firstEvent.segs[0] && typeof firstEvent.segs[0] === 'object') {
        firstSegmentKeys = Object.keys(firstEvent.segs[0]).slice(0, 20);
      } else if (Array.isArray(firstEvent.segments) && firstEvent.segments[0] && typeof firstEvent.segments[0] === 'object') {
        firstSegmentKeys = Object.keys(firstEvent.segments[0]).slice(0, 20);
      }
    }

    const schemaCensus = performEventSchemaCensus(eventsArray, {
      maxNodeBudget,
      maxDepth
    });

    const fullPassJson3Census = eventsArray.length > 0
      ? performFullPassJson3Census(eventsArray)
      : null;

    return {
      contentType: String(contentType || ''),
      format: rawFmt || 'absent',
      fmtSupplied: Boolean(rawFmt),
      topLevelType,
      topLevelKeys,
      likelyCollections,
      eventCount,
      firstEventKeys,
      firstSegmentKeys,
      attemptedAdapters: [...attemptedAdapters],
      recognizedAdapters: [...recognizedAdapters],
      validCueCount: Number(cueCount || 0),
      schemaCensus,
      fullPassJson3Census
    };
  }

  function formatUnsupportedJsonDiagnostic(diagnostics, responseCharacters) {
    if (!diagnostics) return 'Unsupported YouTube caption JSON schema';
    const keysStr = diagnostics.topLevelKeys?.join(', ') || 'none';
    const collectionsStr = diagnostics.likelyCollections?.map(c => `${c.name}(${c.count})`).join(', ') || 'none';
    const eventKeysStr = diagnostics.firstEventKeys?.join(', ') || 'none';
    const segKeysStr = diagnostics.firstSegmentKeys?.join(', ') || 'none';
    const fmtDesc = (diagnostics.format && diagnostics.format !== 'absent')
      ? `fmt=${diagnostics.format} (explicit)`
      : 'fmt=absent (unspecified)';

    let text = `Unsupported YouTube caption JSON schema (${responseCharacters || 0} characters, ${fmtDesc}, contentType=${diagnostics.contentType || 'unknown'}). ` +
      `Top keys: [${keysStr}], Collections: [${collectionsStr}], Event count: ${diagnostics.eventCount ?? 'unknown'}, ` +
      `First event keys: [${eventKeysStr}], First seg keys: [${segKeysStr}], Adapters: [${(diagnostics.attemptedAdapters || []).join(', ')}].`;

    if (diagnostics.fullPassJson3Census) {
      const f = diagnostics.fullPassJson3Census;
      text += `\n[Full-Pass JSON3 Census (Inspected: ${f.eventsInspected}/${f.totalEvents})] ` +
        `Events with segs: ${f.eventsWithNonEmptySegs}, Missing: ${f.eventsMissingSegs}, Empty: ${f.eventsEmptySegs}, Segments: ${f.totalSegments}, ` +
        `Non-whitespace text count: utf8=${f.utf8.nonWhitespaceCount}, utf16=${f.utf16.nonWhitespaceCount}, text=${f.text.nonWhitespaceCount}, ` +
        `Whitespace-only: utf8=${f.utf8.whitespaceOnlyCount}, Total non-ws chars: ${f.totalNonWhitespaceChars}, ` +
        `First usable text event index: ${f.firstUsableTextEventIndex !== null ? f.firstUsableTextEventIndex : 'none'}, ` +
        `Timestamps: validStart=${f.timestampValidity.validStart}, invalidStart=${f.timestampValidity.invalidStart}, validBoth=${f.timestampValidity.validBoth}`;
    }

    if (diagnostics.schemaCensus) {
      const c = diagnostics.schemaCensus;
      text += `\n[Schema Census] Total events: ${c.totalEvents}, Events with 'segs': ${c.eventsWithSegs}` +
        ` (first at index: ${c.firstEventWithSegsIndex !== null ? c.firstEventWithSegsIndex : 'none'}), ` +
        `First string leaf at index: ${c.firstEventWithStringIndex !== null ? c.firstEventWithStringIndex : 'none'}.`;

      const freqEntries = Object.entries(c.eventKeyFrequencies || {});
      if (freqEntries.length > 0) {
        text += `\n[Schema Census] Key frequencies: ` + freqEntries.map(([k, count]) => `${k}:${count}`).join(', ');
      }

      const sigEntries = Object.entries(c.keySignatures || {});
      if (sigEntries.length > 0) {
        text += `\n[Schema Census] Key signatures (${sigEntries.length} distinct): ` +
          sigEntries.slice(0, 10).map(([sig, count]) => `[${sig}]:${count}`).join('; ');
      }

      const segLikeEntries = Object.entries(c.segmentLikeFields || {});
      if (segLikeEntries.length > 0) {
        text += `\n[Schema Census] Segment-like fields: ` +
          segLikeEntries.map(([f, info]) => `${f}(total=${info.count}, array=${info.arrayCount}, obj=${info.objectCount})`).join(', ');
      }

      if (Array.isArray(c.stringLeafPaths) && c.stringLeafPaths.length > 0) {
        text += `\n[Schema Census] String leaf paths (Sampled): ` +
          c.stringLeafPaths.map(slp => `${slp.path}(count=${slp.count}, len=${slp.minLength}..${slp.maxLength})`).join(', ');
      } else {
        text += `\n[Schema Census] String leaf paths (Sampled): none`;
      }

      if (Array.isArray(c.numericPaths) && c.numericPaths.length > 0) {
        text += `\n[Schema Census] Numeric paths: ` +
          c.numericPaths.map(np => `${np.path}(count=${np.count}, range=[${np.min}..${np.max}]${np.likelyTimestamp ? ', timestamp' : ''})`).join(', ');
      }

      if (Array.isArray(c.representativeEvents) && c.representativeEvents.length > 0) {
        text += `\n[Schema Census] Representative events (${c.representativeEvents.length}):`;
        for (const rep of c.representativeEvents) {
          const fieldDesc = Object.entries(rep.fieldTypes || {}).map(([k, t]) => `${k}:${t}`).join(', ');
          text += `\n  - Event #${rep.index} (${rep.reason}): { ${fieldDesc} }`;
        }
      }

      if (c.traversalBudget) {
        text += `\n[Schema Census] Traversal budget: ${c.traversalBudget.nodesVisited}/${c.traversalBudget.maxNodeBudget} nodes visited` +
          (c.traversalBudget.budgetExceeded ? ' [BUDGET EXCEEDED]' : ' [complete]');
      }
    }

    return text;
  }

  function parseCaptionResponse(rawBody, options = {}) {
    const text = typeof rawBody === 'string' ? rawBody : '';
    const trimmed = text.trim();
    const rawFormat = typeof options.format === 'string' ? options.format.trim() : '';
    const rawContentType = String(options.contentType || '').trim();
    const format = rawFormat.toLowerCase();
    const contentType = rawContentType.toLowerCase();
    const responseCharacters = Number(options.responseCharacters || text.length);

    if (!trimmed) {
      return {
        cues: [],
        formatRecognized: null,
        formatSupplied: rawFormat,
        detectionMethod: 'none',
        adapterAttempted: [],
        diagnostics: null,
        error: 'Empty caption response body'
      };
    }

    const adapterAttempted = [];
    const recognizedAdapters = [];

    // Distinguish explicitly supplied fmt parameter from absent fmt
    const isFmtExplicit = Boolean(format);
    const isFmtJson = format === 'json3';
    const isFmtXml = format === 'srv3' || format === 'srv1' || format === 'srv2' || format === 'default';
    const isFmtVtt = format === 'vtt';

    // Supporting evidence from payload signature
    const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');
    const looksLikeXml = trimmed.startsWith('<');
    const looksLikeVtt = trimmed.startsWith('WEBVTT');

    // Supporting evidence from Content-Type
    const isJsonContentType = contentType.includes('json');
    const isXmlContentType = contentType.includes('xml');
    const isVttContentType = contentType.includes('vtt');

    const detectionMethod = isFmtExplicit
      ? 'explicit-fmt'
      : (isJsonContentType || isXmlContentType || isVttContentType
          ? 'content-type'
          : (looksLikeJson || looksLikeXml || looksLikeVtt ? 'payload-signature' : 'fallback'));

    // Strategy 1: Explicit JSON format or detected as JSON via Content-Type or payload signature (and NOT XML/VTT)
    if (isFmtJson || ((looksLikeJson || isJsonContentType) && !looksLikeXml && !looksLikeVtt)) {
      let parsedJson = null;
      let jsonParseFailed = false;
      try {
        parsedJson = JSON.parse(trimmed);
      } catch (_) {
        jsonParseFailed = true;
      }

      if (!jsonParseFailed && parsedJson !== null) {
        adapterAttempted.push('json3');
        const cues = parseJson3TimedText(parsedJson);
        if (cues.length > 0) {
          recognizedAdapters.push('json3');
          return {
            cues,
            formatRecognized: 'json3',
            formatSupplied: rawFormat,
            detectionMethod,
            adapterAttempted,
            diagnostics: null,
            error: null
          };
        }

        // Valid JSON with unsupported schema.
        // Never pass arbitrary JSON to DOMParser/XML parser.
        // Do not re-run JSON3 parser.
        const diagnostics = extractSafeJsonSchemaDiagnostics(parsedJson, {
          format: rawFormat,
          contentType: rawContentType,
          attemptedAdapters: adapterAttempted,
          recognizedAdapters,
          cueCount: 0
        });

        return {
          cues: [],
          formatRecognized: null,
          formatSupplied: rawFormat,
          detectionMethod,
          adapterAttempted,
          diagnostics,
          error: 'Unsupported YouTube caption JSON schema'
        };
      }

      // JSON.parse failed. Only attempt XML/VTT if payload signature strongly indicates them.
      if (looksLikeXml || isXmlContentType) {
        adapterAttempted.push('xml');
        const xmlCues = parseXmlTimedText(trimmed);
        if (xmlCues.length > 0) {
          recognizedAdapters.push('xml');
          return { cues: xmlCues, formatRecognized: 'xml', formatSupplied: rawFormat, detectionMethod, adapterAttempted, diagnostics: null, error: null };
        }
      }
      if (looksLikeVtt || isVttContentType) {
        adapterAttempted.push('vtt');
        const vttCues = parseVttTimedText(trimmed);
        if (vttCues.length > 0) {
          recognizedAdapters.push('vtt');
          return { cues: vttCues, formatRecognized: 'vtt', formatSupplied: rawFormat, detectionMethod, adapterAttempted, diagnostics: null, error: null };
        }
      }

      return {
        cues: [],
        formatRecognized: null,
        formatSupplied: rawFormat,
        detectionMethod,
        adapterAttempted,
        diagnostics: null,
        error: 'Malformed JSON caption response'
      };
    }

    // Strategy 2: Explicit VTT format or starts with WEBVTT
    if (isFmtVtt || looksLikeVtt || isVttContentType) {
      adapterAttempted.push('vtt');
      const vttCues = parseVttTimedText(trimmed);
      if (vttCues.length > 0) {
        recognizedAdapters.push('vtt');
        return { cues: vttCues, formatRecognized: 'vtt', formatSupplied: rawFormat, detectionMethod, adapterAttempted, diagnostics: null, error: null };
      }
      if (looksLikeXml) {
        adapterAttempted.push('xml');
        const xmlCues = parseXmlTimedText(trimmed);
        if (xmlCues.length > 0) {
          return { cues: xmlCues, formatRecognized: 'xml', formatSupplied: rawFormat, detectionMethod, adapterAttempted, diagnostics: null, error: null };
        }
      }
    }

    // Strategy 3: XML format or looks like XML
    if (isFmtXml || looksLikeXml || isXmlContentType) {
      adapterAttempted.push('xml');
      const xmlCues = parseXmlTimedText(trimmed);
      if (xmlCues.length > 0) {
        recognizedAdapters.push('xml');
        return {
          cues: xmlCues,
          formatRecognized: 'xml',
          formatSupplied: rawFormat,
          detectionMethod,
          adapterAttempted,
          diagnostics: null,
          error: null
        };
      }

      // If XML produced 0 cues, check if the response was actually JSON
      if (looksLikeJson || isJsonContentType) {
        let parsedJson = null;
        try { parsedJson = JSON.parse(trimmed); } catch (_) {}
        if (parsedJson) {
          adapterAttempted.push('json3');
          const jsonCues = parseJson3TimedText(parsedJson);
          if (jsonCues.length > 0) {
            recognizedAdapters.push('json3');
            return { cues: jsonCues, formatRecognized: 'json3', formatSupplied: rawFormat, detectionMethod, adapterAttempted, diagnostics: null, error: null };
          }
          const diagnostics = extractSafeJsonSchemaDiagnostics(parsedJson, {
            format: rawFormat, contentType: rawContentType, attemptedAdapters: adapterAttempted, recognizedAdapters, cueCount: 0
          });
          return { cues: [], formatRecognized: null, formatSupplied: rawFormat, detectionMethod, adapterAttempted, diagnostics, error: 'Unsupported YouTube caption JSON schema' };
        }
      }
    }

    // Strategy 4: Fallback / Unknown format
    if (looksLikeJson) {
      let parsedJson = null;
      try { parsedJson = JSON.parse(trimmed); } catch (_) {}
      if (parsedJson) {
        adapterAttempted.push('json3');
        const cues = parseJson3TimedText(parsedJson);
        if (cues.length > 0) {
          return { cues, formatRecognized: 'json3', formatSupplied: rawFormat, detectionMethod, adapterAttempted, diagnostics: null, error: null };
        }
        const diagnostics = extractSafeJsonSchemaDiagnostics(parsedJson, {
          format: rawFormat, contentType: rawContentType, attemptedAdapters: adapterAttempted, recognizedAdapters, cueCount: 0
        });
        return { cues: [], formatRecognized: null, formatSupplied: rawFormat, detectionMethod, adapterAttempted, diagnostics, error: 'Unsupported YouTube caption JSON schema' };
      }
    }

    if (!adapterAttempted.includes('xml')) {
      adapterAttempted.push('xml');
      const xmlCues = parseXmlTimedText(trimmed);
      if (xmlCues.length > 0) {
        return { cues: xmlCues, formatRecognized: 'xml', formatSupplied: rawFormat, detectionMethod, adapterAttempted, diagnostics: null, error: null };
      }
    }

    if (!adapterAttempted.includes('vtt') && trimmed.includes('-->')) {
      adapterAttempted.push('vtt');
      const vttCues = parseVttTimedText(trimmed);
      if (vttCues.length > 0) {
        return { cues: vttCues, formatRecognized: 'vtt', formatSupplied: rawFormat, detectionMethod, adapterAttempted, diagnostics: null, error: null };
      }
    }

    return {
      cues: [],
      formatRecognized: null,
      formatSupplied: rawFormat,
      detectionMethod,
      adapterAttempted,
      diagnostics: null,
      error: 'Unrecognized caption format'
    };
  }

  globalThis.HoverNotesCaptionParser = Object.freeze({
    parseJson3TimedText,
    parseXmlTimedText,
    parseVttTimedText,
    parseCaptionResponse,
    validateAndSortCues,
    extractSafeJsonSchemaDiagnostics,
    formatUnsupportedJsonDiagnostic,
    performEventSchemaCensus,
    performFullPassJson3Census
  });
})();
