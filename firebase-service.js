const fs = require('fs');
const path = require('path');
require('dotenv').config();
const {
  initializeApp,
  cert,
  applicationDefault,
  deleteApp,
} = require('firebase-admin/app');
const { getFirestore, FieldPath } = require('firebase-admin/firestore');

const DEFAULT_SERVICE_ACCOUNT_FILE = path.join(__dirname, 'firebase-service-account.json');
const LEGACY_CONFIG_FILE = path.join(__dirname, 'firebase-config.json');
const FIRESTORE_DOC_BUDGET_BYTES = 950 * 1024;
const NESTED_ARRAY_KEY = '__wrappedArray';

function encodeFirestoreValue(val, insideArray = false) {
  if (val === null || val === undefined) return { nullValue: null };
  if (val instanceof Date) return { timestampValue: val.toISOString() };
  switch (typeof val) {
    case 'string': return { stringValue: val };
    case 'boolean': return { booleanValue: val };
    case 'bigint': return { integerValue: val.toString() };
    case 'number':
      if (Number.isNaN(val)) return { doubleValue: 'NaN' };
      if (!Number.isFinite(val)) return { doubleValue: val > 0 ? 'Infinity' : '-Infinity' };
      return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
    default: break;
  }
  if (Array.isArray(val)) {
    const arrayValue = { values: val.map(item => encodeFirestoreValue(item, true)) };
    return insideArray
      ? { mapValue: { fields: { [NESTED_ARRAY_KEY]: { arrayValue } } } }
      : { arrayValue };
  }
  if (typeof val === 'object') return { mapValue: { fields: encodeFirestoreFields(val) } };
  return { stringValue: String(val) };
}

function encodeFirestoreFields(obj) {
  const fields = {};
  for (const [key, val] of Object.entries(obj || {})) {
    if (typeof val === 'function' || typeof val === 'symbol') continue;
    fields[key] = encodeFirestoreValue(val);
  }
  return fields;
}

function decodeLegacyString(str) {
  const trimmed = str.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return str;
  try { return JSON.parse(trimmed); } catch { return str; }
}

function decodeFirestoreValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('nullValue' in value) return null;
  if (value.stringValue !== undefined) return decodeLegacyString(value.stringValue);
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return Number(value.doubleValue);
  if (value.timestampValue !== undefined) return value.timestampValue;
  if (value.bytesValue !== undefined) return value.bytesValue;
  if (value.referenceValue !== undefined) return value.referenceValue;
  if (value.geoPointValue !== undefined) return { ...value.geoPointValue };
  if (value.arrayValue !== undefined) return (value.arrayValue.values || []).map(decodeFirestoreValue);
  if (value.mapValue !== undefined) {
    const fields = value.mapValue.fields || {};
    const keys = Object.keys(fields);
    if (keys.length === 1 && keys[0] === NESTED_ARRAY_KEY) return decodeFirestoreValue(fields[NESTED_ARRAY_KEY]);
    return decodeFirestoreFields(fields);
  }
  return null;
}

function decodeFirestoreFields(fields) {
  const obj = {};
  for (const [key, value] of Object.entries(fields || {})) obj[key] = decodeFirestoreValue(value);
  return obj;
}

function decodeFirestoreDocument(doc) {
  return decodeFirestoreFields(doc && doc.fields);
}

function prepareAdminValue(value, insideArray = false) {
  if (Array.isArray(value)) {
    const prepared = value.map(item => prepareAdminValue(item, true));
    return insideArray ? { [NESTED_ARRAY_KEY]: prepared } : prepared;
  }
  if (value && typeof value === 'object') {
    if (value instanceof Date || Buffer.isBuffer(value)) return value;
    const prepared = {};
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'function' || typeof child === 'symbol' || child === undefined) continue;
      prepared[key] = prepareAdminValue(child, false);
    }
    return prepared;
  }
  return value === undefined ? null : value;
}

