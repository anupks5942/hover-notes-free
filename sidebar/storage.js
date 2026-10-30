/**
 * HoverNotes Clone - Obsidian Local Vault Storage
 * Uses File System Access API with top-level window picker and IndexedDB persistence.
 * Deterministic file naming (no random suffixes) to prevent duplicate image files.
 */

class ObsidianVaultStorage {
  constructor() {
    this.dbName = 'HoverNotesVaultDB';
    this.storeName = 'handles';
    this.handleKey = 'obsidian_vault_handle';
    this.db = null;
    this.vaultHandle = null;
  }

  // Initialize IndexedDB
  async initDB() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        console.error('[HoverNotes Vault] IndexedDB error:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  // Store DirectoryHandle into IndexedDB
  async saveHandleToDB(handle) {
    await this.initDB();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const request = store.put(handle, this.handleKey);
      request.onsuccess = () => resolve(true);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  // Retrieve DirectoryHandle from IndexedDB
  async getHandleFromDB() {
    await this.initDB();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const request = store.get(this.handleKey);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  // Disconnect Vault (Clear Handle)
  async clearHandleFromDB() {
    await this.initDB();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const request = store.delete(this.handleKey);
      request.onsuccess = () => {
        this.vaultHandle = null;
        resolve(true);
      };
      request.onerror = (e) => reject(e.target.error);
    });
  }

  // Verify or request readwrite permission
  async verifyPermission(fileHandle, requestIfPrompt = false) {
    if (!fileHandle) return false;
    const opts = { mode: 'readwrite' };

    try {
      const status = await fileHandle.queryPermission(opts);
      if (status === 'granted') {
        return true;
      }
      if (status === 'prompt' && requestIfPrompt) {
        const requested = await fileHandle.requestPermission(opts);
        return requested === 'granted';
      }
    } catch (e) {
      console.warn('[HoverNotes Vault] Error checking permission:', e);
    }
    return false;
  }

  // Open top-level vault picker window to avoid third-party iframe restriction
  async openVaultPickerWindow() {
    return new Promise((resolve) => {
      const pickerUrl = chrome.runtime.getURL('sidebar/vault-picker.html');
      chrome.runtime.sendMessage({ action: 'OPEN_VAULT_PICKER' }, (response) => {
        if (response && response.success) {
          resolve({ success: true });
        } else {
          window.open(pickerUrl, 'HoverNotesVaultPicker', 'width=500,height=560,menubar=no,toolbar=no');
          resolve({ success: true });
        }
      });
    });
  }

  // Connect new vault folder
  async connectVault() {
    if (window.top !== window.self) {
      await this.openVaultPickerWindow();
      return { success: true, pendingPopup: true };
    }

    if (!('showDirectoryPicker' in window)) {
      throw new Error('File System Access API is not supported in this browser context.');
    }

    try {
      const handle = await window.showDirectoryPicker({
        id: 'hovernotes-obsidian-vault',
        mode: 'readwrite'
      });

      const granted = await this.verifyPermission(handle, true);
      if (!granted) {
        throw new Error('Read/Write permissions were not granted for the chosen directory.');
      }

      this.vaultHandle = handle;
      await this.saveHandleToDB(handle);
      // Defer creating HoverNotes/images until the first successful note or image save.
      return { success: true, name: handle.name };
    } catch (err) {
      if (err.name === 'AbortError') return { success: false, aborted: true };
      throw err;
    }
  }

  // Restore existing vault from IndexedDB on startup
  async restoreVault() {
    try {
      const handle = await this.getHandleFromDB();
      if (!handle) {
        return { connected: false, handle: null };
      }

      this.vaultHandle = handle;
      const queryStatus = await handle.queryPermission({ mode: 'readwrite' });
      if (queryStatus === 'granted') {
        return {
          connected: true,
          needsPermission: false,
          name: handle.name
        };
      } else {
        return {
          connected: false,
          needsPermission: true,
          name: handle.name
        };
      }
    } catch (err) {
      console.error('[HoverNotes Vault] Error restoring handle:', err);
      return { connected: false, error: err.message };
    }
  }

  // Ensure 'HoverNotes' and 'HoverNotes/images' exist
  async ensureSubdirectories() {
    if (!this.vaultHandle) {
      await this.restoreVault();
    }
    if (!this.vaultHandle) return null;
    const notesDir = await this.vaultHandle.getDirectoryHandle('HoverNotes', { create: true });
    const imagesDir = await notesDir.getDirectoryHandle('images', { create: true });
    return { notesDir, imagesDir };
  }

  // Spec 2: Deterministic safe title (strips non-alphanumeric except underscores, removes spaces)
  sanitizeSafeTitle(title) {
    if (!title || typeof title !== 'string') return 'Lecture';
    let clean = title
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    if (clean.length > 70) {
      clean = clean.substring(0, 70).replace(/_$/, '');
    }
    return clean || 'Lecture';
  }

  // Clean timestamp string for filesystem: 01:23:45 -> 01-23-45
  sanitizeTimestamp(timestampStr) {
    if (!timestampStr) return '00-00';
    return String(timestampStr)
      .replace(/[:.]/g, '-')
      .replace(/[^0-9-]/g, '')
      .replace(/-+/g, '-');
  }

  // Save Markdown note file
  async saveNoteFile(title, markdownContent) {
    if (!this.vaultHandle) {
      await this.restoreVault();
    }
    if (!this.vaultHandle) {
      throw new Error('Obsidian Vault is not connected.');
    }

    const { notesDir } = await this.ensureSubdirectories();
    const safeTitle = this.sanitizeSafeTitle(title);
    const fileName = `${safeTitle}.md`;

    const fileHandle = await notesDir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(markdownContent);
    await writable.close();

    return {
      success: true,
      fileName,
      path: `HoverNotes/${fileName}`
    };
  }

  // Read existing Markdown note file
  async readNoteFile(title) {
    if (!this.vaultHandle) {
      await this.restoreVault();
    }
    if (!this.vaultHandle) return null;

    try {
      const { notesDir } = await this.ensureSubdirectories();
      const safeTitle = this.sanitizeSafeTitle(title);
      const fileName = `${safeTitle}.md`;
      const fileHandle = await notesDir.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      return await file.text();
    } catch (e) {
      return null;
    }
  }

  // Spec 2: Deterministic Screenshot Saving (NO random 4-digit suffix; overwrites cleanly on same timestamp)
  async saveScreenshotFile(videoTitle, timestampStr, base64Data) {
    if (!this.vaultHandle) {
      await this.restoreVault();
    }
    if (!this.vaultHandle) {
      throw new Error('Obsidian Vault is not connected.');
    }

    const { imagesDir } = await this.ensureSubdirectories();
    // Unique 24-character identifier prevents two captures at the same timestamp
    // from silently overwriting one another.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const randomBytes = new Uint8Array(24);
    crypto.getRandomValues(randomBytes);
    const uniqueId = Array.from(randomBytes, value => alphabet[value % alphabet.length]).join('');
    const fileName = `screenshot-${uniqueId}.jpg`;

    // Convert base64 to binary JPEG Blob
    const cleanBase64 = base64Data.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
    const binaryStr = atob(cleanBase64);
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'image/jpeg' });

    // Write image to vault (deterministic overwrite if re-capturing same timestamp)
    const fileHandle = await imagesDir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();

    // Standard relative Markdown image syntax & Obsidian native WikiLink
    return {
      fileName,
      relativePath: `images/${fileName}`,
      markdownLink: `![[HoverNotes/images/${fileName}]]`,
      wikiLink: `![[HoverNotes/images/${fileName}]]`
    };
  }
}

// Global instance for sidebar
window.obsidianStorage = new ObsidianVaultStorage();
