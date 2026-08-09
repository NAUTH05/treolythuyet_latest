const fs = require('fs');
const path = require('path');

const FIREBASE_STATE_FILE = path.join(__dirname, 'firebase-config.json');
const firebaseWriteTails = new Map();
const firebaseCollectionBarriers = new Map();

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function decodeFirestoreDocument(doc) {
  const obj = {};
  const fields = (doc && doc.fields) || {};
  for (const [k, v] of Object.entries(fields)) {
    if (v.stringValue !== undefined) {
      try { obj[k] = JSON.parse(v.stringValue); } catch { obj[k] = v.stringValue; }
    } else if (v.doubleValue !== undefined) obj[k] = v.doubleValue;
    else if (v.integerValue !== undefined) obj[k] = Number(v.integerValue);
    else if (v.booleanValue !== undefined) obj[k] = v.booleanValue;
  }
  return obj;
}

function loadFirebaseConfig() {
  if (!fs.existsSync(FIREBASE_STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(FIREBASE_STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveFirebaseConfig(config) {
  try {
    fs.writeFileSync(FIREBASE_STATE_FILE, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// Lightweight REST-based Firestore/RealtimeDB sync helper (zero heavy native binary dependency issues)
async function performFirebaseWrite(collection, id, data, config) {
  if (!config || !config.projectId) return false;
  try {
    const projectId = config.projectId;
    // Firestore REST API
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${id}?key=${config.apiKey}`;
    
    // Convert object to Firestore document fields structure
    const fields = {};
    for (const [key, val] of Object.entries(data)) {
      if (val === null || val === undefined) continue;
      if (typeof val === 'string') fields[key] = { stringValue: val };
      else if (typeof val === 'number') fields[key] = { doubleValue: val };
      else if (typeof val === 'boolean') fields[key] = { booleanValue: val };
      else fields[key] = { stringValue: JSON.stringify(val) };
    }

    const res = await fetchWithTimeout(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[FIREBASE] Lỗi HTTP ${res.status} khi sync ${collection}/${id}:`, errText);
      return false;
    }

    console.log(`[FIREBASE] ✅ Sync thành công ${collection}/${id}`);
    return true;
  } catch (err) {
    console.error(`[FIREBASE] Lỗi sync ${collection}/${id}:`, err.message);
    return false;
  }
}

function syncToFirebaseREST(collection, id, data, config) {
  if (!config || !config.projectId) return Promise.resolve(false);
  const key = `${config.projectId}/${collection}/${id}`;
  const collectionKey = `${config.projectId}/${collection}`;
  const previous = firebaseWriteTails.get(key) || Promise.resolve();
  const barrier = firebaseCollectionBarriers.get(collectionKey) || Promise.resolve();
  const task = Promise.all([previous, barrier]).then(() => performFirebaseWrite(collection, id, data, config));
  const settled = task.catch(() => false);
  firebaseWriteTails.set(key, settled);
  settled.finally(() => {
    if (firebaseWriteTails.get(key) === settled) firebaseWriteTails.delete(key);
  });
  return task;
}

async function fetchFromFirebaseREST(collection, config, documentId = null) {
  if (!config || !config.projectId) return null;
  try {
    const projectId = config.projectId;
    const suffix = documentId ? `/${encodeURIComponent(documentId)}` : '';
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}${suffix}?key=${config.apiKey}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (documentId) return [decodeFirestoreDocument(data)];
    if (!data.documents) return [];
    return data.documents.map(decodeFirestoreDocument);
  } catch (err) {
    console.error(`[FIREBASE] Lỗi fetch ${collection}:`, err.message);
    return null;
  }
}

async function deleteDocumentsByPrefixREST(collection, idPrefix, config) {
  if (!config || !config.projectId) return true;
  const collectionKey = `${config.projectId}/${collection}`;
  const previousBarrier = firebaseCollectionBarriers.get(collectionKey) || Promise.resolve();
  const writePrefix = `${collectionKey}/`;
  const pendingWrites = [...firebaseWriteTails.entries()]
    .filter(([key]) => key.startsWith(writePrefix))
    .map(([, pending]) => pending);
  const deletion = previousBarrier.then(async () => {
    await Promise.all(pendingWrites);
    const baseUrl = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents`;
    let pageToken = '';
    do {
      const query = new URLSearchParams({ key: config.apiKey, pageSize: '1000' });
      if (pageToken) query.set('pageToken', pageToken);
      const listRes = await fetchWithTimeout(`${baseUrl}/${collection}?${query.toString()}`);
      if (!listRes.ok) return false;
      const page = await listRes.json();
      const documents = page.documents || [];
      const targets = documents.filter(doc => {
        const id = String(doc.name || '').split('/').pop();
        return id.startsWith(idPrefix);
      });
      const results = await Promise.all(targets.map(async doc => {
        const deleteRes = await fetchWithTimeout(`${baseUrl}/${collection}/${encodeURIComponent(String(doc.name).split('/').pop())}?key=${config.apiKey}`, {
          method: 'DELETE',
        });
        return deleteRes.ok || deleteRes.status === 404;
      }));
      if (results.some(ok => !ok)) return false;
      pageToken = page.nextPageToken || '';
    } while (pageToken);
    return true;
  });
  const settled = deletion.catch(err => {
    console.error(`[FIREBASE] Lỗi xóa ${collection}/${idPrefix}*:`, err.message);
    return false;
  });
  firebaseCollectionBarriers.set(collectionKey, settled);
  settled.finally(() => {
    if (firebaseCollectionBarriers.get(collectionKey) === settled) firebaseCollectionBarriers.delete(collectionKey);
  });
  return settled;
}

module.exports = {
  loadFirebaseConfig,
  saveFirebaseConfig,
  syncToFirebaseREST,
  fetchFromFirebaseREST,
  deleteDocumentsByPrefixREST,
};