function restoreAdminValue(value) {
  if (Array.isArray(value)) return value.map(restoreAdminValue);
  if (value && typeof value === 'object') {
    if (typeof value.toDate === 'function') return value.toDate().toISOString();
    if (Buffer.isBuffer(value)) return value;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === NESTED_ARRAY_KEY && Array.isArray(value[NESTED_ARRAY_KEY])) {
      return value[NESTED_ARRAY_KEY].map(restoreAdminValue);
    }
    const restored = {};
    for (const [key, child] of Object.entries(value)) restored[key] = restoreAdminValue(child);
    return restored;
  }
  return value;
}

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function fitDocumentWithinBudget(data, label) {
  if (jsonByteLength(encodeFirestoreFields(data)) <= FIRESTORE_DOC_BUDGET_BYTES) {
    return prepareAdminValue(data);
  }
  const trimmed = { ...data };
  let omitted = 0;
  while (jsonByteLength(encodeFirestoreFields(trimmed)) > FIRESTORE_DOC_BUDGET_BYTES) {
    let target = null;
    let targetSize = 0;
    for (const [key, value] of Object.entries(trimmed)) {
      if (!Array.isArray(value) || value.length === 0) continue;
      const size = jsonByteLength(encodeFirestoreValue(value));
      if (size > targetSize) { target = key; targetSize = size; }
    }
    if (!target) break;
    const dropCount = Math.max(1, Math.floor(trimmed[target].length * 0.05));
    trimmed[target] = trimmed[target].slice(dropCount);
    omitted += dropCount;
  }
  if (omitted > 0) {
    trimmed.truncated = true;
    trimmed.omittedOldestCount = omitted;
    console.warn(`[FIREBASE] ${label} exceeded the document budget; omitted ${omitted} oldest records from Firestore only.`);
  }
  return prepareAdminValue(trimmed);
}

function normalizePrivateKey(value) {
  return typeof value === 'string' ? value.replace(/\\n/g, '\n') : value;
}

function validateServiceAccount(serviceAccount) {
  if (!serviceAccount || typeof serviceAccount !== 'object') throw new Error('Service-account JSON must be an object');
  const projectId = serviceAccount.project_id || serviceAccount.projectId;
  const clientEmail = serviceAccount.client_email || serviceAccount.clientEmail;
  const privateKey = normalizePrivateKey(serviceAccount.private_key || serviceAccount.privateKey);
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Service-account credentials require project_id, client_email, and private_key');
  }
  return { projectId, clientEmail, privateKey };
}

function readJsonCredential(raw, source) {
  try {
    return { credential: validateServiceAccount(JSON.parse(raw)), source };
  } catch (error) {
    error.message = `${source}: ${error.message}`;
    throw error;
  }
}

function loadFirebaseAdminConfiguration({ env = process.env, baseDir = __dirname } = {}) {
  try {
    if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const parsed = readJsonCredential(env.FIREBASE_SERVICE_ACCOUNT_JSON, 'FIREBASE_SERVICE_ACCOUNT_JSON');
      return { enabled: true, status: 'configured', credentialType: 'service-account', ...parsed, projectId: parsed.credential.projectId };
    }
    if (env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
      const raw = Buffer.from(env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
      const parsed = readJsonCredential(raw, 'FIREBASE_SERVICE_ACCOUNT_BASE64');
      return { enabled: true, status: 'configured', credentialType: 'service-account', ...parsed, projectId: parsed.credential.projectId };
    }

    const directCredentialRequested = Boolean(env.FIREBASE_CLIENT_EMAIL || env.FIREBASE_PRIVATE_KEY);
    if (directCredentialRequested) {
      const credential = validateServiceAccount({
        project_id: env.FIREBASE_PROJECT_ID,
        client_email: env.FIREBASE_CLIENT_EMAIL,
        private_key: env.FIREBASE_PRIVATE_KEY,
      });
      return { enabled: true, status: 'configured', credentialType: 'service-account', credential, projectId: credential.projectId, source: 'FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY' };
    }

    const explicitFile = env.FIREBASE_SERVICE_ACCOUNT_FILE;
    const googleFile = env.GOOGLE_APPLICATION_CREDENTIALS;
    const credentialFile = explicitFile || googleFile;
    if (credentialFile) {
      const resolved = path.resolve(credentialFile);
      const parsed = readJsonCredential(fs.readFileSync(resolved, 'utf8'), explicitFile
        ? 'FIREBASE_SERVICE_ACCOUNT_FILE'
        : googleFile ? 'GOOGLE_APPLICATION_CREDENTIALS' : 'firebase-service-account.json');
      return { enabled: true, status: 'configured', credentialType: 'service-account', ...parsed, projectId: parsed.credential.projectId, credentialFile: resolved };
    }

    if (/^(1|true|yes)$/i.test(env.FIREBASE_USE_APPLICATION_DEFAULT || '')) {
      const projectId = env.FIREBASE_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || null;
      return { enabled: true, status: 'configured', credentialType: 'application-default', projectId, source: 'Application Default Credentials' };
    }

    return {
      enabled: false,
      status: 'disabled',
      projectId: null,
      source: null,
      legacyConfigDetected: fs.existsSync(path.join(baseDir, 'firebase-config.json')),
    };
  } catch (error) {
    return { enabled: false, status: 'invalid-credentials', projectId: null, source: null, error: error.message };
  }
}

