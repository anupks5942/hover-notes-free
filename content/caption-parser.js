/**
 * YouTube timed-text parsers.
 * JSON3 uses segs[].utf8 (not utf16); srv3 XML uses <p t="..." d="..."><s>...
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

  function parseJson3TimedText(json) {
    const events = Array.isArray(json?.events) ? json.events : [];
    const items = [];
    for (const event of events) {
      if (!Array.isArray(event?.segs) || !Number.isFinite(Number(event.tStartMs))) continue;
      const text = event.segs.map(segment =>
        segment?.utf8 ?? segment?.utf16 ?? segment?.text ?? ''
      ).join('').trim();
      if (!text) continue;
      items.push({
        start: Number(event.tStartMs) / 1000,
        duration: Number(event.dDurationMs || 0) / 1000,
        text: decodeEntities(text)
      });
    }
    return items;
  }

  function parseXmlTimedText(xmlText) {
    if (typeof DOMParser === 'undefined') return [];
    const doc = new DOMParser().parseFromString(String(xmlText || ''), 'text/xml');
    if (doc.querySelector('parsererror')) return [];
    const items = [];

    // Legacy timedtext: <text start="1.2" dur="2.3">...</text>
    for (const node of doc.querySelectorAll('text')) {
      const start = Number.parseFloat(node.getAttribute('start') || '0');
      const duration = Number.parseFloat(node.getAttribute('dur') || '0');
      const text = decodeEntities(node.textContent || '');
      if (text && Number.isFinite(start)) items.push({ start, duration, text });
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
        if (text && Number.isFinite(start)) items.push({ start, duration, text });
      }
    }
    return items;
  }

  globalThis.HoverNotesCaptionParser = Object.freeze({ parseJson3TimedText, parseXmlTimedText });
})();
