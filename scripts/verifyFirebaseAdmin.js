const crypto = require('crypto');
const firebase = require('../firebase-service');

const PERSISTENT_DOCUMENTS = [
  ['system_accounts', 'list'],
  ['system_presets', 'list'],
  ['system_autoscan_presets', 'list'],
  ['system_queues', 'state'],
  ['system_autoscan', 'state'],
];

async function main() {
  const configuration = firebase.getFirebaseAdminConfiguration();
  if (!configuration.enabled) {
    throw new Error(configuration.error || `Firebase Admin SDK is ${configuration.status}`);
  }

  const connection = await firebase.verifyFirebaseConnection();
  if (!connection.connected) {
    throw new Error(connection.error ? connection.error.message : `Firestore verification failed: ${connection.status}`);
  }

  for (const [collection, documentId] of PERSISTENT_DOCUMENTS) {
    const result = await firebase.fetchFirebaseDocument(collection, documentId);
    if (!['ok', 'missing'].includes(result.status)) {
      throw new Error(`${collection}/${documentId}: ${result.status}${result.error ? ` - ${result.error.message}` : ''}`);
    }
    console.log(`[VERIFY] ${collection}/${documentId}: ${result.status}`);
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const verificationDocument = {
    authentication: 'admin-sdk',
    nonce,
    updatedAt: new Date().toISOString(),
  };
  const written = await firebase.syncToFirebase('system_settings', 'admin_sdk_verification', verificationDocument);
  if (!written) throw new Error('Admin SDK verification write failed');

  const readBack = await firebase.fetchFirebaseDocument('system_settings', 'admin_sdk_verification');
  if (readBack.status !== 'ok' || readBack.data.nonce !== nonce) {
    throw new Error('Admin SDK read-after-write verification failed');
  }

  console.log('[VERIFY] Firebase Admin SDK read/write verification passed');
  console.log('[VERIFY] Server-side Firestore access is ready for deny-all client rules');
}

main().catch(error => {
  console.error('[VERIFY] Firebase Admin SDK verification failed:', error.message);
  process.exitCode = 1;
}).finally(() => firebase.shutdownFirebaseAdmin());
