const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SerializedStateSync, readStateDocument } = require('../stateSync');

function makeTempStateFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treohoc-state-sync-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'state.json');
}

function makeRemote(initial = null, options = {}) {
  let document = initial;
  let attempts = 0;
  const writes = [];
  return {
    fetch: async () => options.unavailable
      ? { status: 'unavailable', data: null, error: new Error('offline') }
      : document
        ? { status: 'ok', data: structuredClone(document) }
        : { status: 'missing', data: null },
    sync: async (_collection, _id, next) => {
      attempts++;
      if (attempts <= (options.failWrites || 0)) return false;
      document = structuredClone(next);
      writes.push(document.revision);
      return true;
    },
    get document() { return document; },
    get attempts() { return attempts; },
    get writes() { return writes; },
  };
}

function makeWriter(t, file, remote, extra = {}) {
  const writer = new SerializedStateSync({
    label: 'test state',
    filePath: file,
    arrayKey: 'items',
    collection: 'states',
    documentId: 'state',
    loadConfig: () => ({ projectId: 'test', apiKey: 'key' }),
    fetchRemote: remote.fetch,
    syncRemote: remote.sync,
    retryDelays: [1, 2, 3],
    logger: { log() {}, warn() {}, error() {} },
    ...extra,
  });
  t.after(() => writer.stop());
  return writer;
}

test('an empty local array remains readable as a legacy local state', t => {
  const file = makeTempStateFile(t);
  fs.writeFileSync(file, '[]', 'utf8');
  const state = readStateDocument(file, 'items');
  assert.equal(state.available, true);
  assert.deepEqual(state.data, []);
});

test('rapid updates commit locally and only the latest revision becomes authoritative', async t => {
  const file = makeTempStateFile(t);
  const remote = makeRemote();
  const writer = makeWriter(t, file, remote);

  await Promise.all([
    writer.persist({ items: ['A'] }),
    writer.persist({ items: ['B'] }),
    writer.persist({ items: ['C'] }),
    writer.persist({ items: ['D'] }),
  ]);
  await writer.waitForIdle();

  assert.deepEqual(remote.document.items, ['D']);
  assert.equal(remote.document.revision, 4);
  assert.deepEqual(remote.writes, [4]);
  const local = readStateDocument(file, 'items');
  assert.deepEqual(local.data, ['D']);
  assert.equal(local.sync.dirty, false);
});

test('a stale in-flight callback cannot replace or upload over a newer local revision', async t => {
  const file = makeTempStateFile(t);
  let releaseFirstFetch;
  let fetchCount = 0;
  let remoteDocument = null;
  const writer = makeWriter(t, file, {
    fetch: async () => {
      fetchCount++;
      if (fetchCount === 1) await new Promise(resolve => { releaseFirstFetch = resolve; });
      return remoteDocument ? { status: 'ok', data: structuredClone(remoteDocument) } : { status: 'missing', data: null };
    },
    sync: async (_collection, _id, document) => {
      remoteDocument = structuredClone(document);
      return true;
    },
  });

  await writer.persist({ items: ['old'] });
  await new Promise(resolve => setImmediate(resolve));
  await writer.persist({ items: ['latest'] });
  releaseFirstFetch();
  await writer.waitForIdle();

  assert.deepEqual(remoteDocument.items, ['latest']);
  assert.equal(remoteDocument.revision, 2);
  assert.deepEqual(readStateDocument(file, 'items').data, ['latest']);
});

test('Firebase failures remain dirty and retry until read-after-write verification succeeds', async t => {
  const file = makeTempStateFile(t);
  const remote = makeRemote(null, { failWrites: 3 });
  const writer = makeWriter(t, file, remote);

  const result = await writer.persist({ items: ['latest'] });
  assert.equal(result.firebase, 'pending');
  assert.equal(readStateDocument(file, 'items').sync.dirty, true);

  await writer.waitForIdle(1000);
  assert.equal(remote.attempts, 4);
  assert.deepEqual(remote.document.items, ['latest']);
  assert.equal(readStateDocument(file, 'items').sync.dirty, false);
  assert.ok(writer.getStatus().lastSuccessfulSyncAt);
});

