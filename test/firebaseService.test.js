const test = require('node:test');
const assert = require('node:assert/strict');
const { FirebaseAdminStore, loadFirebaseAdminConfiguration, classifyFirestoreError } = require('../firebase-service');

function configuredCredential() {
  return {
    enabled: true,
    status: 'configured',
    credentialType: 'service-account',
    projectId: 'test-project',
    source: 'test',
    credential: {
      projectId: 'test-project',
      clientEmail: 'firebase-adminsdk@test-project.iam.gserviceaccount.com',
      privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n',
    },
  };
}

function createFakeSdk({ unavailableReads = false, transactionDelay = 0 } = {}) {
  const documents = new Map();
  const operations = [];
  let transactionConcurrency = 0;
  let maxTransactionConcurrency = 0;

  function snapshotFor(ref) {
    const data = documents.get(ref.key);
    return { exists: data !== undefined, data: () => structuredClone(data) };
  }

  function makeDoc(collection, id) {
    return {
      key: `${collection}/${id}`,
      id,
      async get() {
        if (unavailableReads) {
          const error = new Error('Firestore unavailable');
          error.code = 'unavailable';
          throw error;
        }
        return snapshotFor(this);
      },
      async set(data) {
        documents.set(this.key, structuredClone(data));
        operations.push(`SET:${this.key}`);
      },
    };
  }

  const db = {
    settings() {},
    collection(name) {
      return {
        doc(id) { return makeDoc(name, id); },
        where() { return this; },
        limit() { return this; },
        async get() {
          const docs = [...documents.keys()]
            .filter(key => key.startsWith(`${name}/`))
            .map(key => {
              const id = key.slice(name.length + 1);
              return { id, ref: makeDoc(name, id), data: () => structuredClone(documents.get(key)) };
            });
          return { empty: docs.length === 0, size: docs.length, docs };
        },
      };
    },
    async runTransaction(callback) {
      transactionConcurrency++;
      maxTransactionConcurrency = Math.max(maxTransactionConcurrency, transactionConcurrency);
      const writes = [];
      const transaction = {
        get: async ref => snapshotFor(ref),
        set: (ref, data) => writes.push([ref, structuredClone(data)]),
      };
      const result = await callback(transaction);
      if (transactionDelay) await new Promise(resolve => setTimeout(resolve, transactionDelay));
      for (const [ref, data] of writes) {
        documents.set(ref.key, data);
        operations.push(`TX:${ref.key}:${data.revision || 0}`);
      }
      transactionConcurrency--;
      return result;
    },
    batch() {
      const deletes = [];
      return {
        delete: ref => deletes.push(ref),
        async commit() {
          for (const ref of deletes) {
            documents.delete(ref.key);
            operations.push(`DELETE:${ref.key}`);
          }
        },
      };
    },
  };

  return {
    initializeApp: options => ({ options }),
    cert: credential => ({ credential }),
    applicationDefault: () => ({ applicationDefault: true }),
    deleteApp: async () => {},
    getFirestore: () => db,
    FieldPath: { documentId: () => '__name__' },
    documents,
    operations,
    get maxTransactionConcurrency() { return maxTransactionConcurrency; },
  };
}

function makeStore(t, options = {}) {
  const sdk = options.sdk || createFakeSdk(options);
  const messages = [];
  const store = new FirebaseAdminStore({
    loadConfiguration: options.loadConfiguration || configuredCredential,
    sdk,
    appName: `test-${Date.now()}-${Math.random()}`,
    logger: {
      log: message => messages.push(message),
      warn: message => messages.push(message),
      error: message => messages.push(message),
    },
  });
  t.after(() => store.shutdown());
  return { store, sdk, messages };
}

test('valid service-account credentials initialize the Admin SDK', async t => {
  const { store, messages } = makeStore(t);
  const result = await store.initialize();
  assert.equal(result.status, 'ok');
  assert.equal(store.getStatus().initialized, true);
  assert.ok(messages.includes('[FIREBASE] Admin SDK initialized'));
  assert.ok(messages.includes('[FIREBASE] Using server-side Admin SDK authentication'));
});

test('invalid service-account environment values are reported without initialization', () => {
  const config = loadFirebaseAdminConfiguration({
    env: { FIREBASE_PROJECT_ID: 'project', FIREBASE_CLIENT_EMAIL: 'test@example.com' },
    baseDir: process.cwd(),
  });
  assert.equal(config.enabled, false);
  assert.equal(config.status, 'invalid-credentials');
  assert.match(config.error, /private_key/);
});

test('service-account JSON environment loading normalizes the private key', () => {
  const config = loadFirebaseAdminConfiguration({
    env: {
      FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        project_id: 'project',
        client_email: 'admin@project.iam.gserviceaccount.com',
        private_key: 'line1\\nline2',
      }),
    },
    baseDir: process.cwd(),
  });
  assert.equal(config.enabled, true);
  assert.equal(config.projectId, 'project');
  assert.equal(config.source, 'FIREBASE_SERVICE_ACCOUNT_JSON');
  assert.equal(config.credential.privateKey, 'line1\nline2');
});