function classifyFirestoreError(error) {
  const code = String(error && error.code || '').toLowerCase();
  const message = String(error && error.message || error || 'Unknown Firestore error');
  if (code.includes('invalid-credential') || code.includes('invalid-argument') || /private key|credential/i.test(message)) {
    return { status: 'invalid-credentials', error: new Error(message), code };
  }
  if (code.includes('unauthenticated') || code.includes('auth/')) {
    return { status: 'authentication-failed', error: new Error(message), code };
  }
  if (code.includes('permission-denied') || code === '7' || /permission denied/i.test(message)) {
    return { status: 'permission-denied', error: new Error(message), code };
  }
  if (code.includes('not-found') || code === '5' || /project .*not found|database .*not found/i.test(message)) {
    return { status: 'project-unavailable', error: new Error(message), code };
  }
  if (code.includes('unavailable') || code.includes('deadline-exceeded') || code.includes('resource-exhausted')
    || /econn|network|timeout|unavailable/i.test(message)) {
    return { status: 'unavailable', error: new Error(message), code };
  }
  return { status: 'unavailable', error: new Error(message), code };
}

class FirebaseAdminStore {
  constructor({
    loadConfiguration = loadFirebaseAdminConfiguration,
    sdk = { initializeApp, cert, applicationDefault, deleteApp, getFirestore, FieldPath },
    logger = console,
    appName = `treohoc-admin-${process.pid}`,
  } = {}) {
    this.loadConfiguration = loadConfiguration;
    this.sdk = sdk;
    this.logger = logger;
    this.appName = appName;
    this.app = null;
    this.db = null;
    this.initialization = null;
    this.writeTails = new Map();
    this.collectionBarriers = new Map();
    this.status = { initialized: false, connected: false, lastError: null, lastVerifiedAt: null };
  }

  getConfiguration() {
    return this.loadConfiguration();
  }

  getStatus() {
    const config = this.getConfiguration();
    return {
      enabled: config.enabled,
      configurationStatus: config.status,
      authentication: 'admin-sdk',
      projectId: config.projectId || null,
      credentialSource: config.source || null,
      legacyConfigDetected: Boolean(config.legacyConfigDetected),
      initialized: this.status.initialized,
      connected: this.status.connected,
      lastVerifiedAt: this.status.lastVerifiedAt,
      lastError: config.error || this.status.lastError,
    };
  }

  async initialize() {
    if (this.db) return { status: 'ok', db: this.db };
    if (this.initialization) return this.initialization;
    this.initialization = this._initialize().finally(() => { this.initialization = null; });
    return this.initialization;
  }

