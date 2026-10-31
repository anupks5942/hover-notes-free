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
    stopRequestedAt: null,
    stopBoundaryReady: false,
    lastGenerationOutcome: null,
    isFinalizing: false,
    aiRunMetrics: null,
    generationSettled: null,
    autoSaveTimer: null,
    previewRenderTimer: null,
    previewRenderMetrics: { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
    isDirty: false,
    // Per-video tracking
    lastProcessedTime: 0,
    imageCache: new Map() // relative path / filename -> base64 dataUrl
  };

  function perfNow() {
    return (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
  }

  function elapsedMs(startedAt) {
    return Math.max(0, Math.round(perfNow() - startedAt));
  }

  function logPerformance(label, details) {
    // Only durations, counts, provider/model identifiers and key-slot numbers are logged.
    // Never log API keys, prompt text, transcript text, image data or caption bodies.
    console.info(`[HoverNotes Performance] ${label}`, details);
  }

  function setFinalizingUI(active, message = 'Finishing notes…') {
    state.isFinalizing = Boolean(active);
    elements.aiLoadingSpinner.classList.toggle('hidden', !active && !state.isGeneratingAI);
    elements.aiStatusIndicator.classList.toggle('hidden', !active && !state.isAutoNotesActive);
    elements.btnAiNotes.disabled = Boolean(active);
    if (elements.aiBtnText) elements.aiBtnText.textContent = active ? 'Finishing…' : 'AI Notes';
    elements.btnAiNotes.title = active
      ? 'Finishing the captured lecture interval. Please wait for the save confirmation.'
      : 'Toggle Auto-Notes Continuous Lecture Watcher';
    if (active) {
      elements.aiStatusText.textContent = message;
      showSaveStatus(message, false, true);
    }
  }

  function finishAutoNotesSession(stopAtTime) {
    void sendBridgeMessage('STOP_STUDY_FRAME_SAMPLER');
    const run = state.aiRunMetrics;
    if (run) {
      const generations = run.generations || [];
      const processedGenerations = generations.filter(item => item.transcriptLines > 0 || item.generatedCharacters > 0);
      logPerformance('AI Notes run completed', {
        videoId: run.videoId,
        stopAt: Number.isFinite(stopAtTime) ? formatTime(stopAtTime) : null,
        wallClockMs: elapsedMs(run.startedAt),
        generationCount: processedGenerations.length,
        operationCount: generations.length,
        sumGenerationMs: processedGenerations.reduce((sum, item) => sum + (item.totalMs || 0), 0),
        sumGeminiMs: processedGenerations.reduce((sum, item) => sum + (item.stages?.geminiMs || 0), 0),
        transcriptCharacters: processedGenerations.reduce((sum, item) => sum + (item.transcriptCharacters || 0), 0),
        generatedCharacters: processedGenerations.reduce((sum, item) => sum + (item.generatedCharacters || 0), 0),
        generations: processedGenerations.map(item => ({
          interval: item.interval,
          totalMs: item.totalMs,
          geminiMs: item.stages?.geminiMs || 0,
          generatedCharacters: item.generatedCharacters || 0,
          outcome: item.outcome
        }))
      });
    }
    state.aiRunMetrics = null;
    state.stopRequestedAt = null;
    state.stopBoundaryReady = false;
    state.lastGenerationOutcome = null;
    state.flushAfterCurrentGeneration = false;
    setFinalizingUI(false);
    elements.aiStatusIndicator.classList.add('hidden');
    elements.aiLoadingSpinner.classList.add('hidden');
  }

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

    state.stopRequestedAt = null;
    state.stopBoundaryReady = false;
    state.lastGenerationOutcome = null;
    state.isFinalizing = false;
    state.aiRunMetrics = null;

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
    // Streaming output can arrive in many small SSE deltas. Batch the expensive
    // whole-document Markdown parse/DOM replacement to at most ~7 times per second.
    scheduleMarkdownPreviewRender();
    // Defer persistence until the complete AI chunk has succeeded. This prevents
    // half-written streamed output from being mistaken for a completed checkpoint.
    if (!state.isGeneratingAI) scheduleAutoSave();
  }

  // =========================================================================
  // Spec 2: Deterministic Screenshot Capture & Embedding
  // =========================================================================

  // Capture a frame in memory first. AI generation persists it only after the
  // text request succeeds, preventing orphaned image files on transcript/API errors.
  async function captureFrameData(fallbackSeconds = 0, selection = {}) {
    const frameRes = await sendBridgeMessage('CAPTURE_FRAME', selection);
    if (!frameRes || !frameRes.success) throw new Error(frameRes?.error || 'Frame capture failed');
    const capturedSeconds = Math.floor(Number.isFinite(frameRes.frameTime)
      ? frameRes.frameTime : (frameRes.videoState?.currentTime ?? fallbackSeconds ?? 0));
    return {
      dataUrl: frameRes.dataUrl || null,
      seconds: capturedSeconds,
      timestamp: formatTime(capturedSeconds),
      quality: frameRes.frameQuality || null
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
    const embedBlock = `### [${frameData.timestamp}](${videoUrl}${separator}t=${frameData.seconds}s)\n${markdownLink}`;
    elements.noteEditor.value = window.geminiClient.insertTimestampedBlockChronologically(
      elements.noteEditor.value, embedBlock, frameData.seconds
    );
    scheduleMarkdownPreviewRender();
    if (!state.isGeneratingAI) scheduleAutoSave();
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
    if (state.isFinalizing && nextState) return;

    if (nextState) {
      state.isAutoNotesActive = true;
      state.stopRequestedAt = null;
      state.stopBoundaryReady = false;
      state.lastGenerationOutcome = null;
      state.flushAfterCurrentGeneration = false;
      state.aiRunMetrics = {
        videoId: state.currentVideoId,
        startedAt: perfNow(),
        generations: []
      };
      elements.btnAiNotes.classList.add('recording-active');
      elements.btnAiNotes.disabled = false;
      elements.btnAiNotes.title = 'Stop automatic lecture notes and finish the captured interval';
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
          void sendBridgeMessage('START_STUDY_FRAME_SAMPLER');
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
          // Stop can be clicked while this interval's GET_VIDEO_STATE bridge call is
          // pending. Recheck the flag after await so the monitor cannot launch a new
          // generation after the user has already requested Stop.
          if (!state.isAutoNotesActive) return;
          const current = Math.floor(video.currentTime || 0);
          if (!video.paused && current - state.lastProcessedTime >= 60) {
            await triggerAutoNotesSynthesis();
          }
        } catch (err) {
          console.warn('[HoverNotes] Playback monitor failed:', err);
        }
      }, 10000);
    } else {
      void sendBridgeMessage('STOP_STUDY_FRAME_SAMPLER');
      state.isAutoNotesActive = false;
      elements.btnAiNotes.classList.remove('recording-active');
      if (elements.aiBtnText) elements.aiBtnText.textContent = 'AI Notes';
      elements.btnAiNotes.disabled = false;
      elements.btnAiNotes.title = 'Toggle Auto-Notes Continuous Lecture Watcher';
      if (state.autoNotesInterval) {
        clearInterval(state.autoNotesInterval);
        state.autoNotesInterval = null;
      }

      if (options.abortActive && state.activeGenerationController) {
        state.flushAfterCurrentGeneration = false;
        state.stopRequestedAt = null;
        state.stopBoundaryReady = false;
        state.lastGenerationOutcome = null;
        state.isFinalizing = false;
        state.activeGenerationController.abort();
      } else {
        state.flushAfterCurrentGeneration = false;
        state.stopRequestedAt = null;
        state.stopBoundaryReady = false;
        state.lastGenerationOutcome = null;
        state.isFinalizing = false;
        if (!state.isGeneratingAI) {
          elements.aiStatusIndicator.classList.add('hidden');
          elements.aiLoadingSpinner.classList.add('hidden');
        }
      }

      if (options.abortActive) {
        elements.aiStatusIndicator.classList.add('hidden');
        elements.aiLoadingSpinner.classList.add('hidden');
        showSaveStatus('AI generation cancelled');
      }
    }
  }

  // Stop monitoring immediately, then freeze the current YouTube timestamp before
  // allowing an in-flight generation to finish and the final interval to be flushed.
  async function handleAutoNotesButtonClick() {
    if (state.isFinalizing) return;
    if (!state.isAutoNotesActive) {
      toggleAutoNotes(true);
      return;
    }

    const videoIdAtStop = state.currentVideoId;
    const generationWasActiveAtStop = state.isGeneratingAI;
    state.isAutoNotesActive = false;
    state.stopBoundaryReady = false;
    state.stopRequestedAt = Math.max(0, Math.floor(state.videoState.currentTime || 0));
    state.flushAfterCurrentGeneration = generationWasActiveAtStop;
    if (state.autoNotesInterval) {
      clearInterval(state.autoNotesInterval);
      state.autoNotesInterval = null;
    }
    elements.btnAiNotes.classList.remove('recording-active');
    setFinalizingUI(true, 'Capturing stop position…');
    elements.aiLoadingSpinner.classList.remove('hidden');

    let stopAtTime = Math.floor(state.videoState.currentTime || 0);
    try {
      const video = await queryVideoState();
      if (videoIdAtStop && video.videoId && video.videoId !== videoIdAtStop) {
        throw new DOMException('Video changed while stopping AI Notes.', 'AbortError');
      }
      const queriedCurrentTime = Number(video.currentTime);
      if (Number.isFinite(queriedCurrentTime) && queriedCurrentTime >= 0) {
        stopAtTime = Math.floor(queriedCurrentTime);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.info('[HoverNotes AI] Stop cancelled because the video changed.');
        finishAutoNotesSession(stopAtTime);
        return;
      }
      console.warn('[HoverNotes AI] Could not refresh stop position; using the latest known timestamp.');
    }

    if (videoIdAtStop !== state.currentVideoId) {
      finishAutoNotesSession(stopAtTime);
      return;
    }

    state.stopRequestedAt = Math.max(0, stopAtTime);
    state.stopBoundaryReady = true;
    const boundaryLabel = formatTime(state.stopRequestedAt);
    if (state.isGeneratingAI) {
      // The active request owns its original interval. Once it commits, process only
      // the remaining interval up to this frozen stop boundary.
      state.flushAfterCurrentGeneration = true;
      setFinalizingUI(true, `Finishing notes through ${boundaryLabel}…`);
      console.info('[HoverNotes AI] Stop requested; active generation will finish before final flush.', {
        stopAt: boundaryLabel,
        lastProcessedAt: formatTime(state.lastProcessedTime)
      });
      return;
    }

    state.flushAfterCurrentGeneration = false;
    if (generationWasActiveAtStop && !['saved', 'no-new-interval'].includes(state.lastGenerationOutcome)) {
      // If the in-flight request failed while the stop-position query was pending,
      // do not silently retry that same interval as a final flush.
      finishAutoNotesSession(state.stopRequestedAt);
      return;
    }
    setFinalizingUI(true, `Generating final notes through ${boundaryLabel}…`);
    void triggerAutoNotesSynthesis({
      force: true,
      endTimeLimit: state.stopRequestedAt,
      isFinalFlush: true
    });
  }

  // Process only newly elapsed video time. Advance the checkpoint after a successful save.
  // endTimeLimit is captured when Stop is clicked so an in-flight request cannot move the boundary.
  async function triggerAutoNotesSynthesis({ force = false, endTimeLimit = null, isFinalFlush = false } = {}) {
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
    let frameData = { dataUrl: null, seconds: null, timestamp: null, quality: null };
    let includeCapturedFrame = false;
    const startedAt = perfNow();
    const previewStart = { ...state.previewRenderMetrics };
    const report = {
      videoId: videoIdAtStart,
      interval: `${formatTime(startTime)}–pending`,
      startTime,
      endTime: null,
      totalMs: 0,
      stages: {},
      transcriptLines: 0,
      transcriptCharacters: 0,
      generatedCharacters: 0,
      segmentCount: 0,
      geminiAttempts: [],
      outcome: 'failed'
    };

    elements.aiLoadingSpinner.classList.remove('hidden');
    elements.aiStatusIndicator.classList.remove('hidden');
    elements.aiStatusText.textContent = isFinalFlush ? 'Generating final notes…' : 'Preparing transcript and visual evidence…';
    showSaveStatus(isFinalFlush ? 'Generating final lecture notes…' : 'Preparing lecture segment…', false, true);

    try {
      let stageStartedAt = perfNow();
      const video = await queryVideoState();
      report.stages.videoStateMs = elapsedMs(stageStartedAt);
      endTime = Math.floor(video.currentTime || 0);
      if (Number.isFinite(endTimeLimit)) endTime = Math.min(endTime, Math.floor(endTimeLimit));
      if (!videoIdAtStart || videoIdAtStart !== state.currentVideoId) throw new DOMException('Video changed.', 'AbortError');
      if (endTime <= startTime || (!force && endTime - startTime < 60)) {
        report.outcome = 'no-new-interval';
        return false;
      }
      if (!state.vaultConnected) throw new Error('Connect your Obsidian vault before generating notes.');

      const title = elements.noteTitleInput.value.trim() || video.videoTitle || 'Lecture';
      const videoUrl = video.videoUrl || window.location.href;

      if (endTime <= startTime) throw new Error('The video timestamp did not advance beyond the last processed timestamp.');
      if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');

      // Extract transcript first. Screenshot selection uses this interval's actual
      // words to suppress obvious promotional frames before saving any image.
      stageStartedAt = perfNow();
      const sliceRes = await sendBridgeMessage('GET_TRANSCRIPT_SLICE', { startTime, endTime });
      report.stages.transcriptExtractionMs = elapsedMs(stageStartedAt);
      if (!sliceRes || !sliceRes.success) throw new Error(sliceRes?.error || 'Transcript extraction failed.');
      if (!sliceRes.lines || sliceRes.lines.length === 0 || !sliceRes.transcriptText?.trim()) {
        const details = sliceRes?.diagnostic ? ` Details: ${sliceRes.diagnostic}` : '';
        throw new Error(`No captions were available for this interval. Progress was not advanced.${details}`);
      }
      if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');

      // Select a slide-like frame only when transcript context is not promotional.
      // Selection is passive; no seek/pause is performed by the sampler.
      stageStartedAt = perfNow();
      try {
        frameData = await captureFrameData(endTime, {
          selectBestStudyFrame: true, startTime, endTime,
          transcriptText: sliceRes.transcriptText
        });
        report.stages.frameCaptureMs = elapsedMs(stageStartedAt);
        const capturedFrameTime = Number.isFinite(frameData.seconds) ? Math.floor(frameData.seconds) : null;
        includeCapturedFrame = Boolean(frameData.dataUrl && frameData.quality?.isStudyRelevant);
        report.frameQuality = frameData.quality || null;
        if (!includeCapturedFrame) report.screenshotSkipped = frameData.quality?.reason || 'No study-relevant frame was available in this interval.';
        if (Number.isFinite(endTimeLimit)) {
          const frozenBoundary = Math.floor(endTimeLimit);
          // Keep transcript boundaries independent of the selected screenshot timestamp.
          endTime = Math.min(endTime, frozenBoundary);
          includeCapturedFrame = includeCapturedFrame && capturedFrameTime !== null && capturedFrameTime <= frozenBoundary;
          if (frameData.dataUrl && capturedFrameTime !== null && capturedFrameTime > frozenBoundary) {
            report.screenshotSkipped = 'The captured frame was after the frozen Stop boundary.';
            console.warn('[HoverNotes AI] Screenshot omitted because capture occurred after Stop.', {
              capturedFrameAt: formatTime(capturedFrameTime), stopBoundary: formatTime(frozenBoundary)
            });
          }
        }
      } catch (frameError) {
        // A screenshot is an enhancement, never a prerequisite for transcript-
        // grounded notes. Preserve the transcript interval and continue AI text.
        report.stages.frameCaptureMs = elapsedMs(stageStartedAt);
        frameData = { dataUrl: null, seconds: null, timestamp: null, quality: null };
        includeCapturedFrame = false;
        report.frameCaptureError = String(frameError?.message || frameError);
        report.screenshotSkipped = 'Frame capture failed; text notes continued without a screenshot.';
        console.warn('[HoverNotes AI] Frame capture failed; continuing without screenshot.', {
          videoId: videoIdAtStart,
          interval: `${formatTime(startTime)}–${formatTime(endTime)}`,
          error: report.frameCaptureError
        });
      }
      if (Number.isFinite(endTimeLimit)) {
        const frozenBoundary = Math.floor(endTimeLimit);
        // Keep transcript boundaries independent of the selected screenshot timestamp.
        endTime = Math.min(endTime, frozenBoundary);
        includeCapturedFrame = includeCapturedFrame && capturedFrameTime !== null && capturedFrameTime <= frozenBoundary;
        if (frameData.dataUrl && capturedFrameTime !== null && capturedFrameTime > frozenBoundary) {
          report.screenshotSkipped = 'The captured frame was after the frozen Stop boundary.';
          console.warn('[HoverNotes AI] Screenshot omitted because capture occurred after Stop.', {
            capturedFrameAt: formatTime(capturedFrameTime), stopBoundary: formatTime(frozenBoundary)
          });
        }
      }

      const CHUNK_SIZE = 300;
      const fullLines = sliceRes.lines;
      const segmentCount = Math.max(1, Math.ceil((endTime - startTime) / CHUNK_SIZE));
      report.interval = `${formatTime(startTime)}–${formatTime(endTime)}`;
      report.endTime = endTime;
      report.segmentCount = segmentCount;
      report.transcriptLines = fullLines.length;
      report.transcriptCharacters = sliceRes.transcriptText.length;
      report.caption = sliceRes.performance || null;
      if (sliceRes.performance) {
        report.stages.captionLoadMs = sliceRes.performance.totalLoadMs ?? null;
        report.stages.captionTrackDiscoveryMs = sliceRes.performance.trackDiscoveryMs ?? null;
        report.stages.captionPlayerWaitMs = sliceRes.performance.playerWaitMs ?? null;
        report.stages.captionParseMs = sliceRes.performance.captionParseMs ?? null;
        report.stages.transcriptSliceFilterMs = sliceRes.performance.sliceFilterMs ?? null;
      }
      report.stages.geminiMs = 0;
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
        const geminiStartedAt = perfNow();
        let generated = '';
        let segmentStreamStarted = false;
        try {
          generated = await window.geminiClient.generateNotesStream({
            videoTitle: title,
            currentTimestamp: `${formatTime(segStart)}–${formatTime(segEnd)}`,
            transcriptChunk: segLines.join('\n'),
            // The only captured still belongs to the latest segment, not earlier segments.
            frameBase64: seg === segmentCount - 1 && includeCapturedFrame ? frameData.dataUrl : null,
            frameTimestamp: seg === segmentCount - 1 && includeCapturedFrame ? frameData.timestamp : null,
            modeLabel: 'Transcript-grounded lecture notes',
            existingNotes: priorNotes,
            signal,
            onDiagnostics: (event) => {
              report.geminiAttempts.push(event);
              console.info('[HoverNotes Performance] Gemini attempt', {
                videoId: videoIdAtStart,
                interval: `${formatTime(segStart)}–${formatTime(segEnd)}`,
                ...event
              });
            },
            onChunk: (chunkText) => {
              if (!segmentStreamStarted && String(chunkText || '').length > 0) {
                const current = elements.noteEditor.value;
                if (current.trim() && !/\n{2}$/.test(current)) {
                  appendTextToEnd(current.endsWith('\n') ? '\n' : '\n\n');
                }
                segmentStreamStarted = true;
              }
              appendTextToEnd(chunkText);
            },
            onComplete: () => appendTextToEnd('\n\n')
          });
        } finally {
          report.stages.geminiMs += elapsedMs(geminiStartedAt);
        }
        if (generated && generated.trim()) {
          // The model must never be allowed to duplicate extension-managed media
          // embeds from prior-note context. Remove any such lines if it emits them.
          const cleanGenerated = window.geminiClient.sortTimestampedSections(
            window.geminiClient.sanitizePreviousNotes(generated)
          );
          if (cleanGenerated !== generated) {
            const streamedSuffix = `${generated}\n\n`;
            if (elements.noteEditor.value.endsWith(streamedSuffix)) {
              elements.noteEditor.value = elements.noteEditor.value.slice(0, -streamedSuffix.length) + `${cleanGenerated}\n\n`;
              scheduleMarkdownPreviewRender();
            }
            generated = cleanGenerated;
          }
          report.generatedCharacters += generated.length;
        }
      }

      if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
      if (report.generatedCharacters === 0) throw new Error('The AI returned no note content. Progress was not advanced.');
      if (videoIdAtStart !== state.currentVideoId) throw new DOMException('Video changed.', 'AbortError');

      // Persist the visual asset and its Obsidian link only after AI text completed.
      if (includeCapturedFrame) {
        stageStartedAt = perfNow();
        await persistCapturedFrame(title, frameData, videoUrl);
        if (frameData.quality?.fingerprint) {
          await sendBridgeMessage('MARK_STUDY_FRAME_USED', {
            fingerprint: frameData.quality.fingerprint,
            regionFingerprints: frameData.quality.regionFingerprints || []
          });
        }
        report.stages.framePersistenceMs = elapsedMs(stageStartedAt);
      } else {
        report.stages.framePersistenceMs = 0;
      }
      if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');

      // Normalize the complete document, not merely the latest AI response: this keeps
      // screenshot anchors, concept headings and repeated core definitions in one order.
      elements.noteEditor.value = window.geminiClient.normalizeNoteDocument(elements.noteEditor.value);
      stageStartedAt = perfNow();
      flushMarkdownPreviewRender();
      report.stages.finalPreviewRenderMs = elapsedMs(stageStartedAt);

      state.lastProcessedTime = endTime;
      stageStartedAt = perfNow();
      const saved = await saveCurrentNote();
      report.stages.noteSaveMs = elapsedMs(stageStartedAt);
      if (!saved) throw new Error('The note could not be saved. Progress was not committed.');
      report.outcome = 'saved';
      showSaveStatus(`Saved lecture notes through ${formatTime(endTime)}`);
      return true;
    } catch (err) {
      report.errorName = err.name || 'Error';
      if (videoIdAtStart === state.currentVideoId && didAppend) {
        elements.noteEditor.value = originalContent;
        flushMarkdownPreviewRender();
        state.lastProcessedTime = startTime;
        const rollbackStartedAt = perfNow();
        await saveCurrentNote();
        report.stages.rollbackSaveMs = elapsedMs(rollbackStartedAt);
      }
      if (err.name === 'AbortError') {
        report.outcome = 'aborted';
        console.info('[HoverNotes AI] Current generation cancelled:', err.message);
      } else {
        report.outcome = 'failed';
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
      report.totalMs = elapsedMs(startedAt);
      report.preview = {
        renderCount: state.previewRenderMetrics.count - previewStart.count,
        cumulativeRenderMs: Math.round((state.previewRenderMetrics.totalDurationMs - previewStart.totalDurationMs) * 100) / 100,
        averageRenderMs: (state.previewRenderMetrics.count - previewStart.count) > 0
          ? Math.round(((state.previewRenderMetrics.totalDurationMs - previewStart.totalDurationMs) /
            (state.previewRenderMetrics.count - previewStart.count)) * 100) / 100
          : 0
      };
      if (state.aiRunMetrics && state.aiRunMetrics.videoId === videoIdAtStart) {
        state.aiRunMetrics.generations.push(report);
      }
      logPerformance('Generation segment completed', {
        videoId: report.videoId,
        interval: report.interval,
        outcome: report.outcome,
        totalMs: report.totalMs,
        stages: report.stages,
        transcriptLines: report.transcriptLines,
        transcriptCharacters: report.transcriptCharacters,
        caption: report.caption,
        frameQuality: report.frameQuality || null,
        screenshotSkipped: report.screenshotSkipped || null,
        generatedCharacters: report.generatedCharacters,
        segmentCount: report.segmentCount,
        preview: report.preview,
        geminiAttemptCount: report.geminiAttempts.filter(event => event.type === 'attempt-start').length
      });

      state.lastGenerationOutcome = report.outcome;
      state.isGeneratingAI = false;
      state.activeGenerationController = null;
      if (settleGeneration) settleGeneration();
      state.generationSettled = null;

      const shouldFlushTail = state.flushAfterCurrentGeneration &&
        state.stopBoundaryReady &&
        !signal.aborted &&
        videoIdAtStart === state.currentVideoId &&
        (report.outcome === 'saved' || report.outcome === 'no-new-interval');
      if (shouldFlushTail) {
        state.flushAfterCurrentGeneration = false;
        const frozenStopAt = state.stopRequestedAt;
        const label = Number.isFinite(frozenStopAt) ? formatTime(frozenStopAt) : 'the paused position';
        setFinalizingUI(true, `Generating remaining notes through ${label}…`);
        setTimeout(() => {
          void triggerAutoNotesSynthesis({
            force: true,
            endTimeLimit: frozenStopAt,
            isFinalFlush: true
          });
        }, 0);
      } else if (state.isFinalizing && !state.stopBoundaryReady && !state.isAutoNotesActive && !signal.aborted) {
        // The Stop handler is still awaiting the exact player timestamp. Keep the
        // finishing indicator alive; that handler will schedule the bounded flush.
      } else if (isFinalFlush || (state.isFinalizing && !state.isAutoNotesActive && !signal.aborted)) {
        finishAutoNotesSession(state.stopRequestedAt);
      } else {
        elements.aiLoadingSpinner.classList.add('hidden');
        if (state.isAutoNotesActive) {
          elements.aiStatusText.textContent = 'AI is watching lecture…';
        } else {
          elements.aiStatusIndicator.classList.add('hidden');
        }
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

  function scheduleMarkdownPreviewRender() {
    if (state.previewRenderTimer) return;
    state.previewRenderTimer = setTimeout(() => {
      state.previewRenderTimer = null;
      elements.noteEditor.scrollTop = elements.noteEditor.scrollHeight;
      renderMarkdownPreview();
    }, 150);
  }

  function flushMarkdownPreviewRender() {
    if (state.previewRenderTimer) {
      clearTimeout(state.previewRenderTimer);
      state.previewRenderTimer = null;
    }
    elements.noteEditor.scrollTop = elements.noteEditor.scrollHeight;
    renderMarkdownPreview();
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
    if (state.previewRenderTimer) {
      clearTimeout(state.previewRenderTimer);
      state.previewRenderTimer = null;
    }
    const renderStartedAt = perfNow();
    const raw = elements.noteEditor.value;
    try {
      if (!raw.trim()) {
        elements.notePreview.innerHTML = '<p class="preview-placeholder">Exhaustive study notes, LaTeX formulas, and slide snapshots will render here in real time...</p>';
        return;
      }

      const parsedHtml = parseMarkdownToHtml(raw);
      const sanitizer = window.HoverNotesMarkdownSanitizer;
      if (!sanitizer || typeof sanitizer.sanitizeToFragment !== 'function') {
        throw new Error('Markdown preview sanitizer is unavailable.');
      }
      const safeFragment = sanitizer.sanitizeToFragment(parsedHtml);
      elements.notePreview.replaceChildren(safeFragment);

      // Attach click listeners to sanitized timestamp links to seek video
      elements.notePreview.querySelectorAll('.timestamp-link').forEach((link) => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          const seconds = parseFloat(link.dataset.seconds);
          if (!isNaN(seconds)) {
            sendBridgeMessage('CONTROL_PLAYBACK', { type: 'seek', time: seconds });
          }
        });
      });
    } finally {
      const duration = Math.max(0, perfNow() - renderStartedAt);
      state.previewRenderMetrics.count++;
      state.previewRenderMetrics.totalDurationMs += duration;
      state.previewRenderMetrics.maxDurationMs = Math.max(state.previewRenderMetrics.maxDurationMs, duration);
    }
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
    elements.btnAiNotes.addEventListener('click', () => {
      void handleAutoNotesButtonClick();
    });

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
