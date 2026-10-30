/* Local, low-cost visual-detail scoring for automatic lecture screenshots.
 * This is a slide-likeness heuristic, not OCR or semantic image recognition.
 */
(() => {
  function analyzeRgbaPixels(pixels, width, height) {
    if (!pixels || !Number.isInteger(width) || !Number.isInteger(height) ||
        width < 8 || height < 8 || pixels.length < width * height * 4) {
      return { method: 'edge-density-v1', isStudyRelevant: false, score: 0,
        edgeDensity: 0, detailedTileCount: 0, reason: 'insufficient-image-data' };
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
    // Calibrated against the supplied 1:19 talking-head frame and 4:00 slide frame.
    const isStudyRelevant = edgeDensity >= 0.055 && detailedTileCount >= 5;
    const score = Math.max(0, Math.min(100, Math.round((edgeDensity / 0.12) * 70 + (detailedTileCount / 12) * 30)));
    return {
      method: 'edge-density-v1', isStudyRelevant, score,
      edgeDensity: Math.round(edgeDensity * 10000) / 10000,
      detailedTileCount,
      reason: isStudyRelevant ? 'sufficient-distributed-visual-detail' : 'low-slide-like-visual-detail'
    };
  }
  const api = { analyzeRgbaPixels };
  if (typeof globalThis !== 'undefined') globalThis.HoverNotesFrameQuality = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
