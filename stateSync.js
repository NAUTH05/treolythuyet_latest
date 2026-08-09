const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function writeJsonAtomicSync(filePath, value) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  const json = JSON.stringify(value, null, 2);
  fs.writeFileSync(tempPath, json, 'utf8');
  try {
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

function readStateDocument(filePath, arrayKey) {
  if (!fs.existsSync(filePath)) {
    return { available: false, data: [], revision: 0, document: null };
  }

  try {
    const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(document)) {
      return { available: true, data: document, revision: 0, document };
    }
    if (document && Array.isArray(document[arrayKey])) {
      return {
        available: true,
        data: document[arrayKey],
        revision: Math.max(0, Number(document.revision) || 0),
        document,
      };
    }
    return { available: false, data: [], revision: 0, document };
  } catch (error) {
    return { available: false, data: [], revision: 0, document: null, error };
  }
}

class SerializedStateSync {
  constructor({ label, filePath, collection, documentId, loadConfig, syncRemote, initialRevision = 0 }) {
    this.label = label;
    this.filePath = filePath;
    this.collection = collection;
    this.documentId = documentId;
    this.loadConfig = loadConfig;
    this.syncRemote = syncRemote;
    this.revision = Math.max(0, Number(initialRevision) || 0);
    this.tail = Promise.resolve();
  }

  ensureRevisionAtLeast(revision) {
    this.revision = Math.max(this.revision, Math.max(0, Number(revision) || 0));
  }

  persist(payload) {
    const document = {
      ...payload,
      revision: ++this.revision,
      updatedAt: new Date().toISOString(),
    };

    // Local is committed atomically before the remote write is queued.
    try {
      writeJsonAtomicSync(this.filePath, document);
    } catch (error) {
      return Promise.reject(error);
    }

    const task = this.tail.then(async () => {
      const config = this.loadConfig();
      if (!config || !config.projectId) {
        return { revision: document.revision, firebase: 'disabled' };
      }

      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const ok = await this.syncRemote(this.collection, this.documentId, document, config);
          if (ok) return { revision: document.revision, firebase: 'synced' };
          lastError = new Error(`Firebase rejected ${this.label} revision ${document.revision}`);
        } catch (error) {
          lastError = error;
        }
        if (attempt < 3) await sleep(attempt * 250);
      }
      throw lastError || new Error(`Unable to sync ${this.label} to Firebase`);
    });

    // Every write runs after the previous write even when that previous write failed.
    this.tail = task.catch(() => undefined);
    return task;
  }
}

module.exports = {
  SerializedStateSync,
  readStateDocument,
  writeJsonAtomicSync,
};
