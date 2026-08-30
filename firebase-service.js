const fs = require('fs');
const path = require('path');

const FIREBASE_STATE_FILE = path.join(__dirname, 'firebase-config.json');
const firebaseWriteTails = new Map();
const firebaseCollectionBarriers = new Map();

// Firestore từ chối document lớn hơn 1 MiB. Giữ ngân sách thấp hơn hạn cứng để
// còn chỗ cho tên document và overhead nội bộ Firestore tính thêm.
const FIRESTORE_DOC_BUDGET_BYTES = 950 * 1024;
// Firestore không cho mảng chứa trực tiếp mảng khác → bọc một lớp map với khóa
// này để dữ liệu vẫn ghi được và đọc ra vẫn đúng hình dạng ban đầu.
const NESTED_ARRAY_KEY = '__wrappedArray';

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// =============== FIRESTORE VALUE CODEC ===============
// Giữ nguyên hình dạng dữ liệu: object lồng → mapValue, mảng → arrayValue,
// null → nullValue. Không stringify nữa, để Firestore Console xem/query được
// và để vòng ghi–đọc không làm biến dạng kiểu dữ liệu.

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

// Tương thích ngược: document do bản cũ ghi đang lưu object/array dưới dạng chuỗi
// JSON. Chỉ thử parse khi chuỗi có hình dạng object/array, để "123" hay "true"
// không bị biến thành số/boolean như bug của bản cũ.
function decodeLegacyString(str) {
  const trimmed = str.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return str;
  try {
    return JSON.parse(trimmed);
  } catch {
    return str;
  }
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
  if (value.arrayValue !== undefined) return (value.arrayValue.values || []).map(v => decodeFirestoreValue(v));
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

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

// Lưu nested thật tốn nhiều byte hơn chuỗi JSON, nên document log dễ chạm hạn
// 1 MiB hơn trước. Khi vượt ngân sách, cắt dần phần tử cũ nhất của mảng đang
// chiếm nhiều byte nhất rồi ghi rõ đã bỏ bao nhiêu bản ghi — thay vì để Firestore
// từ chối và mất trắng cả lần ghi. File local vẫn là nguồn đầy đủ.
function fitFieldsWithinBudget(fields, label) {
  if (jsonByteLength(fields) <= FIRESTORE_DOC_BUDGET_BYTES) return fields;

  const trimmed = { ...fields };
  let omitted = 0;

  while (jsonByteLength(trimmed) > FIRESTORE_DOC_BUDGET_BYTES) {
    let target = null;
    let targetSize = 0;
    for (const [key, value] of Object.entries(trimmed)) {
      const values = value && value.arrayValue && value.arrayValue.values;
      if (!values || values.length === 0) continue;
      const size = jsonByteLength(value);
      if (size > targetSize) { target = key; targetSize = size; }
    }
    if (!target) break;

    const values = trimmed[target].arrayValue.values;
    const dropCount = Math.max(1, Math.floor(values.length * 0.05));
    trimmed[target] = { arrayValue: { values: values.slice(dropCount) } };
    omitted += dropCount;
  }

  if (omitted > 0) {
    trimmed.truncated = { booleanValue: true };
    trimmed.omittedOldestCount = { integerValue: String(omitted) };
    console.warn(`[FIREBASE] ⚠️ ${label} vượt ngân sách document — đã bỏ ${omitted} bản ghi cũ nhất (file local vẫn giữ đủ).`);
  }
  return trimmed;
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
  const tempPath = `${FIREBASE_STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tempPath, FIREBASE_STATE_FILE);
    return true;
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch { /* ignore cleanup failure */ }
    console.error('[FIREBASE] Unable to save Firebase configuration:', error.message);
    return false;
  }
}

// Firestore REST sync helper (không kéo theo native binary như Admin SDK)
async function performFirebaseWrite(collection, id, data, config) {
  if (!config || !config.projectId) return false;
  try {
    const projectId = config.projectId;
    const docPath = `${collection}/${encodeURIComponent(id)}`;
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${docPath}?key=${config.apiKey}`;

    const fields = fitFieldsWithinBudget(encodeFirestoreFields(data), `${collection}/${id}`);

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

async function fetchFirebaseDocumentREST(collection, documentId, config) {
  if (!config || !config.projectId || !config.apiKey) {
    return { status: 'disabled', data: null, error: null };
  }
  try {
    const projectId = config.projectId;
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}/${encodeURIComponent(documentId)}?key=${config.apiKey}`;
    const res = await fetchWithTimeout(url);
    if (res.status === 404) return { status: 'missing', data: null, httpStatus: 404, error: null };
    if (!res.ok) {
      const message = await res.text();
      return {
        status: 'unavailable',
        data: null,
        httpStatus: res.status,
        error: new Error(`Firebase HTTP ${res.status}: ${message}`),
      };
    }
    return { status: 'ok', data: decodeFirestoreDocument(await res.json()), httpStatus: res.status, error: null };
  } catch (error) {
    console.error(`[FIREBASE] Fetch failed ${collection}/${documentId}:`, error.message);
    return { status: 'unavailable', data: null, error };
  }
}

async function fetchFromFirebaseREST(collection, config, documentId = null) {
  if (documentId) {
    const result = await fetchFirebaseDocumentREST(collection, documentId, config);
    return result.status === 'ok' ? [result.data] : null;
  }
  if (!config || !config.projectId || !config.apiKey) return null;
  try {
    const projectId = config.projectId;
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}?key=${config.apiKey}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = await res.json();
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
  fetchFirebaseDocumentREST,
  fetchFromFirebaseREST,
  deleteDocumentsByPrefixREST,
  encodeFirestoreFields,
  decodeFirestoreDocument,
  decodeFirestoreValue,
};
