/**
 * HoverNotes Clone - Vault Picker Window Script
 * Runs in a top-level extension window context to safely execute window.showDirectoryPicker().
 */

const btnChoose = document.getElementById('btn-choose-vault');
const statusContainer = document.getElementById('status-container');

function showStatus(text, isSuccess) {
  statusContainer.textContent = text;
  statusContainer.className = 'status-msg ' + (isSuccess ? 'success' : 'error');
}

// IndexedDB Helper
function saveHandleToIndexedDB(handle) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('HoverNotesVaultDB', 1);

    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('handles')) {
        db.createObjectStore('handles');
      }
    };

    request.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction('handles', 'readwrite');
      const store = tx.objectStore('handles');
      const putReq = store.put(handle, 'obsidian_vault_handle');
      putReq.onsuccess = () => resolve(true);
      putReq.onerror = (err) => reject(err.target.error);
    };

    request.onerror = (e) => reject(e.target.error);
  });
}

btnChoose.addEventListener('click', async () => {
  if (!('showDirectoryPicker' in window)) {
    showStatus('File System Access API is not supported in this browser.', false);
    return;
  }

  btnChoose.disabled = true;

  try {
    // Top-level execution: 100% allowed by Chromium security policy
    const handle = await window.showDirectoryPicker({
      id: 'hovernotes-obsidian-vault',
      mode: 'readwrite'
    });

    // Verify readwrite permission
    const perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      throw new Error('Read and write permission was not granted for the selected folder.');
    }

    // Verify/create required subdirectories
    const notesDir = await handle.getDirectoryHandle('HoverNotes', { create: true });
    await notesDir.getDirectoryHandle('images', { create: true });

    // Store DirectoryHandle into shared IndexedDB
    await saveHandleToIndexedDB(handle);

    showStatus(`✓ Connected to Obsidian Vault: "${handle.name}". Closing window...`, true);

    // Notify all active extension pages (including sidebar iframe)
    try {
      chrome.runtime.sendMessage({
        action: 'VAULT_CONNECTED',
        name: handle.name
      });
    } catch (msgErr) {
      console.warn('Notification message sent:', msgErr);
    }

    // Close window after brief success confirmation
    setTimeout(() => {
      window.close();
    }, 700);

  } catch (err) {
    btnChoose.disabled = false;
    if (err.name === 'AbortError') {
      showStatus('Folder selection cancelled. Click above to try again.', false);
    } else {
      showStatus('Error connecting vault: ' + err.message, false);
    }
  }
});
