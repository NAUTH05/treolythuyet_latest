const test = require('node:test');
const assert = require('node:assert/strict');
const { syncToFirebaseREST, deleteDocumentsByPrefixREST } = require('../firebase-service');

test('all writes to the same Firebase document are globally serialized', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const revisions = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  global.fetch = async (_url, options) => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    const body = JSON.parse(options.body);
    const revision = Number(body.fields.revision.integerValue);
    await new Promise(resolve => setTimeout(resolve, revision === 1 ? 20 : 1));
    revisions.push(revision);
    concurrent--;
    return { ok: true, status: 200 };
  };

  const config = { projectId: `test-${Date.now()}`, apiKey: 'key' };
  await Promise.all([
    syncToFirebaseREST('system_autoscan', 'state', { revision: 1 }, config),
    syncToFirebaseREST('system_autoscan', 'state', { revision: 2 }, config),
  ]);

  assert.deepEqual(revisions, [1, 2]);
  assert.equal(maxConcurrent, 1);
});

test('collection deletion waits for older writes and blocks newer writes until delete completes', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const operations = [];
  global.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (method === 'PATCH') {
      const body = JSON.parse(options.body);
      const revision = Number(body.fields.revision.integerValue);
      if (revision === 1) await new Promise(resolve => setTimeout(resolve, 20));
      operations.push(`PATCH:${revision}`);
      return { ok: true, status: 200 };
    }
    if (method === 'DELETE') {
      operations.push('DELETE');
      return { ok: true, status: 200 };
    }
    operations.push('LIST');
    return {
      ok: true,
      status: 200,
      json: async () => ({ documents: [{ name: 'projects/p/databases/(default)/documents/system_logs_daily/09-08-2026_user' }] }),
    };
  };

  const config = { projectId: `barrier-${Date.now()}`, apiKey: 'key' };
  const oldWrite = syncToFirebaseREST('system_logs_daily', '09-08-2026_user', { revision: 1 }, config);
  const deletion = deleteDocumentsByPrefixREST('system_logs_daily', '09-08-2026_', config);
  const newWrite = syncToFirebaseREST('system_logs_daily', '10-08-2026_user', { revision: 2 }, config);
  await Promise.all([oldWrite, deletion, newWrite]);

  assert.deepEqual(operations, ['PATCH:1', 'LIST', 'DELETE', 'PATCH:2']);
});