  async _initialize() {
    const config = this.getConfiguration();
    if (!config.enabled) return { status: config.status, error: config.error ? new Error(config.error) : null };
    try {
      const credential = config.credentialType === 'application-default'
        ? this.sdk.applicationDefault()
        : this.sdk.cert(config.credential);
      this.app = this.sdk.initializeApp({ credential, projectId: config.projectId || undefined }, this.appName);
      this.db = this.sdk.getFirestore(this.app);
      if (typeof this.db.settings === 'function') this.db.settings({ ignoreUndefinedProperties: true });
      this.status.initialized = true;
      this.status.lastError = null;
      this.logger.log('[FIREBASE] Admin SDK initialized');
      this.logger.log('[FIREBASE] Using server-side Admin SDK authentication');
      return { status: 'ok', db: this.db };
    } catch (error) {
      const classified = classifyFirestoreError(error);
      this.status.lastError = classified.error.message;
      this.logger.error(`[FIREBASE] Admin SDK initialization failed (${classified.status}): ${classified.error.message}`);
      return classified;
    }
  }

  async verifyConnection() {
    const result = await this.fetchDocument('system_settings', 'config_info');
    const connected = result.status === 'ok' || result.status === 'missing';
    this.status.connected = connected;
    this.status.lastVerifiedAt = new Date().toISOString();
    this.status.lastError = connected ? null : result.error && result.error.message;
    if (connected) this.logger.log('[FIREBASE] Firestore connection verified');
    return { ...result, connected };
  }

  async fetchDocument(collection, documentId) {
    const initialized = await this.initialize();
    if (initialized.status !== 'ok') return { status: initialized.status, data: null, error: initialized.error || null };
    try {
      const snapshot = await this.db.collection(collection).doc(documentId).get();
      if (!snapshot.exists) return { status: 'missing', data: null, error: null };
      return { status: 'ok', data: restoreAdminValue(snapshot.data()), error: null };
    } catch (error) {
      const classified = classifyFirestoreError(error);
      this.status.connected = false;
      this.status.lastError = classified.error.message;
      this.logger.error(`[FIREBASE] Read failed ${collection}/${documentId} (${classified.status}): ${classified.error.message}`);
      return { ...classified, data: null };
    }
  }

  writeDocument(collection, documentId, data) {
    const config = this.getConfiguration();
    const projectKey = config.projectId || this.appName;
    const key = `${projectKey}/${collection}/${documentId}`;
    const collectionKey = `${projectKey}/${collection}`;
    const previous = this.writeTails.get(key) || Promise.resolve();
    const barrier = this.collectionBarriers.get(collectionKey) || Promise.resolve();
    const task = Promise.all([previous, barrier]).then(async () => {
      const initialized = await this.initialize();
      if (initialized.status !== 'ok') return false;
      return this._performWrite(collection, documentId, data);
    });
    const settled = task.catch(() => false);
    this.writeTails.set(key, settled);
    settled.finally(() => { if (this.writeTails.get(key) === settled) this.writeTails.delete(key); });
    return task;
  }

  async _performWrite(collection, documentId, data) {
    try {
      const ref = this.db.collection(collection).doc(documentId);
      const prepared = fitDocumentWithinBudget(data, `${collection}/${documentId}`);
      if (Number.isFinite(Number(data && data.revision))) {
        const accepted = await this.db.runTransaction(async transaction => {
          const snapshot = await transaction.get(ref);
          if (snapshot.exists) {
            const remote = restoreAdminValue(snapshot.data());
            const remoteRevision = Math.max(0, Number(remote.revision) || 0);
            const localRevision = Math.max(0, Number(data.revision) || 0);
            const remoteUpdatedAt = Date.parse(remote.updatedAt || '') || 0;
            const localUpdatedAt = Date.parse(data.updatedAt || '') || 0;
            if (remoteRevision > localRevision || (remoteRevision === localRevision && remoteUpdatedAt > localUpdatedAt)) {
              return false;
            }
          }
          transaction.set(ref, prepared);
          return true;
        });
        if (!accepted) {
          this.logger.warn(`[FIREBASE] Refused stale revision for ${collection}/${documentId}`);
          return false;
        }
      } else {
        await ref.set(prepared);
      }
      this.status.connected = true;
      this.status.lastError = null;
      this.logger.log(`[FIREBASE] Sync successful ${collection}/${documentId}`);
      return true;
    } catch (error) {
      const classified = classifyFirestoreError(error);
      this.status.connected = false;
      this.status.lastError = classified.error.message;
      this.logger.error(`[FIREBASE] Write failed ${collection}/${documentId} (${classified.status}): ${classified.error.message}`);
      return false;
    }
  }

