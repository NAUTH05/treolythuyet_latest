const fs = require('fs');
const path = require('path');

const DEFAULT_RETRY_DELAYS = [5000, 15000, 30000, 60000, 120000];

function writeJsonAtomicSync(filePath, value) {
  if (!filePath) return;
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch { /* ignore cleanup failure */ }
    throw error;
  }
}

function readStateDocument(filePath, arrayKey) {
  if (!filePath) {
    return { available: false, data: [], revision: 0, updatedAt: null, sync: null, document: null };
  }
  if (!fs.existsSync(filePath)) {
    return { available: false, data: [], revision: 0, updatedAt: null, sync: null, document: null };
  }
  try {
    const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(document)) {
      return { available: true, data: document, revision: 0, updatedAt: null, sync: null, document };
    }
    if (document && Array.isArray(document[arrayKey])) {
      return {
        available: true,
        data: document[arrayKey],
        revision: Math.max(0, Number(document.revision) || 0),
        updatedAt: document.updatedAt || null,
        sync: document._sync || null,
        document,
      };
    }
    return { available: false, data: [], revision: 0, updatedAt: null, sync: null, document };
  } catch (error) {
    return { available: false, data: [], revision: 0, updatedAt: null, sync: null, document: null, error };
  }
}

function withoutSyncMetadata(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return document;
  const { _sync, ...remoteDocument } = document;
  return remoteDocument;
}

