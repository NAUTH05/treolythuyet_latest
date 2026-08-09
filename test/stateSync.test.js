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

test('an empty local array remains an authoritative state instead of missing data', t => {
  const file = makeTempStateFile(t);
  fs.writeFileSync(file, '[]', 'utf8');
  const state = readStateDocument(file, 'autoScans');
  assert.equal(state.available, true);
  assert.deepEqual(state.data, []);
});

test('local snapshots are atomic/versioned and Firebase writes stay serialized', async t => {
  const file = makeTempStateFile(t);
  const remoteRevisions = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const writer = new SerializedStateSync({
    label: 'test',
    filePath: file,
    collection: 'states',
    documentId: 'state',
    loadConfig: () => ({ projectId: 'test' }),
    syncRemote: async (_collection, _id, document) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(resolve => setTimeout(resolve, document.revision === 1 ? 25 : 1));
      remoteRevisions.push(document.revision);
      concurrent--;
      return true;
    },
  });

  const first = writer.persist({ autoScans: [{ id: 'old' }] });
  const second = writer.persist({ autoScans: [] });
  await Promise.all([first, second]);

  assert.deepEqual(remoteRevisions, [1, 2]);
  assert.equal(maxConcurrent, 1);
  assert.deepEqual(readStateDocument(file, 'autoScans').data, []);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).revision, 2);
});

test('Firebase transient failures are retried before the mutation is rejected', async t => {
  const file = makeTempStateFile(t);
  let attempts = 0;
  const writer = new SerializedStateSync({
    label: 'test',
    filePath: file,
    collection: 'states',
    documentId: 'state',
    loadConfig: () => ({ projectId: 'test' }),
    syncRemote: async () => ++attempts >= 3,
  });

  const result = await writer.persist({ queues: [] });
  assert.equal(attempts, 3);
  assert.equal(result.firebase, 'synced');
});

test('Firebase recovery continues from the recovered revision instead of moving backwards', async t => {
  const file = makeTempStateFile(t);
  let remoteRevision = null;
  const writer = new SerializedStateSync({
    label: 'test',
    filePath: file,
    collection: 'states',
    documentId: 'state',
    loadConfig: () => ({ projectId: 'test' }),
    syncRemote: async (_collection, _id, document) => {
      remoteRevision = document.revision;
      return true;
    },
  });
  writer.ensureRevisionAtLeast(41);
  await writer.persist({ autoScans: [] });
  assert.equal(remoteRevision, 42);
});