  deleteByPrefix(collection, idPrefix) {
    const config = this.getConfiguration();
    const collectionKey = `${config.projectId || this.appName}/${collection}`;
    const previousBarrier = this.collectionBarriers.get(collectionKey) || Promise.resolve();
    const writePrefix = `${collectionKey}/`;
    const pendingWrites = [...this.writeTails.entries()]
      .filter(([key]) => key.startsWith(writePrefix))
      .map(([, pending]) => pending);
    const deletion = previousBarrier.then(async () => {
      await Promise.all(pendingWrites);
      const initialized = await this.initialize();
      if (initialized.status !== 'ok') return false;
      try {
        while (true) {
          const snapshot = await this.db.collection(collection)
            .where(this.sdk.FieldPath.documentId(), '>=', idPrefix)
            .where(this.sdk.FieldPath.documentId(), '<=', `${idPrefix}\uf8ff`)
            .limit(400)
            .get();
          if (snapshot.empty) break;
          const batch = this.db.batch();
          snapshot.docs.forEach(doc => batch.delete(doc.ref));
          await batch.commit();
          if (snapshot.size < 400) break;
        }
        return true;
      } catch (error) {
        const classified = classifyFirestoreError(error);
        this.logger.error(`[FIREBASE] Delete failed ${collection}/${idPrefix}* (${classified.status}): ${classified.error.message}`);
        return false;
      }
    });
    const settled = deletion.catch(() => false);
    this.collectionBarriers.set(collectionKey, settled);
    settled.finally(() => { if (this.collectionBarriers.get(collectionKey) === settled) this.collectionBarriers.delete(collectionKey); });
    return settled;
  }

  async reset() {
    await this.shutdown();
    this.status = { initialized: false, connected: false, lastError: null, lastVerifiedAt: null };
  }

  async shutdown() {
    await Promise.allSettled([...this.writeTails.values(), ...this.collectionBarriers.values()]);
    if (this.app) {
      try { await this.sdk.deleteApp(this.app); } catch { /* ignore shutdown cleanup */ }
    }
    this.app = null;
    this.db = null;
    this.status.initialized = false;
  }
}

const defaultStore = new FirebaseAdminStore();

module.exports = {
  DEFAULT_SERVICE_ACCOUNT_FILE,
  LEGACY_CONFIG_FILE,
  FirebaseAdminStore,
  loadFirebaseAdminConfiguration,
  classifyFirestoreError,
  getFirebaseAdminConfiguration: () => defaultStore.getConfiguration(),
  getFirebaseAdminStatus: () => defaultStore.getStatus(),
  initializeFirebaseAdmin: () => defaultStore.initialize(),
  verifyFirebaseConnection: () => defaultStore.verifyConnection(),
  syncToFirebase: (collection, id, data) => defaultStore.writeDocument(collection, id, data),
  fetchFirebaseDocument: (collection, documentId) => defaultStore.fetchDocument(collection, documentId),
  deleteDocumentsByPrefix: (collection, idPrefix) => defaultStore.deleteByPrefix(collection, idPrefix),
  resetFirebaseAdmin: () => defaultStore.reset(),
  shutdownFirebaseAdmin: () => defaultStore.shutdown(),
  encodeFirestoreFields,
  decodeFirestoreDocument,
  decodeFirestoreValue,
  prepareAdminValue,
  restoreAdminValue,
  fitDocumentWithinBudget,
};
