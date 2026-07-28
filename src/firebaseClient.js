import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, doc, setDoc, getDoc } from 'firebase/firestore';

let db = null;

export function initFirebaseClient(config) {
  if (!config || !config.apiKey || !config.projectId) return null;
  try {
    const app = getApps().length === 0 ? initializeApp(config) : getApp();
    db = getFirestore(app);
    return db;
  } catch (err) {
    console.error('[FIREBASE CLIENT] Lỗi khởi tạo:', err);
    return null;
  }
}

export async function syncDocClient(collectionName, docId, data) {
  if (!db) return false;
  try {
    await setDoc(doc(db, collectionName, docId), {
      ...data,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    console.log(`[FIREBASE CLIENT] ✅ Sync thành công ${collectionName}/${docId}`);
    return true;
  } catch (err) {
    console.error(`[FIREBASE CLIENT] ❌ Lỗi sync ${collectionName}/${docId}:`, err);
    return false;
  }
}
