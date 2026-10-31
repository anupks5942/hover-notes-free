/**
 * Minimal allowlist sanitizer for the Markdown preview.
 *
 * Markdown can originate from captions, AI output, imported files or manual edits.
 * The preview must never execute raw HTML embedded in that content. This sanitizer
 * intentionally supports only the semantic tags emitted by the current renderer.
 */
(function initHoverNotesMarkdownSanitizer(root) {
  'use strict';

  const ALLOWED_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'UL', 'OL', 'LI', 'BLOCKQUOTE',
    'PRE', 'CODE', 'B', 'STRONG', 'I', 'EM', 'DEL', 'S',
    'SPAN', 'DIV', 'A', 'IMG', 'BR', 'HR',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD'
  ]);

  const DROP_WITH_CONTENT = new Set([
    'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH',
    'TEMPLATE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT',
    'OPTION', 'VIDEO', 'AUDIO', 'SOURCE', 'TRACK', 'CANVAS',
    'LINK', 'META', 'BASE'
  ]);

  const ALLOWED_ATTRIBUTES = {
    A: new Set(['href', 'target', 'rel', 'class', 'data-seconds']),
    IMG: new Set(['src', 'alt', 'title', 'loading', 'width', 'height']),
    CODE: new Set(['class']),
    SPAN: new Set(['class']),
    DIV: new Set(['class']),
    TH: new Set(['colspan', 'rowspan']),
    TD: new Set(['colspan', 'rowspan'])
  };

  function parseUrl(value, baseUrl) {
    try {
      return new URL(String(value || '').trim(), baseUrl);
    } catch (_) {
      return null;
    }
  }

  function isSafeLinkUrl(value, baseUrl) {
    const url = parseUrl(value, baseUrl);
    return Boolean(url && ['http:', 'https:', 'mailto:'].includes(url.protocol));
  }

  function isSafeImageUrl(value, baseUrl) {
    const raw = String(value || '').trim();
    if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(raw)) {
      return true;
    }

    const url = parseUrl(raw, baseUrl);
    if (!url) return false;
    if (url.protocol === 'https:' || url.protocol === 'http:') return true;

    const base = parseUrl(baseUrl, baseUrl);
    if (!base) return false;
    // Permit same-extension relative assets and Blob URLs created by this extension
    // page, but do not allow arbitrary file:, javascript:, or cross-origin blob URLs.
    if (url.protocol === 'chrome-extension:') return url.origin === base.origin;
    if (url.protocol === 'blob:') return url.origin === base.origin;
    return false;
  }

  function sanitizeClassName(value) {
    const allowed = [];
    for (const token of String(value || '').split(/\s+/).filter(Boolean)) {
      if (['latex-block', 'latex-inline', 'timestamp-link', 'preview-placeholder'].includes(token) ||
          /^language-[a-z0-9_+#.-]{1,32}$/i.test(token)) {
        allowed.push(token);
      }
    }
    return allowed.join(' ');
  }

  function sanitizeElement(element, baseUrl) {
    const tag = element.tagName;

    if (DROP_WITH_CONTENT.has(tag)) {
      element.remove();
      return;
    }

    if (!ALLOWED_TAGS.has(tag)) {
      // Preserve harmless text/formatting inside unknown semantic wrappers while
      // removing the wrapper itself. Its descendants are still sanitized.
      for (const child of Array.from(element.children)) sanitizeElement(child, baseUrl);
      element.replaceWith(...Array.from(element.childNodes));
      return;
    }

    const allowed = ALLOWED_ATTRIBUTES[tag] || new Set();
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (!allowed.has(name)) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (name === 'class') {
        const cleanClass = sanitizeClassName(attribute.value);
        if (cleanClass) element.setAttribute('class', cleanClass);
        else element.removeAttribute('class');
      } else if (name === 'href') {
        if (!isSafeLinkUrl(attribute.value, baseUrl)) element.removeAttribute('href');
      } else if (name === 'src') {
        if (!isSafeImageUrl(attribute.value, baseUrl)) element.removeAttribute('src');
      } else if (name === 'target') {
        if (attribute.value !== '_blank') element.removeAttribute('target');
      } else if (name === 'rel') {
        // Fixed value prevents opener access even if the source Markdown supplied
        // an unsafe rel value.
        element.setAttribute('rel', 'noopener noreferrer');
      } else if (name === 'data-seconds') {
        if (!/^\d+(?:\.\d+)?$/.test(attribute.value)) element.removeAttribute(name);
      } else if (name === 'loading') {
        if (!['lazy', 'eager'].includes(attribute.value)) element.removeAttribute(name);
      } else if (name === 'width' || name === 'height' || name === 'colspan' || name === 'rowspan') {
        if (!/^\d{1,4}$/.test(attribute.value)) element.removeAttribute(name);
      }
    }

    if (tag === 'A') {
      if (element.getAttribute('target') === '_blank') {
        element.setAttribute('rel', 'noopener noreferrer');
      }
      if (element.classList.contains('timestamp-link')) {
        const seconds = element.getAttribute('data-seconds');
        if (seconds === null || !Number.isFinite(Number(seconds))) {
          element.classList.remove('timestamp-link');
          element.removeAttribute('data-seconds');
        }
      }
    }

    if (tag === 'IMG' && !element.hasAttribute('src')) {
      element.remove();
      return;
    }

    for (const child of Array.from(element.children)) sanitizeElement(child, baseUrl);
  }

  function sanitizeToFragment(markup, options = {}) {
    if (typeof DOMParser === 'undefined' || typeof document === 'undefined') {
      throw new Error('DOMParser is required to sanitize Markdown preview content.');
    }

    const baseUrl = options.baseUrl || document.baseURI;
    const parsed = new DOMParser().parseFromString(String(markup || ''), 'text/html');
    for (const child of Array.from(parsed.body.children)) sanitizeElement(child, baseUrl);

    const fragment = document.createDocumentFragment();
    for (const child of Array.from(parsed.body.childNodes)) {
      fragment.appendChild(document.importNode(child, true));
    }
    return fragment;
  }

  const api = Object.freeze({
    sanitizeToFragment,
    isSafeLinkUrl,
    isSafeImageUrl
  });

  root.HoverNotesMarkdownSanitizer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