test('paused synchronization keeps runtime changes local until a safe resume', async t => {
  const file = makeTempStateFile(t);
  const remote = makeRemote();
  const writer = makeWriter(t, file, remote);

  writer.pause();
  await writer.persist({ items: ['runtime'] });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(remote.document, null);
  assert.equal(readStateDocument(file, 'items').sync.dirty, true);

  writer.resume();
  await writer.waitForIdle();
  assert.deepEqual(remote.document.items, ['runtime']);
});

test('Firebase recovery continues from the recovered revision instead of moving backwards', async t => {
  const file = makeTempStateFile(t);
  const remote = makeRemote({ items: ['remote'], revision: 41, updatedAt: '2026-08-30T00:00:00.000Z' });
  const writer = makeWriter(t, file, remote);

  const result = await writer.reconcile();
  assert.equal(result.action, 'restore-remote');
  await writer.persist({ items: ['new'] });
  await writer.waitForIdle();
  assert.equal(remote.document.revision, 42);
  assert.deepEqual(remote.document.items, ['new']);
});

test('new VPS restores a populated Firebase document when the local file is missing', async t => {
  const file = makeTempStateFile(t);
  const remote = makeRemote({ items: ['A', 'B'], revision: 7, updatedAt: '2026-08-30T00:00:00.000Z' });
  const writer = makeWriter(t, file, remote);

  const result = await writer.reconcile();
  assert.equal(result.action, 'restore-remote');
  assert.deepEqual(readStateDocument(file, 'items').data, ['A', 'B']);
  assert.equal(readStateDocument(file, 'items').sync.dirty, false);
  assert.deepEqual(remote.writes, []);
});

test('populated Firebase is protected from an empty untrusted local cache', async t => {
  const file = makeTempStateFile(t);
  fs.writeFileSync(file, JSON.stringify({ items: [], revision: 99, updatedAt: '2026-08-30T01:00:00.000Z' }));
  const remote = makeRemote({ items: ['protected'], revision: 3, updatedAt: '2026-08-30T00:00:00.000Z' });
  const writer = makeWriter(t, file, remote, { initialRevision: 99 });

  const result = await writer.reconcile();
  assert.equal(result.action, 'restore-remote');
  assert.deepEqual(readStateDocument(file, 'items').data, ['protected']);
  assert.deepEqual(remote.writes, []);
});

test('Firebase unavailable at startup preserves local cache without publishing it', async t => {
  const file = makeTempStateFile(t);
  fs.writeFileSync(file, JSON.stringify({ items: ['local'], revision: 2, updatedAt: '2026-08-30T00:00:00.000Z' }));
  const remote = makeRemote(null, { unavailable: true });
  const writer = makeWriter(t, file, remote, { initialRevision: 2 });

  const result = await writer.reconcile();
  assert.equal(result.action, 'local-cache');
  assert.deepEqual(readStateDocument(file, 'items').data, ['local']);
  assert.deepEqual(remote.writes, []);
});

test('missing Firebase document queues an existing local cache for verified upload', async t => {
  const file = makeTempStateFile(t);
  fs.writeFileSync(file, JSON.stringify({ items: ['local'], revision: 5, updatedAt: '2026-08-30T00:00:00.000Z' }));
  const remote = makeRemote();
  const writer = makeWriter(t, file, remote, { initialRevision: 5 });

  const result = await writer.reconcile();
  assert.equal(result.action, 'upload-local');
  await writer.waitForIdle();
  assert.deepEqual(remote.document.items, ['local']);
  assert.equal(remote.document.revision, 5);
});

test('newer remote revision wins and is not overwritten by stale local state', async t => {
  const file = makeTempStateFile(t);
  fs.writeFileSync(file, JSON.stringify({ items: ['stale'], revision: 4, updatedAt: '2026-08-29T00:00:00.000Z' }));
  const remote = makeRemote({ items: ['newer'], revision: 8, updatedAt: '2026-08-30T00:00:00.000Z' });
  const writer = makeWriter(t, file, remote, { initialRevision: 4 });

  const result = await writer.reconcile();
  assert.equal(result.action, 'restore-remote');
  assert.deepEqual(readStateDocument(file, 'items').data, ['newer']);
  assert.deepEqual(remote.writes, []);
});
