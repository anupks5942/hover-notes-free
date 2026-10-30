/**
 * HoverNotes Clone - Production Sidebar Controller
 * Features: Strict Per-Video State Isolation, Continuous Auto-Pilot Lecture Watcher,
 * Deterministic Frame Embedding, Multi-Segment Sequential Synthesis, and Live LaTeX/Markdown Preview.
 */

(() => {
  // Application State (Keyed strictly by videoId)
  const state = {
    currentVideoId: '',
    videoState: {
      videoId: '',
      videoTitle: 'Untitled YouTube Video',
      channelName: 'YouTube Creator',
      videoUrl: '',
      currentTime: 0,
      timestampStr: '00:00',
      duration: 0,
      durationStr: '00:00',
      paused: true,
      playbackRate: 1.0
    },
    vaultConnected: false,
    vaultNeedsPermission: false,
    vaultName: '',
    isAutoNotesActive: false,
    autoNotesInterval: null,
    isGeneratingAI: false,
    activeGenerationController: null,
    flushAfterCurrentGeneration: false,
    generationSettled: null,
    autoSaveTimer: null,
    isDirty: false,
    // Per-video tracking
    lastProcessedTime: 0,
    imageCache: new Map() // relative path / filename -> base64 dataUrl
  };

  // DOM Elements
  const elements = {
    vaultPillBtn: document.getElementById('vault-pill-btn'),
    vaultStatusText: document.getElementById('vault-status-text'),
    viewSplitBtn: document.getElementById('view-split-btn'),
    viewEditBtn: document.getElementById('view-edit-btn'),
    viewPreviewBtn: document.getElementById('view-preview-btn'),
    settingsOpenBtn: document.getElementById('settings-open-btn'),
    exitSidebarBtn: document.getElementById('exit-sidebar-btn'),
    noteTitleInput: document.getElementById('note-title-input'),
    saveStatusIndicator: document.getElementById('save-status-indicator'),
    saveStatusText: document.getElementById('save-status-text'),
    aiStatusIndicator: document.getElementById('ai-status-indicator'),
    aiStatusText: document.getElementById('ai-status-text'),
    workspaceContainer: document.getElementById('workspace-container'),
    noteEditor: document.getElementById('note-editor'),
    notePreview: document.getElementById('note-preview'),
    pbRewindBtn: document.getElementById('pb-rewind-btn'),
    pbToggleBtn: document.getElementById('pb-toggle-btn'),
    pbPlayIcon: document.getElementById('pb-play-icon'),
    pbPauseIcon: document.getElementById('pb-pause-icon'),
    pbForwardBtn: document.getElementById('pb-forward-btn'),
    speedPills: document.querySelectorAll('.speed-pill'),
    btnTimestamp: document.getElementById('btn-timestamp'),
    btnCapture: document.getElementById('btn-capture'),
    btnAiNotes: document.getElementById('btn-ai-notes'),
    aiBtnText: document.getElementById('ai-btn-text'),
    aiLoadingSpinner: document.getElementById('ai-loading-spinner'),
    quickTimestampTool: document.getElementById('quick-timestamp-tool'),
    // Settings Modal
    settingsModal: document.getElementById('settings-modal'),
    modalCloseBtn: document.getElementById('modal-close-btn'),
    modalVaultDot: document.getElementById('modal-vault-dot'),
    modalVaultName: document.getElementById('modal-vault-name'),
    modalConnectVaultBtn: document.getElementById('modal-connect-vault-btn'),
    modalDisconnectVaultBtn: document.getElementById('modal-disconnect-vault-btn'),
    geminiModelSelect: document.getElementById('gemini-model-select'),
    refreshModelsBtn: document.getElementById('refresh-models-btn'),
    geminiKey1: document.getElementById('gemini-key-1'),
    geminiKey2: document.getElementById('gemini-key-2'),
    geminiKey3: document.getElementById('gemini-key-3'),
    customEndpointUrl: document.getElementById('custom-endpoint-url'),
    customApiKey: document.getElementById('custom-api-key'),
    customModel: document.getElementById('custom-model'),
    testConnectionBtn: document.getElementById('test-connection-btn'),
    saveSettingsBtn: document.getElementById('save-settings-btn'),
    settingsStatusBox: document.getElementById('settings-status-box')
  };

  // =========================================================================
  // Bridge Communication with Content Script
  // =========================================================================

  function sendBridgeMessage(action, payload = {}) {
    return new Promise((resolve) => {
      const requestId = 'req_' + Math.random().toString(36).substring(2, 9);

      let timeoutId = null;
      const responseListener = (event) => {
        if (event.source !== window.parent) return;
        if (event.data && event.data.responseToId === requestId) {
          window.removeEventListener('message', responseListener);
          if (timeoutId) clearTimeout(timeoutId);
          resolve(event.data);
        }
      };

      window.addEventListener('message', responseListener);
      timeoutId = setTimeout(() => {
        window.removeEventListener('message', responseListener);
        resolve({ success: false, error: 'Bridge request timed out' });
      }, 30000);

      window.parent.postMessage({ action, payload, requestId }, '*');
    });
  }

  // Handle messages posted from parent window / content script
  window.addEventListener('message', async (event) => {
    if (event.source !== window.parent) return;
    if (!event.data || typeof event.data !== 'object') return;
    const { action, videoState, active } = event.data;

    if (action === 'VIDEO_CHANGED') {
      await handleVideoChanged(videoState || event.data.state);
    } else if (action === 'SPLIT_STATE_CHANGED') {
      if (videoState) updateVideoUIState(videoState);
    } else if (action === 'TRIGGER_CAPTURE') {
      handleManualCapture();
    } else if (action === 'TRIGGER_TIMESTAMP') {
      handleInsertTimestamp();
    }
  });

  // Query video state from YouTube
  async function queryVideoState() {
    const res = await sendBridgeMessage('GET_VIDEO_STATE');
    if (res && res.success && res.state) {
      updateVideoUIState(res.state);
    }
    return state.videoState;
  }

  function updateVideoUIState(newState) {
    if (!newState) return;
    Object.assign(state.videoState, newState);

    // Play/Pause Icons
    if (state.videoState.paused) {
      elements.pbPlayIcon.classList.remove('hidden');
      elements.pbPauseIcon.classList.add('hidden');
    } else {
      elements.pbPlayIcon.classList.add('hidden');
      elements.pbPauseIcon.classList.remove('hidden');
    }

    // Playback Speed Pill
    const curRate = parseFloat(state.videoState.playbackRate) || 1.0;
    elements.speedPills.forEach(pill => {
      const pillSpeed = parseFloat(pill.dataset.speed);
      pill.classList.toggle('active', Math.abs(pillSpeed - curRate) < 0.05);
    });
  }

  // =========================================================================
  // Spec 3: Strict Per-Video Isolation
  // =========================================================================

  function getStorageKey(keyType, videoId) {
    const vId = videoId || state.currentVideoId || 'default';
    return `hn_${keyType}_${vId}`;
  }

  // Handle switching video sessions (SPA navigation)
  async function handleVideoChanged(newVideoState) {
    if (!newVideoState || !newVideoState.videoId) return;
    const newVideoId = newVideoState.videoId;

    // Abort and await the previous generation before saving/switching contexts.
    // This prevents a partial streamed section from leaking into the old video's note.
    if (state.isAutoNotesActive || state.isGeneratingAI) {
      toggleAutoNotes(false, { abortActive: true });
      if (state.generationSettled) await state.generationSettled;
    }

    if (state.isDirty && state.currentVideoId) {
      await saveCurrentNote();
    }

    // Switch active video context
    state.currentVideoId = newVideoId;
    updateVideoUIState(newVideoState);

    // 4. Load persisted lastProcessedTime for this video
    const stored = await chrome.storage.local.get([
      getStorageKey('last_processed', newVideoId),
      getStorageKey('note_content', newVideoId),
      getStorageKey('note_title', newVideoId)
    ]);

    state.lastProcessedTime = stored[getStorageKey('last_processed', newVideoId)] || 0;

    // 5. Load note content for this specific video
    await loadNoteForVideo(newVideoId, newVideoState.videoTitle, stored);
  }

  async function loadNoteForVideo(videoId, videoTitle, preloadedStorage = {}) {
    const targetTitle = preloadedStorage[getStorageKey('note_title', videoId)] || videoTitle || 'Untitled Video Note';
    elements.noteTitleInput.value = targetTitle;

    // Try reading existing file from vault first
    if (state.vaultConnected) {
      try {
        const vaultText = await window.obsidianStorage.readNoteFile(targetTitle);
        if (vaultText && vaultText.trim().length > 0) {
          elements.noteEditor.value = vaultText;
          renderMarkdownPreview();
          showSaveStatus('Vault note loaded');
          return;
        }
      } catch (e) {}
    }

    // Fallback: Check local extension storage for this video
    const cachedContent = preloadedStorage[getStorageKey('note_content', videoId)];
    if (cachedContent && cachedContent.trim().length > 0) {
      elements.noteEditor.value = cachedContent;
      renderMarkdownPreview();
      showSaveStatus('Session note loaded');
      return;
    }

    // Initialize clean note template with frontmatter
    const initialFrontmatter = `---
title: "${targetTitle.replace(/"/g, "'")}"
source: "${state.videoState.videoUrl || window.location.href}"
channel: "${state.videoState.channelName || 'YouTube'}"
date: "${new Date().toISOString().substring(0, 19).replace('T', ' ')}"
tags: [hovernotes, gate-cs, study-notes]
---

# ${targetTitle}

`;

    elements.noteEditor.value = initialFrontmatter;
    renderMarkdownPreview();
    scheduleAutoSave();
  }

  // =========================================================================
  // Note Saving (Vault + Per-Video Storage)
  // =========================================================================

  function scheduleAutoSave() {
    state.isDirty = true;
    showSaveStatus('Saving...', false, true);

    if (state.autoSaveTimer) clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = setTimeout(async () => {
      await saveCurrentNote();
    }, 1500);
  }

  async function saveCurrentNote() {
    if (state.autoSaveTimer) {
      clearTimeout(state.autoSaveTimer);
      state.autoSaveTimer = null;
    }
    const videoId = state.currentVideoId;
    if (!videoId) return;

    const title = elements.noteTitleInput.value.trim() || state.videoState.videoTitle || 'Untitled Video Note';
    const content = elements.noteEditor.value;

    // Save to isolated per-video extension storage
    try {
      await chrome.storage.local.set({
        [getStorageKey('note_content', videoId)]: content,
        [getStorageKey('note_title', videoId)]: title,
        [getStorageKey('last_processed', videoId)]: state.lastProcessedTime
      });

      if (state.vaultConnected) {
        await window.obsidianStorage.saveNoteFile(title, content);
        state.isDirty = false;
        const now = new Date();
        const timeStr = now.toTimeString().split(' ')[0];
        showSaveStatus(`Saved at ${timeStr}`);
      } else {
        state.isDirty = false;
        showSaveStatus('Saved locally (Connect vault to sync)');
      }
      return true;
    } catch (err) {
      console.error('[HoverNotes] Note save error:', err);
      state.isDirty = true;
      showSaveStatus('Save failed: ' + err.message, true);
      return false;
    }
  }

  function showSaveStatus(text, isError = false, isPending = false) {
    elements.saveStatusText.textContent = text;
    // Keep the full diagnostic available even when the compact status bar clips it.
    elements.saveStatusIndicator.title = String(text || 'Auto-save to Obsidian vault');
    elements.saveStatusIndicator.classList.remove('saved', 'saving');

    if (isError) {
      elements.saveStatusIndicator.style.color = 'var(--color-red)';
    } else if (isPending) {
      elements.saveStatusIndicator.classList.add('saving');
      elements.saveStatusIndicator.style.color = 'var(--color-amber)';
    } else {
      elements.saveStatusIndicator.classList.add('saved');
      elements.saveStatusIndicator.style.color = 'var(--color-green)';
    }
  }

  // =========================================================================
  // Editor Cursor and Markdown Helpers
  // =========================================================================

  function insertTextAtCursor(text) {
    const editor = elements.noteEditor;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const val = editor.value;

    editor.value = val.substring(0, start) + text + val.substring(end);
    editor.selectionStart = editor.selectionEnd = start + text.length;
    editor.focus();

    renderMarkdownPreview();
    scheduleAutoSave();
  }

  function appendTextToEnd(text) {
    const editor = elements.noteEditor;
    editor.value += text;
    editor.scrollTop = editor.scrollHeight;
    renderMarkdownPreview();
    // Defer persistence until the complete AI chunk has succeeded. This prevents
    // half-written streamed output from being mistaken for a completed checkpoint.
    if (!state.isGeneratingAI) scheduleAutoSave();
  }

  // =========================================================================
  // Spec 2: Deterministic Screenshot Capture & Embedding
  // =========================================================================

  // Capture a frame in memory first. AI generation persists it only after the
  // text request succeeds, preventing orphaned image files on transcript/API errors.
  async function captureFrameData(fallbackSeconds = 0) {
    const frameRes = await sendBridgeMessage('CAPTURE_FRAME');
    if (!frameRes || !frameRes.success || !frameRes.dataUrl) {
      throw new Error(frameRes?.error || 'Frame capture failed');
    }
    const capturedSeconds = Math.floor(frameRes.videoState?.currentTime ?? fallbackSeconds ?? 0);
    return {
      dataUrl: frameRes.dataUrl,
      seconds: capturedSeconds,
      timestamp: formatTime(capturedSeconds)
    };
  }

  async function persistCapturedFrame(title, frameData, videoUrl) {
    if (!state.vaultConnected) {
      throw new Error('Connect your Obsidian vault before saving screenshots.');
    }
    const saved = await window.obsidianStorage.saveScreenshotFile(title, frameData.timestamp, frameData.dataUrl);
    const fileName = saved.fileName;
    const markdownLink = saved.markdownLink;
    state.imageCache.set(fileName, frameData.dataUrl);
    state.imageCache.set(`images/${fileName}`, frameData.dataUrl);
    state.imageCache.set(`HoverNotes/images/${fileName}`, frameData.dataUrl);
    const separator = videoUrl.includes('?') ? '&' : '?';
    const embedBlock = `\n\n### [${frameData.timestamp}](${videoUrl}${separator}t=${frameData.seconds}s)\n${markdownLink}\n\n`;
    appendTextToEnd(embedBlock);
    return { fileName, dataUrl: frameData.dataUrl, markdownLink, seconds: frameData.seconds, timestamp: frameData.timestamp };
  }

  async function captureAndEmbedFrame(title, timestampStr, seconds, videoUrl) {
    const frameData = await captureFrameData(seconds);
    return persistCapturedFrame(title, frameData, videoUrl);
  }

  // Manual Capture Button (I)
  async function handleManualCapture() {
    showSaveStatus('Capturing slide frame...');
    elements.btnCapture.classList.add('loading');

    try {
      const video = await queryVideoState();
      const title = elements.noteTitleInput.value.trim() || video.videoTitle || 'Lecture';
      const timestampStr = video.timestampStr || '00:00';
      const seconds = Math.floor(video.currentTime || 0);
      const videoUrl = video.videoUrl || window.location.href;

      await captureAndEmbedFrame(title, timestampStr, seconds, videoUrl);
      showSaveStatus('Slide snapshot saved & embedded!');
    } catch (err) {
      console.error('[HoverNotes] Capture error:', err);
      showSaveStatus('Capture failed: ' + err.message, true);
    } finally {
      elements.btnCapture.classList.remove('loading');
    }
  }

  // Insert Timestamp Button (T)
  async function handleInsertTimestamp() {
    const video = await queryVideoState();
    const timestampStr = video.timestampStr || '00:00';
    const seconds = Math.floor(video.currentTime || 0);
    const videoUrl = video.videoUrl || window.location.href;

    insertTextAtCursor(`[${timestampStr}](${videoUrl}&t=${seconds}s) `);
  }

  // =========================================================================
  // Spec 3 & Spec 4: Auto-Pilot Continuous AI Lecture Watcher
  // =========================================================================

  function createFreshNoteTemplate(title) {
    const safeTitle = String(title || 'Untitled Video Note').replace(/"/g, "'");
    return `---
title: "${safeTitle}"
source: "${state.videoState.videoUrl || window.location.href}"
channel: "${state.videoState.channelName || 'YouTube'}"
date: "${new Date().toISOString().substring(0, 19).replace('T', ' ')}"
tags: [hovernotes, gate-cs, study-notes]
---

# ${safeTitle}

`;
  }

  async function startFreshBenchmarkRunIfNeeded(video) {
    const noteText = elements.noteEditor.value.trim();
    const bodyWithoutFrontmatter = noteText.replace(/^---[\s\S]*?---\s*/, '');
    const hasExistingSections = /\n#{2,3}\s+/.test(bodyWithoutFrontmatter);
    if (state.lastProcessedTime <= 0 && !hasExistingSections) return true;

    const confirmed = window.confirm(
      'A previous note or processing checkpoint exists for this video. Start a fresh benchmark run from 00:00?\n\n' +
      'First export the previous HoverNotes output ZIP. This will reset this video\'s note and processing checkpoint in the connected vault.'
    );
    if (!confirmed) return false;

    state.lastProcessedTime = 0;
    elements.noteTitleInput.value = video.videoTitle || 'Lecture';
    elements.noteEditor.value = createFreshNoteTemplate(elements.noteTitleInput.value);
    renderMarkdownPreview();
    const resetSaved = await saveCurrentNote();
    if (!resetSaved) {
      showSaveStatus('Could not reset benchmark note. Check vault permissions.', true);
      return false;
    }
    return true;
  }

  function toggleAutoNotes(forceState, options = {}) {
    const nextState = (forceState !== undefined) ? forceState : !state.isAutoNotesActive;
    if (nextState === state.isAutoNotesActive && !options.abortActive) return;

    if (nextState) {
      state.isAutoNotesActive = true;
      elements.btnAiNotes.classList.add('recording-active');
      if (elements.aiBtnText) elements.aiBtnText.textContent = 'Stop';
      elements.aiStatusIndicator.classList.remove('hidden');
      elements.aiStatusText.textContent = 'AI is watching lecture...';

      (async () => {
        try {
          const video = await queryVideoState();
          if (!state.isAutoNotesActive) return;
          if (!state.vaultConnected) {
            toggleAutoNotes(false);
            showSaveStatus('Connect your Obsidian vault before generating benchmark notes.', true);
            elements.aiStatusText.textContent = 'Vault connection required';
            return;
          }
          if (video.currentTime <= 2) {
            const ok = await startFreshBenchmarkRunIfNeeded(video);
            if (!ok) {
              toggleAutoNotes(false);
              return;
            }
          }
          await triggerAutoNotesSynthesis(); // No-op at 00:00 until real video time has elapsed.
        } catch (err) {
          toggleAutoNotes(false);
          showSaveStatus('Could not start AI Notes: ' + err.message, true);
        }
      })();

      // Accumulate 60 seconds of video time before each request (30 seconds at 2x).
      state.autoNotesInterval = setInterval(async () => {
        if (!state.isAutoNotesActive || state.isGeneratingAI) return;
        try {
          const video = await queryVideoState();
          const current = Math.floor(video.currentTime || 0);
          if (!video.paused && current - state.lastProcessedTime >= 60) {
            await triggerAutoNotesSynthesis();
          }
        } catch (err) {
          console.warn('[HoverNotes] Playback monitor failed:', err);
        }
      }, 10000);
    } else {
      state.isAutoNotesActive = false;
      elements.btnAiNotes.classList.remove('recording-active');
      if (elements.aiBtnText) elements.aiBtnText.textContent = 'AI Notes';
      if (state.autoNotesInterval) {
        clearInterval(state.autoNotesInterval);
        state.autoNotesInterval = null;
      }

      if (options.abortActive && state.activeGenerationController) {
        state.flushAfterCurrentGeneration = false;
        state.activeGenerationController.abort();
      } else if (state.isGeneratingAI) {
        // Stop scheduling new segments, finish the active one, then flush any tail.
        state.flushAfterCurrentGeneration = true;
        elements.aiStatusText.textContent = 'Finishing current segment…';
        showSaveStatus('Finishing current segment and saving remaining lecture time…');
        return;
      } else {
        elements.aiStatusIndicator.classList.add('hidden');
        showSaveStatus(options.abortActive ? 'AI generation cancelled' : 'Flushing remaining lecture time…');
        if (!options.abortActive) {
          state.flushAfterCurrentGeneration = false;
          triggerAutoNotesSynthesis({ force: true });
        }
        return;
      }

      elements.aiStatusIndicator.classList.add('hidden');
      showSaveStatus('AI generation cancelled');
    }
  }

  // Process only newly elapsed video time. Advance the checkpoint after a successful save.
  async function triggerAutoNotesSynthesis({ force = false } = {}) {
    if (state.isGeneratingAI) return false;

    state.isGeneratingAI = true;
    let settleGeneration;
    state.generationSettled = new Promise(resolve => { settleGeneration = resolve; });
    const controller = new AbortController();
    state.activeGenerationController = controller;
    const signal = controller.signal;
    const videoIdAtStart = state.currentVideoId;
    const originalContent = elements.noteEditor.value;
    const startTime = Math.floor(state.lastProcessedTime || 0);
    let endTime = startTime;
    let didAppend = false;

    elements.aiLoadingSpinner.classList.remove('hidden');
    elements.aiStatusIndicator.classList.remove('hidden');
    elements.aiStatusText.textContent = 'Preparing transcript and visual evidence…';
    showSaveStatus('Preparing lecture segment…');

    try {
      const video = await queryVideoState();
      endTime = Math.floor(video.currentTime || 0);
      if (!videoIdAtStart || videoIdAtStart !== state.currentVideoId) throw new DOMException('Video changed.', 'AbortError');
      if (endTime <= startTime || (!force && endTime - startTime < 60)) return false;
      if (!state.vaultConnected) throw new Error('Connect your Obsidian vault before generating notes.');

      const title = elements.noteTitleInput.value.trim() || video.videoTitle || 'Lecture';
      const videoUrl = video.videoUrl || window.location.href;

      // Capture in memory (not on disk) and use the actual frame timestamp.
      // Do not persist/embed the frame unless transcript extraction and AI synthesis succeed.
      const frameData = await captureFrameData(endTime);
      endTime = frameData.seconds;
      if (endTime <= startTime) throw new Error('The captured frame did not advance beyond the last processed timestamp.');
      if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');

      const sliceRes = await sendBridgeMessage('GET_TRANSCRIPT_SLICE', { startTime, endTime });
      if (!sliceRes || !sliceRes.success) throw new Error(sliceRes?.error || 'Transcript extraction failed.');
      if (!sliceRes.lines || sliceRes.lines.length === 0 || !sliceRes.transcriptText?.trim()) {
        const details = sliceRes?.diagnostic ? ` Details: ${sliceRes.diagnostic}` : '';
        throw new Error(`No captions were available for this interval. Progress was not advanced.${details}`);
      }
      if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');

      const CHUNK_SIZE = 300;
      const fullLines = sliceRes.lines;
      const segmentCount = Math.max(1, Math.ceil((endTime - startTime) / CHUNK_SIZE));
      let generatedChars = 0;
      didAppend = true; // Streamed AI text mutates the editor; rollback on any failure.

      for (let seg = 0; seg < segmentCount; seg++) {
        if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
        const segStart = startTime + seg * CHUNK_SIZE;
        const segEnd = Math.min(endTime, segStart + CHUNK_SIZE);
        const segLines = fullLines.filter(line => {
          const match = line.match(/^\[(?:(\d{1,2}):)?(\d{2}):(\d{2})\]/);
          if (!match) return false;
          const h = match[1] ? parseInt(match[1], 10) : 0;
          const m = parseInt(match[2], 10);
          const sec = parseInt(match[3], 10);
          const absolute = h * 3600 + m * 60 + sec;
          return absolute >= segStart && absolute < segEnd + (seg === segmentCount - 1 ? 1 : 0);
        });
        if (segLines.length === 0) continue;

        elements.aiStatusText.textContent = `Generating segment ${seg + 1}/${segmentCount} (${formatTime(segStart)}–${formatTime(segEnd)})…`;
        const priorNotes = elements.noteEditor.value.slice(-12000);
        const generated = await window.geminiClient.generateNotesStream({
          videoTitle: title,
          currentTimestamp: `${formatTime(segStart)}–${formatTime(segEnd)}`,
          transcriptChunk: segLines.join('\n'),
          // The only captured still belongs to the latest segment, not earlier segments.
          frameBase64: seg === segmentCount - 1 ? frameData.dataUrl : null,
          modeLabel: 'Transcript-grounded lecture notes',
          existingNotes: priorNotes,
          signal,
          onChunk: (chunkText) => appendTextToEnd(chunkText),
          onComplete: () => appendTextToEnd('\n\n')
        });
        if (generated && generated.trim()) generatedChars += generated.length;
      }

      if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
      if (generatedChars === 0) throw new Error('The AI returned no note content. Progress was not advanced.');
      if (videoIdAtStart !== state.currentVideoId) throw new DOMException('Video changed.', 'AbortError');

      // Persist the visual asset and its Obsidian link only after AI text completed.
      await persistCapturedFrame(title, frameData, videoUrl);
      if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');

      state.lastProcessedTime = endTime;
      const saved = await saveCurrentNote();
      if (!saved) throw new Error('The note could not be saved. Progress was not committed.');
      showSaveStatus(`Saved lecture notes through ${formatTime(endTime)}`);
      return true;
    } catch (err) {
      if (videoIdAtStart === state.currentVideoId && didAppend) {
        elements.noteEditor.value = originalContent;
        renderMarkdownPreview();
        state.lastProcessedTime = startTime;
        await saveCurrentNote();
      }
      if (err.name === 'AbortError') {
        console.info('[HoverNotes AI] Current generation cancelled:', err.message);
      } else {
        console.error('[HoverNotes AI] Synthesis error:', err);
        showSaveStatus('AI Error: ' + err.message, true);
        // The red AI banner is intentionally compact; retain the complete error on hover.
        elements.aiStatusIndicator.title = String(err.message || 'AI generation failed');
        elements.aiStatusText.title = String(err.message || 'AI generation failed');
        elements.aiStatusText.textContent = err.message;
        if (err.message?.includes('No captions were available')) {
          state.isAutoNotesActive = false;
          if (state.autoNotesInterval) clearInterval(state.autoNotesInterval);
          state.autoNotesInterval = null;
          elements.btnAiNotes.classList.remove('recording-active');
          if (elements.aiBtnText) elements.aiBtnText.textContent = 'AI Notes';
          state.flushAfterCurrentGeneration = false;
        }
      }
      return false;
    } finally {
      state.isGeneratingAI = false;
      state.activeGenerationController = null;
      if (settleGeneration) settleGeneration();
      state.generationSettled = null;
      elements.aiLoadingSpinner.classList.add('hidden');
      if (state.isAutoNotesActive) {
        elements.aiStatusText.textContent = 'AI is watching lecture…';
      } else {
        elements.aiStatusIndicator.classList.add('hidden');
      }

      if (state.flushAfterCurrentGeneration && !signal.aborted && videoIdAtStart === state.currentVideoId) {
        state.flushAfterCurrentGeneration = false;
        setTimeout(() => triggerAutoNotesSynthesis({ force: true }), 0);
      }
    }
  }

  function formatTime(seconds) {
    const s = Math.floor(Math.max(0, seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  // =========================================================================
  // High-Fidelity Markdown & LaTeX Preview Renderer
  // =========================================================================

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function formatInline(text) {
    return text
      .replace(/\*\*\*(.*?)\*\*\*/g, '<b><i>$1</i></b>')
      .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.*?)\*/g, '<i>$1</i>')
      .replace(/~~(.*?)~~/g, '<del>$1</del>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  function renderMarkdownPreview() {
    const raw = elements.noteEditor.value;
    if (!raw.trim()) {
      elements.notePreview.innerHTML = '<p class="preview-placeholder">Exhaustive study notes, LaTeX formulas, and slide snapshots will render here in real time...</p>';
      return;
    }

    let parsedHtml = parseMarkdownToHtml(raw);
    elements.notePreview.innerHTML = parsedHtml;

    // Attach click listeners to all timestamp links to seek video
    elements.notePreview.querySelectorAll('.timestamp-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const seconds = parseFloat(link.dataset.seconds);
        if (!isNaN(seconds)) {
          sendBridgeMessage('CONTROL_PLAYBACK', { type: 'seek', time: seconds });
        }
      });
    });
  }

  function parseMarkdownToHtml(md) {
    let content = md.replace(/^---[\s\S]*?---\s*/, '');

    // 1. Display LaTeX Math: $$...$$
    content = content.replace(/\$\$([\s\S]*?)\$\$/g, (match, eq) => {
      return `<div class="latex-block">$$ ${escapeHtml(eq.trim())} $$</div>`;
    });

    // 2. Inline LaTeX Math: $...$
    content = content.replace(/\$([^\$\n]+?)\$/g, (match, eq) => {
      return `<span class="latex-inline">$${escapeHtml(eq.trim())}$</span>`;
    });

    // 3. Fenced Code Blocks
    content = content.replace(/```([a-zA-Z0-9]*)\n([\s\S]*?)```/g, (match, lang, code) => {
      return `<pre><code class="language-${lang}">${escapeHtml(code)}</code></pre>`;
    });

    // 4. Obsidian Native WikiLink Images: ![[fileName.jpg]]
    content = content.replace(/!\[\[(.*?)\]\]/g, (match, rawName) => {
      const cleanName = rawName.trim();
      let imgSrc = cleanName;
      if (state.imageCache.has(cleanName)) {
        imgSrc = state.imageCache.get(cleanName);
      } else if (state.imageCache.has(`images/${cleanName}`)) {
        imgSrc = state.imageCache.get(`images/${cleanName}`);
      }
      return `<img src="${imgSrc}" alt="${escapeHtml(cleanName)}" loading="lazy">`;
    });

    // 5. Standard Markdown Images: ![alt](src)
    content = content.replace(/!\[(.*?)\]\((.*?)\)/g, (match, alt, src) => {
      const cleanSrc = src.trim();
      let imgSrc = cleanSrc;
      if (state.imageCache.has(cleanSrc)) {
        imgSrc = state.imageCache.get(cleanSrc);
      } else if (state.imageCache.has(decodeURIComponent(cleanSrc))) {
        imgSrc = state.imageCache.get(decodeURIComponent(cleanSrc));
      }
      return `<img src="${imgSrc}" alt="${escapeHtml(alt)}" loading="lazy">`;
    });

    // 6. YouTube Timestamp Links: [HH:MM:SS](URL&t=S)
    content = content.replace(/\[((?:\d{1,2}:)?\d{2}:\d{2})\]\(([^)]*t=(\d+)[^)]*)\)/g, (match, timeText, url, sec) => {
      return `<a href="${url}" class="timestamp-link" data-seconds="${sec}">⏱ ${timeText}</a>`;
    });

    // 7. Generic Markdown Links: [text](url)
    content = content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
    });

    const lines = content.split('\n');
    let htmlLines = [];
    let inList = false;
    let listType = 'ul';

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      if (!line.trim()) {
        if (inList) { htmlLines.push(`</${listType}>`); inList = false; }
        continue;
      }

      if (line.startsWith('<div class="latex-block"') || line.startsWith('<pre') || line.startsWith('<img') || line.startsWith('</pre>')) {
        if (inList) { htmlLines.push(`</${listType}>`); inList = false; }
        htmlLines.push(line);
        continue;
      }

      // Headings
      if (line.startsWith('### ')) {
        if (inList) { htmlLines.push(`</${listType}>`); inList = false; }
        htmlLines.push(`<h3>${formatInline(line.substring(4))}</h3>`);
        continue;
      }
      if (line.startsWith('## ')) {
        if (inList) { htmlLines.push(`</${listType}>`); inList = false; }
        htmlLines.push(`<h2>${formatInline(line.substring(3))}</h2>`);
        continue;
      }
      if (line.startsWith('# ')) {
        if (inList) { htmlLines.push(`</${listType}>`); inList = false; }
        htmlLines.push(`<h1>${formatInline(line.substring(2))}</h1>`);
        continue;
      }

      // Blockquotes
      if (line.startsWith('> ')) {
        if (inList) { htmlLines.push(`</${listType}>`); inList = false; }
        htmlLines.push(`<blockquote>${formatInline(line.substring(2))}</blockquote>`);
        continue;
      }

      // Bullet Lists
      if (line.startsWith('- ') || line.startsWith('* ')) {
        if (!inList || listType !== 'ul') {
          if (inList) htmlLines.push(`</${listType}>`);
          htmlLines.push('<ul>');
          inList = true;
          listType = 'ul';
        }
        htmlLines.push(`<li>${formatInline(line.substring(2))}</li>`);
        continue;
      }

      // Numbered Lists
      const numMatch = line.match(/^(\d+)\.\s+(.*)/);
      if (numMatch) {
        if (!inList || listType !== 'ol') {
          if (inList) htmlLines.push(`</${listType}>`);
          htmlLines.push('<ol>');
          inList = true;
          listType = 'ol';
        }
        htmlLines.push(`<li>${formatInline(numMatch[2])}</li>`);
        continue;
      }

      if (inList) {
        htmlLines.push(`</${listType}>`);
        inList = false;
      }

      htmlLines.push(`<p>${formatInline(line)}</p>`);
    }

    if (inList) htmlLines.push(`</${listType}>`);
    return htmlLines.join('\n');
  }

  // =========================================================================
  // Obsidian Vault UI and Permission Handling
  // =========================================================================

  async function checkVaultConnection() {
    const res = await window.obsidianStorage.restoreVault();
    if (res.connected) {
      setVaultUIConnected(res.name);
    } else if (res.needsPermission) {
      setVaultUINeedsPermission(res.name);
    } else {
      setVaultUIDisconnected();
    }
  }

  function setVaultUIConnected(name) {
    state.vaultConnected = true;
    state.vaultNeedsPermission = false;
    state.vaultName = name;

    elements.vaultPillBtn.className = 'vault-pill connected';
    elements.vaultPillBtn.title = `Connected to Obsidian Vault: ${name}`;
    elements.vaultStatusText.textContent = name;

    elements.modalVaultDot.className = 'vault-dot connected';
    elements.modalVaultName.textContent = `Connected: ${name}`;
    elements.modalConnectVaultBtn.textContent = 'Switch Vault Folder';
    elements.modalDisconnectVaultBtn.classList.remove('hidden');
  }

  function setVaultUINeedsPermission(name) {
    state.vaultConnected = false;
    state.vaultNeedsPermission = true;
    state.vaultName = name;

    elements.vaultPillBtn.className = 'vault-pill prompt';
    elements.vaultPillBtn.title = `Permission Required for: ${name}. Click to Reconnect.`;
    elements.vaultStatusText.textContent = 'Reconnect Vault';

    elements.modalVaultDot.className = 'vault-dot';
    elements.modalVaultName.textContent = `Pending Permission: ${name}`;
    elements.modalConnectVaultBtn.textContent = 'Reconnect Vault';
    elements.modalDisconnectVaultBtn.classList.remove('hidden');
  }

  function setVaultUIDisconnected() {
    state.vaultConnected = false;
    state.vaultNeedsPermission = false;
    state.vaultName = '';

    elements.vaultPillBtn.className = 'vault-pill disconnected';
    elements.vaultPillBtn.title = 'Click to Connect Obsidian Local Vault';
    elements.vaultStatusText.textContent = 'Connect Vault';

    elements.modalVaultDot.className = 'vault-dot';
    elements.modalVaultName.textContent = 'No Vault Connected';
    elements.modalConnectVaultBtn.textContent = 'Connect Vault';
    elements.modalDisconnectVaultBtn.classList.add('hidden');
  }

  async function handleVaultPillClick() {
    try {
      showSaveStatus('Opening Vault Picker...');
      await window.obsidianStorage.openVaultPickerWindow();
    } catch (err) {
      console.error('[HoverNotes Vault] Connection error:', err);
      showSaveStatus('Connection failed: ' + err.message, true);
    }
  }

  // =========================================================================
  // Settings Modal Controller
  // =========================================================================

  function updateModelDropdownOptions(models, activeModel) {
    if (!elements.geminiModelSelect || !Array.isArray(models) || models.length === 0) return;
    elements.geminiModelSelect.innerHTML = '';
    models.forEach(modelName => {
      const opt = document.createElement('option');
      opt.value = modelName;
      opt.textContent = modelName === 'gemini-3.8-flash'
        ? `${modelName} (Recommended)`
        : modelName;
      if (modelName === activeModel) opt.selected = true;
      elements.geminiModelSelect.appendChild(opt);
    });
    if (activeModel && models.includes(activeModel)) {
      elements.geminiModelSelect.value = activeModel;
    }
  }

  function openSettingsModal() {
    elements.settingsModal.classList.remove('hidden');
    elements.settingsStatusBox.className = 'settings-status-box hidden';

    elements.geminiKey1.value = window.geminiClient.geminiKeys[0] || '';
    elements.geminiKey2.value = window.geminiClient.geminiKeys[1] || '';
    elements.geminiKey3.value = window.geminiClient.geminiKeys[2] || '';
    if (elements.geminiModelSelect) {
      elements.geminiModelSelect.value = window.geminiClient.activeModel || 'gemini-3.8-flash';
    }
    elements.customEndpointUrl.value = window.geminiClient.customEndpointUrl || '';
    elements.customApiKey.value = window.geminiClient.customApiKey || '';
    elements.customModel.value = window.geminiClient.customModel || 'gpt-4o-mini';

    if (state.vaultConnected) {
      elements.modalVaultDot.className = 'vault-dot connected';
      elements.modalVaultName.textContent = `Connected: ${state.vaultName}`;
      elements.modalConnectVaultBtn.textContent = 'Switch Vault Folder';
      elements.modalDisconnectVaultBtn.classList.remove('hidden');
    } else {
      elements.modalVaultDot.className = 'vault-dot';
      elements.modalVaultName.textContent = 'No Vault Connected';
      elements.modalConnectVaultBtn.textContent = 'Connect Vault';
      elements.modalDisconnectVaultBtn.classList.add('hidden');
    }

    window.geminiClient.initConfig().then(() => {
      elements.geminiKey1.value = window.geminiClient.geminiKeys[0] || '';
      elements.geminiKey2.value = window.geminiClient.geminiKeys[1] || '';
      elements.geminiKey3.value = window.geminiClient.geminiKeys[2] || '';
    }).catch(() => {});
  }

  function closeSettingsModal() {
    elements.settingsModal.classList.add('hidden');
    elements.settingsStatusBox.className = 'settings-status-box hidden';
  }

  // =========================================================================
  // Toolbar Formatting Actions
  // =========================================================================

  function wrapSelection(prefix, suffix = prefix) {
    const editor = elements.noteEditor;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const val = editor.value;
    const selected = val.substring(start, end) || 'text';

    const replacement = prefix + selected + suffix;
    editor.value = val.substring(0, start) + replacement + val.substring(end);
    editor.selectionStart = start + prefix.length;
    editor.selectionEnd = start + prefix.length + selected.length;
    editor.focus();

    renderMarkdownPreview();
    scheduleAutoSave();
  }

  function insertLinePrefix(prefix) {
    const editor = elements.noteEditor;
    const start = editor.selectionStart;
    const val = editor.value;
    const lastNewline = val.lastIndexOf('\n', start - 1);
    const lineStart = lastNewline === -1 ? 0 : lastNewline + 1;

    editor.value = val.substring(0, lineStart) + prefix + val.substring(lineStart);
    editor.selectionStart = editor.selectionEnd = start + prefix.length;
    editor.focus();

    renderMarkdownPreview();
    scheduleAutoSave();
  }

  // =========================================================================
  // Event Listeners Setup
  // =========================================================================

  function setupEventListeners() {
    // Top Bar Actions
    elements.vaultPillBtn.addEventListener('click', handleVaultPillClick);
    elements.settingsOpenBtn.addEventListener('click', openSettingsModal);
    elements.modalCloseBtn.addEventListener('click', closeSettingsModal);
    elements.exitSidebarBtn.addEventListener('click', () => {
      sendBridgeMessage('CLOSE_SIDEBAR');
    });

    // View Switchers
    elements.viewSplitBtn.addEventListener('click', () => {
      elements.workspaceContainer.className = 'main-workspace split-view';
      elements.viewSplitBtn.classList.add('active');
      elements.viewEditBtn.classList.remove('active');
      elements.viewPreviewBtn.classList.remove('active');
    });

    elements.viewEditBtn.addEventListener('click', () => {
      elements.workspaceContainer.className = 'main-workspace editor-only';
      elements.viewSplitBtn.classList.remove('active');
      elements.viewEditBtn.classList.add('active');
      elements.viewPreviewBtn.classList.remove('active');
    });

    elements.viewPreviewBtn.addEventListener('click', () => {
      elements.workspaceContainer.className = 'main-workspace preview-only';
      elements.viewSplitBtn.classList.remove('active');
      elements.viewEditBtn.classList.remove('active');
      elements.viewPreviewBtn.classList.add('active');
      renderMarkdownPreview();
    });

    // Editor & Title inputs
    elements.noteEditor.addEventListener('input', () => {
      renderMarkdownPreview();
      scheduleAutoSave();
    });

    elements.noteTitleInput.addEventListener('input', () => {
      scheduleAutoSave();
    });

    // Playback Controls
    elements.pbToggleBtn.addEventListener('click', () => {
      sendBridgeMessage('CONTROL_PLAYBACK', { type: 'toggle' });
    });
    elements.pbRewindBtn.addEventListener('click', () => {
      sendBridgeMessage('CONTROL_PLAYBACK', { type: 'scrub', delta: -10 });
    });
    elements.pbForwardBtn.addEventListener('click', () => {
      sendBridgeMessage('CONTROL_PLAYBACK', { type: 'scrub', delta: 10 });
    });
    elements.speedPills.forEach(pill => {
      pill.addEventListener('click', () => {
        const speed = parseFloat(pill.dataset.speed);
        sendBridgeMessage('CONTROL_PLAYBACK', { type: 'setPlaybackRate', rate: speed });
        elements.speedPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
      });
    });

    // Main Actions
    elements.btnCapture.addEventListener('click', handleManualCapture);
    elements.btnTimestamp.addEventListener('click', handleInsertTimestamp);
    elements.quickTimestampTool.addEventListener('click', handleInsertTimestamp);
    elements.btnAiNotes.addEventListener('click', () => toggleAutoNotes());

    // Toolbar buttons
    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const action = btn.dataset.action;
        switch (action) {
          case 'bold': wrapSelection('**'); break;
          case 'italic': wrapSelection('*'); break;
          case 'h2': insertLinePrefix('## '); break;
          case 'h3': insertLinePrefix('### '); break;
          case 'bullet': insertLinePrefix('- '); break;
          case 'numbered': insertLinePrefix('1. '); break;
          case 'task': insertLinePrefix('- [ ] '); break;
          case 'code': wrapSelection('```\n', '\n```'); break;
          case 'latex': wrapSelection('$$', '$$'); break;
          case 'quote': insertLinePrefix('> '); break;
        }
      });
    });

    // Settings Modal
    elements.modalConnectVaultBtn.addEventListener('click', async () => {
      try {
        await window.obsidianStorage.openVaultPickerWindow();
      } catch (err) {
        showSettingsStatus('Failed to open vault picker: ' + err.message, false);
      }
    });

    elements.modalDisconnectVaultBtn.addEventListener('click', async () => {
      await window.obsidianStorage.clearHandleFromDB();
      setVaultUIDisconnected();
      showSettingsStatus('Obsidian vault disconnected.', true);
    });

    // Refresh Models
    if (elements.refreshModelsBtn) {
      elements.refreshModelsBtn.addEventListener('click', async () => {
        const key = elements.geminiKey1.value.trim() || elements.geminiKey2.value.trim() || elements.geminiKey3.value.trim();
        if (!key) {
          showSettingsStatus('Please enter a Gemini API Key first.', false);
          return;
        }
        showSettingsStatus('Querying models from Google API...', null);
        try {
          const models = await window.geminiClient.fetchAvailableModels(key);
          updateModelDropdownOptions(models, window.geminiClient.activeModel || 'gemini-3.8-flash');
          showSettingsStatus(`Found ${models.length} model(s): ${models.join(', ')}`, true);
        } catch (err) {
          showSettingsStatus(err.message, false);
        }
      });
    }

    // Test API Connection
    elements.testConnectionBtn.addEventListener('click', async () => {
      const modelToUse = elements.geminiModelSelect ? elements.geminiModelSelect.value : 'gemini-3.8-flash';
      showSettingsStatus(`Testing connection with ${modelToUse}...`, null);
      elements.testConnectionBtn.disabled = true;

      const keys = [
        elements.geminiKey1.value.trim(),
        elements.geminiKey2.value.trim(),
        elements.geminiKey3.value.trim()
      ];
      const customUrl = elements.customEndpointUrl.value.trim();
      const customKey = elements.customApiKey.value.trim();
      const customModel = elements.customModel.value.trim() || 'gpt-4o-mini';

      await window.geminiClient.saveConfig(
        keys,
        window.geminiClient.activeKeyIndex,
        customUrl,
        customKey,
        customModel,
        modelToUse
      );

      try {
        const res = await window.geminiClient.testConnection();
        if (res.models && Array.isArray(res.models)) {
          updateModelDropdownOptions(res.models, res.activeModel);
        }
        showSettingsStatus(res.message || 'API connection test passed!', true);
      } catch (err) {
        showSettingsStatus('Test failed: ' + err.message, false);
      } finally {
        elements.testConnectionBtn.disabled = false;
      }
    });

    // Save Settings
    elements.saveSettingsBtn.addEventListener('click', async () => {
      const keys = [
        elements.geminiKey1.value.trim(),
        elements.geminiKey2.value.trim(),
        elements.geminiKey3.value.trim()
      ];
      const model = elements.geminiModelSelect ? elements.geminiModelSelect.value : 'gemini-3.8-flash';
      const customUrl = elements.customEndpointUrl.value.trim();
      const customKey = elements.customApiKey.value.trim();
      const customModel = elements.customModel.value.trim() || 'gpt-4o-mini';

      await window.geminiClient.saveConfig(
        keys,
        window.geminiClient.activeKeyIndex,
        customUrl,
        customKey,
        customModel,
        model
      );

      showSettingsStatus('Settings saved successfully!', true);
      setTimeout(closeSettingsModal, 700);
    });

    // Toggle Password Visibility
    document.querySelectorAll('.toggle-pwd-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.target;
        const input = document.getElementById(targetId);
        if (input) {
          input.type = input.type === 'password' ? 'text' : 'password';
          btn.textContent = input.type === 'password' ? '👁' : '🔒';
        }
      });
    });

    // Modal backdrop click
    elements.settingsModal.addEventListener('click', (e) => {
      if (e.target === elements.settingsModal) closeSettingsModal();
    });

    // Close modal on Escape
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !elements.settingsModal.classList.contains('hidden')) {
        closeSettingsModal();
      }
    });

    // Support Tab key in markdown editor
    elements.noteEditor.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = elements.noteEditor.selectionStart;
        const end = elements.noteEditor.selectionEnd;
        const value = elements.noteEditor.value;

        if (e.shiftKey) {
          if (value.substring(start - 2, start) === '  ') {
            elements.noteEditor.value = value.substring(0, start - 2) + value.substring(start);
            elements.noteEditor.selectionStart = elements.noteEditor.selectionEnd = start - 2;
          }
        } else {
          elements.noteEditor.value = value.substring(0, start) + '  ' + value.substring(end);
          elements.noteEditor.selectionStart = elements.noteEditor.selectionEnd = start + 2;
        }
        renderMarkdownPreview();
        scheduleAutoSave();
      }
    });

    // Listen for vault connection broadcasts & hotkeys
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.action === 'VAULT_CONNECTED') {
        window.obsidianStorage.restoreVault().then((res) => {
          if (res && res.connected) {
            setVaultUIConnected(res.name);
            showSaveStatus(`Connected to Vault: ${res.name}`);
            if (state.currentVideoId) {
              loadNoteForVideo(state.currentVideoId, elements.noteTitleInput.value);
            }
          }
        });
      } else if (message && message.action === 'TRIGGER_SCREENSHOT_HOTKEY') {
        handleManualCapture();
      } else if (message && message.action === 'TRIGGER_TIMESTAMP_HOTKEY') {
        handleInsertTimestamp();
      }
    });
  }

  function showSettingsStatus(msg, isSuccess) {
    elements.settingsStatusBox.textContent = msg;
    elements.settingsStatusBox.classList.remove('hidden', 'success', 'error');
    if (isSuccess === true) elements.settingsStatusBox.classList.add('success');
    else if (isSuccess === false) elements.settingsStatusBox.classList.add('error');
  }

  // =========================================================================
  // Initialization
  // =========================================================================

  async function init() {
    setupEventListeners();

    // 1. Initialize Gemini client config
    await window.geminiClient.initConfig();

    // 2. Check and restore Obsidian Vault
    await checkVaultConnection();

    // 3. Query current YouTube video state
    const videoState = await queryVideoState();
    if (videoState && videoState.videoId) {
      await handleVideoChanged(videoState);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