test('Application Default Credentials may use FIREBASE_PROJECT_ID without being treated as an incomplete service account', () => {
  const config = loadFirebaseAdminConfiguration({
    env: {
      FIREBASE_USE_APPLICATION_DEFAULT: 'true',
      FIREBASE_PROJECT_ID: 'project',
    },
    baseDir: process.cwd(),
  });
  assert.equal(config.enabled, true);
  assert.equal(config.credentialType, 'application-default');
  assert.equal(config.projectId, 'project');
});

test('invalid Admin SDK credentials are distinguished from an empty database', async t => {
  const sdk = createFakeSdk();
  sdk.cert = () => {
    const error = new Error('Invalid private key');
    error.code = 'app/invalid-credential';
    throw error;
  };
  const { store } = makeStore(t, { sdk });
  const result = await store.fetchDocument('states', 'one');
  assert.equal(result.status, 'invalid-credentials');
  assert.equal(result.data, null);
});

test('Firestore error classification distinguishes project, permission, authentication, and availability failures', () => {
  assert.equal(classifyFirestoreError({ code: 'not-found', message: 'project not found' }).status, 'project-unavailable');
  assert.equal(classifyFirestoreError({ code: 'permission-denied', message: 'denied' }).status, 'permission-denied');
  assert.equal(classifyFirestoreError({ code: 'unauthenticated', message: 'login required' }).status, 'authentication-failed');
  assert.equal(classifyFirestoreError({ code: 'unavailable', message: 'offline' }).status, 'unavailable');
});

test('Admin SDK writes and reads a Firestore document', async t => {
  const { store } = makeStore(t);
  const written = await store.writeDocument('states', 'one', {
    revision: 1,
    updatedAt: '2026-08-31T00:00:00.000Z',
    items: [['A'], ['B']],
  });
  const read = await store.fetchDocument('states', 'one');
  assert.equal(written, true);
  assert.equal(read.status, 'ok');
  assert.deepEqual(read.data.items, [['A'], ['B']]);
  assert.equal(read.data.revision, 1);
});

test('missing Firestore documents return missing rather than unavailable', async t => {
  const { store } = makeStore(t);
  const result = await store.fetchDocument('states', 'missing');
  assert.equal(result.status, 'missing');
  assert.equal(result.data, null);
});

test('Firestore outages return unavailable and never look like missing data', async t => {
  const { store } = makeStore(t, { unavailableReads: true });
  const result = await store.fetchDocument('states', 'one');
  assert.equal(result.status, 'unavailable');
  assert.match(result.error.message, /unavailable/i);
});

test('writes to one document remain serialized and stale revisions are refused', async t => {
  const sdk = createFakeSdk({ transactionDelay: 15 });
  const { store } = makeStore(t, { sdk });
  await Promise.all([
    store.writeDocument('states', 'one', { revision: 1, updatedAt: '2026-08-31T00:00:01.000Z', items: ['A'] }),
    store.writeDocument('states', 'one', { revision: 2, updatedAt: '2026-08-31T00:00:02.000Z', items: ['B'] }),
  ]);
  const stale = await store.writeDocument('states', 'one', { revision: 1, updatedAt: '2026-08-31T00:00:00.000Z', items: ['stale'] });
  const result = await store.fetchDocument('states', 'one');
  assert.equal(sdk.maxTransactionConcurrency, 1);
  assert.equal(stale, false);
  assert.equal(result.data.revision, 2);
  assert.deepEqual(result.data.items, ['B']);
});

test('prefix deletion waits for prior writes and blocks later writes', async t => {
  const sdk = createFakeSdk({ transactionDelay: 10 });
  const { store } = makeStore(t, { sdk });
  const oldWrite = store.writeDocument('daily', '31-08-2026_a', { revision: 1, updatedAt: '2026-08-31T00:00:00.000Z' });
  const deletion = store.deleteByPrefix('daily', '31-08-2026_');
  const newWrite = store.writeDocument('daily', '01-09-2026_a', { revision: 2, updatedAt: '2026-09-01T00:00:00.000Z' });
  await Promise.all([oldWrite, deletion, newWrite]);
  assert.equal(sdk.documents.has('daily/31-08-2026_a'), false);
  assert.equal(sdk.documents.has('daily/01-09-2026_a'), true);
});

test('connection verification succeeds even when the probe document is missing', async t => {
  const { store, messages } = makeStore(t);
  const result = await store.verifyConnection();
  assert.equal(result.connected, true);
  assert.equal(result.status, 'missing');
  assert.ok(messages.includes('[FIREBASE] Firestore connection verified'));
});
