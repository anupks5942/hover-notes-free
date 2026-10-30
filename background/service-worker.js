/**
 * HoverNotes Clone - Background Service Worker (Manifest V3)
 * Handles extension action clicks, screen capture fallbacks, vault picker windows, and background coordination.
 */

// Initialize default storage on extension install or update
chrome.runtime.onInstalled.addListener(async (details) => {
  const current = await chrome.storage.local.get(['gemini_keys', 'active_key_index', 'gemini_model']);
  if (!current.gemini_keys) {
    await chrome.storage.local.set({
      gemini_keys: ['', '', ''],
      active_key_index: 0,
      gemini_model: 'gemini-3.8-flash',
      custom_endpoint_url: '',
      custom_api_key: '',
      custom_model: 'gpt-4o-mini'
    });
  } else if (!current.gemini_model) {
    await chrome.storage.local.set({
      gemini_model: 'gemini-3.8-flash'
    });
  }
});

// Extension toolbar icon click - toggles the HoverNotes sidebar on YouTube
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id || !tab.url) return;

  const isYouTube = tab.url.includes('youtube.com');
  if (!isYouTube) {
    return;
  }

  try {
    // Attempt sending toggle message directly to content script
    await chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_SIDEBAR' });
  } catch (err) {
    // If content script was not ready (e.g. tab opened before extension installed)
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content/content.css']
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/caption-parser.js', 'content/content.js']
      });
      // Retry toggle message after injection
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_SIDEBAR' }).catch(() => {});
      }, 200);
    } catch (injectionErr) {
      console.error('Failed to inject HoverNotes content scripts:', injectionErr);
    }
  }
});

// Message listener for background requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) {
    return false;
  }


  // Read YouTube's live player response in the page MAIN world. This avoids
  // relying on inline script tags that can be blocked or altered by page CSP.
  if (message.action === 'GET_MAIN_WORLD_CAPTION_TRACKS') {
    const tabId = sender.tab?.id;
    console.info('[HoverNotes SW Diagnostics] MAIN-world caption lookup requested', {
      tabId: Number.isInteger(tabId) ? tabId : null,
      videoId: String(message.videoId || '')
    });
    const expectedVideoId = String(message.videoId || '');
    if (!Number.isInteger(tabId) || !expectedVideoId) {
      sendResponse({ success: false, error: 'Missing YouTube tab or video ID.' });
      return false;
    }

    (async () => {
      let lastError = '';
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            args: [expectedVideoId],
            func: (videoId) => {
              const responses = [];
              if (window.ytInitialPlayerResponse) responses.push(window.ytInitialPlayerResponse);
              const appResponse = document.querySelector('ytd-app')?.__data?.playerResponse;
              if (appResponse) responses.push(appResponse);
              const raw = window.ytplayer?.config?.args?.raw_player_response;
              if (raw) {
                try { responses.push(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch (e) {}
              }
              for (const response of responses) {
                const actualId = response?.videoDetails?.videoId;
                if (actualId && actualId !== videoId) continue;
                const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                if (Array.isArray(tracks) && tracks.length) {
                  return { videoId: actualId || videoId, tracks };
                }
              }
              return { videoId, tracks: [] };
            }
          });
          const value = results?.[0]?.result;
          if (value?.videoId === expectedVideoId && Array.isArray(value.tracks) && value.tracks.length) {
            console.info('[HoverNotes SW Diagnostics] MAIN-world caption tracks found', {
              videoId: expectedVideoId, trackCount: value.tracks.length,
              tracks: value.tracks.map(t => ({ languageCode: t.languageCode || 'unknown', kind: t.kind || 'manual/standard', hasBaseUrl: Boolean(t.baseUrl) }))
            });
            sendResponse({ success: true, videoId: expectedVideoId, tracks: value.tracks });
            return;
          }
          lastError = 'Player response is present, but captionTracks is not available yet.';
        } catch (error) {
          lastError = error.message || String(error);
        }
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 250));
      }
      console.warn('[HoverNotes SW Diagnostics] MAIN-world lookup exhausted retries', {
        videoId: expectedVideoId, error: lastError
      });
      sendResponse({ success: true, videoId: expectedVideoId, tracks: [], error: lastError });
    })();
    return true;
  }

  // Open top-level vault picker window to avoid third-party iframe restriction
  if (message.action === 'OPEN_VAULT_PICKER') {
    const pickerUrl = chrome.runtime.getURL('sidebar/vault-picker.html');
    if (chrome.windows && chrome.windows.create) {
      chrome.windows.create({
        url: pickerUrl,
        type: 'popup',
        width: 500,
        height: 560,
        focused: true
      }, (win) => {
        sendResponse({ success: true, windowId: win?.id });
      });
      return true;
    } else {
      chrome.tabs.create({ url: pickerUrl }, (tab) => {
        sendResponse({ success: true, tabId: tab?.id });
      });
      return true;
    }
  }

  // Capture visible tab fallback for CORS-tainted video frames
  if (message.action === 'CAPTURE_VISIBLE_TAB') {
    const windowId = sender.tab ? sender.tab.windowId : undefined;
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        sendResponse({ success: false, error: chrome.runtime.lastError?.message || 'Capture failed' });
      } else {
        sendResponse({ success: true, dataUrl });
      }
    });
    return true; // Keep channel open for asynchronous response
  }

  // Fetch URL with background origin permissions (bypassing page-level CSP)
  if (message.action === 'PROXY_FETCH') {
    const { url, options = {} } = message;
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch (e) {
      sendResponse({ success: false, error: 'Invalid proxy URL.' });
      return false;
    }
    // Keep the generic proxy constrained to services required by this extension.
    const allowedHost = parsedUrl.hostname === 'youtube.com' || parsedUrl.hostname.endsWith('.youtube.com') || parsedUrl.hostname === 'generativelanguage.googleapis.com';
    const safeRequest = {
      host: parsedUrl.hostname,
      path: parsedUrl.pathname,
      format: parsedUrl.searchParams.get('fmt') || 'xml',
      method: options.method || 'GET'
    };
    console.info('[HoverNotes SW Diagnostics] PROXY_FETCH received', safeRequest);
    if (!allowedHost || parsedUrl.protocol !== 'https:') {
      console.error('[HoverNotes SW Diagnostics] PROXY_FETCH rejected', {
        ...safeRequest, reason: 'Proxy URL host is not allowed or protocol is not HTTPS.'
      });
      sendResponse({ success: false, error: 'Proxy URL host is not allowed.' });
      return false;
    }
    fetch(parsedUrl.toString(), { ...options, credentials: options.credentials || 'include' })
      .then(async (response) => {
        const text = await response.text();
        const contentType = response.headers.get('content-type') || '';
        console.info('[HoverNotes SW Diagnostics] PROXY_FETCH response', {
          ...safeRequest, status: response.status, statusText: response.statusText,
          contentType, responseCharacters: text.length,
          redirected: response.redirected,
          finalHost: (() => { try { return new URL(response.url).hostname; } catch { return 'unknown'; } })()
        });
        sendResponse({
          success: response.ok,
          status: response.status,
          statusText: response.statusText,
          contentType,
          text
        });
      })
      .catch((error) => {
        console.error('[HoverNotes SW Diagnostics] PROXY_FETCH network error', {
          ...safeRequest, error: error.message || String(error)
        });
        sendResponse({
          success: false,
          error: error.message
        });
      });
    return true; // Keep channel open for asynchronous response
  }

  // Query tab status or state
  if (message.action === 'GET_CURRENT_TAB_ID') {
    sendResponse({ tabId: sender.tab ? sender.tab.id : null });
    return false;
  }

  return false;
});