function timestampValue(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function sameState(left, right, arrayKey) {
  return JSON.stringify(left && left[arrayKey]) === JSON.stringify(right && right[arrayKey]);
}

function isRemoteConfigured(config) {
  return Boolean(config && config.enabled && config.status === 'configured');
}

class SerializedStateSync {
  constructor({ label, filePath = null, arrayKey, collection, documentId, loadConfig, syncRemote, fetchRemote,
    initialRevision = 0, retryDelays = DEFAULT_RETRY_DELAYS, logger = console }) {
    this.label = label;
    this.filePath = filePath;
    this.arrayKey = arrayKey;
    this.collection = collection;
    this.documentId = documentId;
    this.loadConfig = loadConfig;
    this.syncRemote = syncRemote;
    this.fetchRemote = fetchRemote;
    this.revision = Math.max(0, Number(initialRevision) || 0);
    this.retryDelays = retryDelays.length ? retryDelays : DEFAULT_RETRY_DELAYS;
    this.logger = logger;
    this.pendingDocument = null;
    this.workerRunning = false;
    this.retryTimer = null;
    this.retryIndex = 0;
    this.paused = false;
    this.lastSuccessfulSyncAt = null;
    this.lastSyncError = null;
    this.nextRetryAt = null;
    this.idleWaiters = [];
    this.currentDocument = null;
  }

  ensureRevisionAtLeast(revision) {
    this.revision = Math.max(this.revision, Math.max(0, Number(revision) || 0));
  }

  persist(payload) {
    if (!this.filePath && !this._firebaseEnabled()) {
      return Promise.reject(new Error(`Firestore is unavailable; ${this.label} was not persisted`));
    }
    const document = { ...payload, revision: ++this.revision, updatedAt: new Date().toISOString() };
    try {
      this._setPendingDocument(document, true);
      this._kickWorker();
      return Promise.resolve({ revision: document.revision, firebase: this._firebaseEnabled() ? 'pending' : 'disabled' });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async reconcile() {
    const config = this.loadConfig();
    const local = readStateDocument(this.filePath, this.arrayKey);
    this.ensureRevisionAtLeast(local.revision);
    if (local.sync) {
      this.lastSuccessfulSyncAt = local.sync.lastSuccessfulSyncAt || this.lastSuccessfulSyncAt;
      this.lastSyncError = local.sync.lastSyncError || this.lastSyncError;
      this.nextRetryAt = local.sync.nextRetryAt || this.nextRetryAt;
    }
    if (!isRemoteConfigured(config)) {
      const remoteStatus = config && config.status || 'disabled';
      const error = config && config.error || null;
      if (!this.filePath) {
        this.lastSyncError = error || `Firebase Admin SDK ${remoteStatus}`;
        this.logger.warn(`[FIREBASE] ${this.label}: Admin SDK ${remoteStatus} - persistent state unavailable`);
        return { label: this.label, action: 'unavailable', remoteStatus, count: 0, error: this.lastSyncError };
      }
      this.logger.log(`[FIREBASE] ${this.label}: Admin SDK ${remoteStatus} - using local cache`);
      return { label: this.label, action: 'local-only', remoteStatus, count: local.data.length, error };
    }
    if (typeof this.fetchRemote !== 'function') throw new Error(`No Firebase reader configured for ${this.label}`);

    const remoteResult = await this.fetchRemote(this.collection, this.documentId, config);
    if (remoteResult.status !== 'ok' && remoteResult.status !== 'missing') {
      this.lastSyncError = remoteResult.error ? remoteResult.error.message : 'Firebase unavailable';
      if (!this.filePath) {
        this.logger.warn(`[FIREBASE] ${this.label}: Firebase ${remoteResult.status} - persistent state unavailable`);
        return { label: this.label, action: 'unavailable', remoteStatus: remoteResult.status, count: 0, error: this.lastSyncError };
      }
      this.logger.warn(`[FIREBASE] ${this.label}: Firebase ${remoteResult.status} - using local cache`);
      if (local.available && local.sync && local.sync.dirty) this._adoptLocalAsPending(local);
      return { label: this.label, action: local.available ? 'local-cache' : 'unavailable-no-cache', remoteStatus: remoteResult.status, count: local.data.length, error: this.lastSyncError };
    }
    if (remoteResult.status === 'missing') {
      if (!local.available) {
        this.currentDocument = { [this.arrayKey]: [], revision: 0, updatedAt: new Date().toISOString() };
        this.logger.log(`[FIREBASE] ${this.label}: remote document and local cache are both missing`);
        return { label: this.label, action: 'empty', remoteStatus: 'missing', count: 0 };
      }
      this._adoptLocalAsPending(local);
      this.logger.log(`[FIREBASE] ${this.label}: remote document missing - local cache queued for upload`);
      return { label: this.label, action: 'upload-local', remoteStatus: 'missing', count: local.data.length };
    }

    const remote = remoteResult.data;
    if (!remote || !Array.isArray(remote[this.arrayKey])) {
      this.logger.error(`[FIREBASE] ${this.label}: remote document failed validation - local cache preserved`);
      return { label: this.label, action: 'invalid-remote', remoteStatus: 'ok', count: local.data.length };
    }

    const remoteRevision = Math.max(0, Number(remote.revision) || 0);
    this.ensureRevisionAtLeast(remoteRevision);
    if (!local.available) return this._restoreRemote(remote, 'local cache missing');

    const localDocument = Array.isArray(local.document)
      ? { [this.arrayKey]: local.data, revision: 0, updatedAt: null }
      : withoutSyncMetadata(local.document);
    const localDirty = Boolean(local.sync && local.sync.dirty);
    if (remote[this.arrayKey].length > 0 && local.data.length === 0 && !(localDirty && local.revision > remoteRevision)) {
      this.logger.warn(`[FIREBASE] Remote state protected - refusing to overwrite non-empty ${this.label} with empty local state`);
      return this._restoreRemote(remote, 'empty local cache is not authoritative');
    }
    if (local.revision > remoteRevision) {
      this._adoptLocalAsPending(local);
      this.logger.log(`[FIREBASE] ${this.label}: local revision ${local.revision} is newer than remote ${remoteRevision} - queued for upload`);
      return { label: this.label, action: 'upload-local', remoteStatus: 'ok', count: local.data.length };
    }
    if (remoteRevision > local.revision) return this._restoreRemote(remote, `remote revision ${remoteRevision} is newer`);
    if (sameState(localDocument, remote, this.arrayKey)) {
      this.pendingDocument = null;
      this._clearRetryTimer();
      this.lastSuccessfulSyncAt = new Date().toISOString();
      this.lastSyncError = null;
      this._writeCleanLocal(remote);
      this.logger.log(`[FIREBASE] ${this.label}: local cache matches Firebase revision ${remoteRevision}`);
      return { label: this.label, action: 'matched', remoteStatus: 'ok', count: local.data.length };
    }
    if (localDirty && timestampValue(local.updatedAt) > timestampValue(remote.updatedAt)) {
      this._adoptLocalAsPending(local);
      this.logger.warn(`[FIREBASE] ${this.label}: equal revision conflict - newer pending local state queued for upload`);
      return { label: this.label, action: 'upload-local', remoteStatus: 'ok', count: local.data.length };
    }
    return this._restoreRemote(remote, 'Firebase wins equal-revision conflict');
  }

  getStatus() {
    return { label: this.label, revision: this.revision, dirty: Boolean(this.pendingDocument), workerRunning: this.workerRunning,
      lastSuccessfulSyncAt: this.lastSuccessfulSyncAt, lastSyncError: this.lastSyncError, nextRetryAt: this.nextRetryAt };
  }

  getData() {
    const data = this.currentDocument && this.currentDocument[this.arrayKey];
    return Array.isArray(data) ? structuredClone(data) : [];
  }

  waitForIdle(timeoutMs = 5000) {
    if (!this.pendingDocument && !this.workerRunning && !this.retryTimer) return Promise.resolve(this.getStatus());
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${this.label} sync`)), timeoutMs);
      this.idleWaiters.push(() => { clearTimeout(timeout); resolve(this.getStatus()); });
    });
  }

  async flushPending(timeoutMs = 15000) {
    this.paused = false;
    this._clearRetryTimer();
    this._kickWorker();
    return this.waitForIdle(timeoutMs);
  }

  stop() {
    this._clearRetryTimer();
  }

  pause() {
    this.paused = true;
    this._clearRetryTimer();
  }

  resume() {
    this.paused = false;
    this._kickWorker();
  }

  _firebaseEnabled() {
    return isRemoteConfigured(this.loadConfig());
  }

  _syncMetadata(dirty, extra = {}) {
    return { dirty, lastSuccessfulSyncAt: this.lastSuccessfulSyncAt, lastSyncError: this.lastSyncError, nextRetryAt: this.nextRetryAt, ...extra };
  }

  _setPendingDocument(document, writeLocal) {
    const cleanDocument = withoutSyncMetadata(document);
    this.ensureRevisionAtLeast(cleanDocument.revision);
    this.pendingDocument = cleanDocument;
    this.currentDocument = cleanDocument;
    if (!this.retryTimer) {
      this.lastSyncError = null;
      this.nextRetryAt = null;
    }
    if (writeLocal && this.filePath) writeJsonAtomicSync(this.filePath, { ...cleanDocument, _sync: this._syncMetadata(true) });
    this.logger.log(`[FIREBASE] ${this.label}: state marked dirty at revision ${cleanDocument.revision}`);
  }

  _adoptLocalAsPending(local) {
    let document = Array.isArray(local.document)
      ? { [this.arrayKey]: local.data, revision: 0, updatedAt: null }
      : withoutSyncMetadata(local.document);
    if (!document.revision) document = { ...document, revision: ++this.revision, updatedAt: new Date().toISOString() };
    this._setPendingDocument(document, true);
    this._kickWorker();
  }

  _restoreRemote(remote, reason) {
    const cleanRemote = withoutSyncMetadata(remote);
    this.ensureRevisionAtLeast(cleanRemote.revision);
    this.pendingDocument = null;
    this.currentDocument = cleanRemote;
    this._clearRetryTimer();
    this.retryIndex = 0;
    this.lastSuccessfulSyncAt = new Date().toISOString();
    this.lastSyncError = null;
    this.nextRetryAt = null;
    this._writeCleanLocal(cleanRemote);
    this.logger.log(`[FIREBASE] Restoring ${this.label} from Firebase (${reason})`);
    this.logger.log(`[FIREBASE] Restored ${cleanRemote[this.arrayKey].length} ${this.label}`);
    this._resolveIdleWaiters();
    return { label: this.label, action: 'restore-remote', remoteStatus: 'ok', count: cleanRemote[this.arrayKey].length };
  }

  _writeCleanLocal(document) {
    this.currentDocument = withoutSyncMetadata(document);
    if (this.filePath) writeJsonAtomicSync(this.filePath, { ...this.currentDocument, _sync: this._syncMetadata(false, { nextRetryAt: null, lastSyncError: null }) });
  }

  _kickWorker() {
    if (this.paused || !this.pendingDocument || this.workerRunning || this.retryTimer || !this._firebaseEnabled()) return;
    this.workerRunning = true;
    Promise.resolve().then(() => this._drainPending()).catch(error => this._handleFailure(error)).finally(() => {
      this.workerRunning = false;
      if (this.pendingDocument && !this.retryTimer && this._firebaseEnabled()) this._kickWorker();
      else this._resolveIdleWaiters();
    });
  }

  async _drainPending() {
    while (this.pendingDocument) {
      const document = this.pendingDocument;
      const result = await this._syncOne(document);
      if (result === 'retry') return;
      if (result === 'superseded') continue;
      if (this.pendingDocument && this.pendingDocument.revision === document.revision) this.pendingDocument = null;
    }
  }

  async _syncOne(document) {
    const config = this.loadConfig();
    if (!isRemoteConfigured(config)) return 'retry';
    const before = await this.fetchRemote(this.collection, this.documentId, config);
    if (!this.pendingDocument || this.pendingDocument.revision !== document.revision) return 'superseded';
    if (before.status !== 'ok' && before.status !== 'missing') {
      this._handleFailure(before.error || new Error('Firebase unavailable'));
      return 'retry';
    }
    if (before.status === 'ok') {
      const remote = before.data;
      if (!remote || !Array.isArray(remote[this.arrayKey])) {
        this._handleFailure(new Error('Remote document failed validation'));
        return 'retry';
      }
      const remoteRevision = Math.max(0, Number(remote.revision) || 0);
      const remoteIsNewer = remoteRevision > document.revision
        || (remoteRevision === document.revision && !sameState(remote, document, this.arrayKey)
          && timestampValue(remote.updatedAt) >= timestampValue(document.updatedAt));
      if (remoteIsNewer) {
        if (timestampValue(document.updatedAt) > timestampValue(remote.updatedAt)) {
          const rebased = { ...document, revision: remoteRevision + 1, updatedAt: new Date().toISOString() };
          this.revision = rebased.revision;
          this._setPendingDocument(rebased, true);
          this.logger.warn(`[FIREBASE] ${this.label}: rebased pending local state over remote revision ${remoteRevision}`);
          return 'superseded';
        }
        this.logger.warn(`[FIREBASE] ${this.label}: newer remote revision detected; pending local write was not uploaded`);
        this._restoreRemote(remote, 'newer remote state detected before upload');
        return 'remote-won';
      }
      if (remoteRevision === document.revision && sameState(remote, document, this.arrayKey)) {
        this._confirmSuccess(document);
        return 'synced';
      }
    }
    const ok = await this.syncRemote(this.collection, this.documentId, document, config);
    if (!ok) {
      this._handleFailure(new Error(`Firebase rejected ${this.label} revision ${document.revision}`));
      return 'retry';
    }
    const verified = await this.fetchRemote(this.collection, this.documentId, config);
    if (verified.status !== 'ok' || !verified.data || Number(verified.data.revision) !== Number(document.revision)
      || !sameState(verified.data, document, this.arrayKey)) {
      this._handleFailure(verified.error || new Error(`Read-after-write verification failed for revision ${document.revision}`));
      return 'retry';
    }
    this._confirmSuccess(document);
    return 'synced';
  }

  _confirmSuccess(document) {
    const reconnected = Boolean(this.lastSyncError);
    this.retryIndex = 0;
    this.lastSuccessfulSyncAt = new Date().toISOString();
    this.lastSyncError = null;
    this.nextRetryAt = null;
    const current = this.filePath ? readStateDocument(this.filePath, this.arrayKey) : { available: true, revision: this.currentDocument && this.currentDocument.revision };
    if (!this.filePath || (current.available && current.revision === document.revision)) this._writeCleanLocal(document);
    if (reconnected) this.logger.log(`[FIREBASE] Reconnected - synchronizing pending ${this.label} state`);
    this.logger.log(`[FIREBASE] ${this.label}: sync confirmed at revision ${document.revision}`);
  }

  _handleFailure(error) {
    this.lastSyncError = error && error.message ? error.message : String(error || 'Unknown Firebase error');
    if (!this.pendingDocument || this.retryTimer) return;
    const delay = this.retryDelays[Math.min(this.retryIndex, this.retryDelays.length - 1)];
    this.retryIndex += 1;
    this.nextRetryAt = new Date(Date.now() + delay).toISOString();
    const current = this.filePath ? readStateDocument(this.filePath, this.arrayKey) : { available: true, revision: this.currentDocument && this.currentDocument.revision, document: this.currentDocument };
    if (current.available && current.revision === this.pendingDocument.revision && this.filePath) {
      writeJsonAtomicSync(this.filePath, { ...withoutSyncMetadata(current.document), _sync: this._syncMetadata(true) });
    }
    this.logger.warn(`[FIREBASE] ${this.label}: state marked dirty - ${this.lastSyncError}`);
    this.logger.warn(`[FIREBASE] ${this.label}: retry scheduled in ${Math.round(delay / 1000)}s`);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.nextRetryAt = null; this._kickWorker(); }, delay);
    if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
  }

  _clearRetryTimer() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
  }

  _resolveIdleWaiters() {
    if (this.pendingDocument || this.workerRunning || this.retryTimer) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

module.exports = { DEFAULT_RETRY_DELAYS, SerializedStateSync, readStateDocument, writeJsonAtomicSync, withoutSyncMetadata, isRemoteConfigured };
