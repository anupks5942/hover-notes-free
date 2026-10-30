/* Local, low-cost visual scoring and transcript-aware screenshot gating.
 * Visual detail alone is not educational relevance. We combine it with a
 * conservative transcript promotion filter and perceptual duplicate checks.
 */
(() => {
  function differenceHashForRect(pixels, width, height, rect = { left: 0, top: 0, right: 1, bottom: 1 }) {
    if (!pixels || width < 9 || height < 8 || pixels.length < width * height * 4) return '';
    const left = Math.max(0, Math.min(width - 1, Math.floor(rect.left * width)));
    const top = Math.max(0, Math.min(height - 1, Math.floor(rect.top * height)));
    const right = Math.max(left + 1, Math.min(width, Math.ceil(rect.right * width)));
    const bottom = Math.max(top + 1, Math.min(height, Math.ceil(rect.bottom * height)));
    const regionWidth = right - left;
    const regionHeight = bottom - top;
    const samples = new Uint8Array(9 * 8);
    for (let gy = 0; gy < 8; gy++) {
      const y = Math.min(bottom - 1, top + Math.floor(((gy + 0.5) / 8) * regionHeight));
      for (let gx = 0; gx < 9; gx++) {
        const x = Math.min(right - 1, left + Math.floor(((gx + 0.5) / 9) * regionWidth));
        const offset = (y * width + x) * 4;
        samples[gy * 9 + gx] = Math.round(
          0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2]
        );
      }
    }
    let bits = '';
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) bits += samples[y * 9 + x] > samples[y * 9 + x + 1] ? '1' : '0';
    }
    let hex = '';
    for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
  }

  function fingerprintRgbaPixels(pixels, width, height) {
    return differenceHashForRect(pixels, width, height);
  }

  function fingerprintRegionsRgbaPixels(pixels, width, height) {
    // Regional hashes make slide deduplication more robust when the instructor
    // moves across the frame while the underlying slide remains unchanged.
    const regions = [
      { left: 0, top: 0, right: 0.5, bottom: 0.5 },
      { left: 0.5, top: 0, right: 1, bottom: 0.5 },
      { left: 0, top: 0.5, right: 0.5, bottom: 1 },
      { left: 0.5, top: 0.5, right: 1, bottom: 1 }
    ];
    return regions.map(rect => differenceHashForRect(pixels, width, height, rect));
  }

  function hammingDistanceHex(a, b) {
    if (!/^[0-9a-f]{16}$/i.test(String(a || '')) || !/^[0-9a-f]{16}$/i.test(String(b || ''))) return Infinity;
    let distance = 0;
    for (let i = 0; i < 16; i++) {
      let value = parseInt(a[i], 16) ^ parseInt(b[i], 16);
      while (value) { distance += value & 1; value >>>= 1; }
    }
    return distance;
  }

  function areNearDuplicateFingerprints(a, b, options = {}) {
    if (!a || !b) return false;
    const globalDistance = hammingDistanceHex(a.fingerprint, b.fingerprint);
    const globalThreshold = Number.isFinite(options.globalThreshold) ? options.globalThreshold : 10;
    if (globalDistance <= globalThreshold) return true;

    // Motion-aware fallback: if the instructor moves, the full-frame dHash can
    // change substantially while the upper slide content remains stable. Require
    // both a bounded global distance and two adjacent matching regions.
    const motionGlobalThreshold = Number.isFinite(options.motionGlobalThreshold) ? options.motionGlobalThreshold : 25;
    const regionThreshold = Number.isFinite(options.regionThreshold) ? options.regionThreshold : 21;
    if (globalDistance > motionGlobalThreshold) return false;
    const left = Array.isArray(a.regionFingerprints) ? a.regionFingerprints : [];
    const right = Array.isArray(b.regionFingerprints) ? b.regionFingerprints : [];
    if (left.length !== 4 || right.length !== 4) return false;
    const matching = left.map((fingerprint, index) =>
      hammingDistanceHex(fingerprint, right[index]) <= regionThreshold
    );
    return (matching[0] && matching[1]) || (matching[2] && matching[3]) ||
      (matching[0] && matching[2]) || (matching[1] && matching[3]);
  }

  function analyzeTranscriptRelevance(transcriptText) {
    const text = String(transcriptText || '');
    const promotionalPatterns = [
      /15\s*(?:साल|years?)/iu, /कोचिंग/iu, /हजारों/iu, /कोर्स/iu,
      /प्रिपरेशन/iu, /सिलेबस|syllabus/i, /डिस्क्रिप्शन/iu,
      /सब्सक्राइब|subscribe/i, /लाइक\s*(?:बटन)?|like\s*(?:button)?/iu,
      /मिशन/iu, /फ्री|free/i, /रोडमैप|roadmap/i, /ट्रिक्स|shortcuts?/iu,
      /कमेंट|comment/i, /चैनल|channel/i, /support|सपोर्ट/iu, /एक्सपीरियंस|experience/i
    ];
    const instructionalPatterns = [
      /डेटा\s*स्ट्रक्चर|डाटा\s*स्ट्रक्चर/iu, /एल्गोरिथम|एल्गोरिदम/iu,
      /एरे|array/i, /स्टैक|stack/i, /क्यू|queue/i, /लिंक्ड\s*लिस्ट|linked\s*list/i,
      /ट्री|tree/i, /मेमोरी|memory/i, /एलिमेंट|element/i,
      /इंसर्ट|insert/i, /डिलीट|delete/i, /सर्चिंग|searching/i,
      /प्रॉब्लम\s*सॉल्व|problem\s*solv/i, /टाइम\s*(?:एंड|and)\s*मेमोरी|time\s*(?:and|&)\s*memory/i,
      /कंप्यूटर\s*साइंस|computer\s*science/i, /अल्गोरिद्मिक|algorithmic/i,
      /पेरेंट|parent/i, /चाइल्ड|child/i, /ऑपरेशन|operation/i
    ];
    const countMatches = patterns => patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
    const promotionalSignals = countMatches(promotionalPatterns);
    const instructionalSignals = countMatches(instructionalPatterns);
    // Conservative: only suppress a screenshot when the interval is clearly
    // promotional and contains no meaningful instructional signal.
    const isPromotional = promotionalSignals >= 3 && instructionalSignals === 0;
    return {
      isPromotional,
      promotionalSignals,
      instructionalSignals,
      shouldSuppressFrames: isPromotional,
      reason: isPromotional ? 'promotional-introduction-no-instructional-signals' : 'not-classified-as-promotional'
    };
  }

  function analyzeRgbaPixels(pixels, width, height) {
    if (!pixels || !Number.isInteger(width) || !Number.isInteger(height) ||
        width < 8 || height < 8 || pixels.length < width * height * 4) {
      return { method: 'edge-density-dhash-v2', isStudyRelevant: false, score: 0,
        edgeDensity: 0, detailedTileCount: 0, fingerprint: '', reason: 'insufficient-image-data' };
    }
    const luminance = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < luminance.length; i++, p += 4) {
      luminance[i] = Math.round(0.2126 * pixels[p] + 0.7152 * pixels[p + 1] + 0.0722 * pixels[p + 2]);
    }
    const tileColumns = 4, tileRows = 3;
    const tileEdges = new Uint32Array(tileColumns * tileRows);
    const tilePixels = new Uint32Array(tileColumns * tileRows);
    let totalEdges = 0, totalPixels = 0;
    for (let y = 1; y < height; y++) {
      const tileY = Math.min(tileRows - 1, Math.floor((y / height) * tileRows));
      for (let x = 1; x < width; x++) {
        const index = y * width + x;
        const dx = Math.abs(luminance[index] - luminance[index - 1]);
        const dy = Math.abs(luminance[index] - luminance[index - width]);
        const tileX = Math.min(tileColumns - 1, Math.floor((x / width) * tileColumns));
        const tileIndex = tileY * tileColumns + tileX;
        tilePixels[tileIndex]++;
        totalPixels++;
        if (dx >= 32 || dy >= 32) { tileEdges[tileIndex]++; totalEdges++; }
      }
    }
    const edgeDensity = totalPixels ? totalEdges / totalPixels : 0;
    let detailedTileCount = 0;
    for (let i = 0; i < tileEdges.length; i++) {
      if (tilePixels[i] && tileEdges[i] / tilePixels[i] >= 0.055) detailedTileCount++;
    }
    const isStudyRelevant = edgeDensity >= 0.055 && detailedTileCount >= 5;
    const score = Math.max(0, Math.min(100, Math.round((edgeDensity / 0.12) * 70 + (detailedTileCount / 12) * 30)));
    return {
      method: 'edge-density-dhash-v2', isStudyRelevant, score,
      edgeDensity: Math.round(edgeDensity * 10000) / 10000,
      detailedTileCount,
      fingerprint: fingerprintRgbaPixels(pixels, width, height),
      regionFingerprints: fingerprintRegionsRgbaPixels(pixels, width, height),
      reason: isStudyRelevant ? 'sufficient-distributed-visual-detail' : 'low-slide-like-visual-detail'
    };
  }

  const api = { analyzeRgbaPixels, analyzeTranscriptRelevance, fingerprintRgbaPixels, fingerprintRegionsRgbaPixels, hammingDistanceHex, areNearDuplicateFingerprints };
  if (typeof globalThis !== 'undefined') globalThis.HoverNotesFrameQuality = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
