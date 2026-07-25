const fs = require('fs');
const path = require('path');

const FIREBASE_STATE_FILE = path.join(__dirname, 'firebase-config.json');

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
async function syncToFirebaseREST(collection, id, data, config) {
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

    const res = await fetch(url, {
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

async function fetchFromFirebaseREST(collection, config) {
  if (!config || !config.projectId) return null;
  try {
    const projectId = config.projectId;
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}?key=${config.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.documents) return [];

    return data.documents.map(doc => {
      const obj = {};
      const fields = doc.fields || {};
      for (const [k, v] of Object.entries(fields)) {
        if (v.stringValue !== undefined) {
          try { obj[k] = JSON.parse(v.stringValue); } catch { obj[k] = v.stringValue; }
        } else if (v.doubleValue !== undefined) obj[k] = v.doubleValue;
        else if (v.integerValue !== undefined) obj[k] = Number(v.integerValue);
        else if (v.booleanValue !== undefined) obj[k] = v.booleanValue;
      }
      return obj;
    });
  } catch (err) {
    console.error(`[FIREBASE] Lỗi fetch ${collection}:`, err.message);
    return null;
  }
}

module.exports = {
  loadFirebaseConfig,
  saveFirebaseConfig,
  syncToFirebaseREST,
  fetchFromFirebaseREST,
};
