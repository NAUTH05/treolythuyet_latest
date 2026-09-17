const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAccountKey,
  resolveRequestedAccounts,
  classifyAutoScanBlocker,
  findBlockingAutoScanSession,
  planAutoScanStart,
  buildAutoScanStartResponse,
  isAutoScanSessionActive,
} = require('../autoScanStart');
const { AutoCourseRegistry } = require('../autoCourseRegistry');
const { PHASE_RUNNING, PHASE_FINISHED, PHASE_NEW } = require('../autoCourseEngine');

// Phiên giả lập bám đúng vòng đời engine: ownsAccountSession() là chủ sở hữu
// duy nhất của việc "đang thật sự giữ tài khoản Odoo".
function makeSession(id, {
  status = 'idle',
  phase = PHASE_NEW,
  nextRunTime = null,
  email = `${id}@x.vn`,
  name = id,
} = {}) {
  return {
    id,
    status,
    _phase: phase,
    nextRunTime,
    account: { name, email },
    options: {},
    ownsAccountSession: () => phase === PHASE_RUNNING || status === 'paused',
    removeAllListeners: () => {},
    stop: async () => {},
    getStatus: () => ({ id, account: name, status, nextRunTime }),
  };
}

function accountsOf(...names) {
  return names.map(name => ({ name, email: `${name.toLowerCase().replace(/\s+/g, '-')}@x.vn` }));
}

// 1. Một tài khoản hợp lệ khởi động thành công.
test('1. một tài khoản được chọn → kế hoạch start', () => {
  const accounts = accountsOf('Cao Thị Kim Anh');
  const plan = planAutoScanStart({ allAccounts: accounts, requestedIndices: [1], registry: new AutoCourseRegistry() });
  assert.equal(plan.unresolved.length, 0);
  assert.equal(plan.plans.length, 1);
  assert.equal(plan.plans[0].account.name, 'Cao Thị Kim Anh');
  assert.equal(plan.plans[0].action, 'start');
});

// 2. acc.index khác vị trí mảng vẫn phân giải đúng.
test('2. acc.index lệch vị trí mảng vẫn trỏ đúng tài khoản', () => {
  const accounts = [
    { name: 'Sai', email: 'sai@x.vn', index: 5 },
    { name: 'Đúng', email: 'dung@x.vn', index: 7 },
  ];
  const plan = planAutoScanStart({ allAccounts: accounts, requestedIndices: [7], registry: new AutoCourseRegistry() });
  assert.equal(plan.unresolved.length, 0);
  assert.equal(plan.plans[0].account.name, 'Đúng');

  // index không tồn tại KHÔNG được fallback sang vị trí (tránh trỏ nhầm).
  const bad = planAutoScanStart({ allAccounts: accounts, requestedIndices: [1], registry: new AutoCourseRegistry() });
  assert.deepEqual(bad.unresolved, [1]);
  assert.equal(bad.plans.length, 0);
});

// 3. "7" (string) và 7 (number) phân giải an toàn, không nhân đôi.
test('3. "7" và 7 là cùng một tài khoản, không tạo hai kế hoạch', () => {
  assert.equal(normalizeAccountKey('7'), 7);
  assert.equal(normalizeAccountKey(7), 7);
  const accounts = accountsOf('A', 'B', 'C', 'D', 'E', 'F', 'G');
  const plan = planAutoScanStart({ allAccounts: accounts, requestedIndices: ['7', 7], registry: new AutoCourseRegistry() });
  assert.equal(plan.plans.length, 1);
  assert.equal(plan.plans[0].account.name, 'G');
});

// 4. Index không hợp lệ → unresolved tường minh.
test('4. tài khoản không phân giải được nằm trong unresolved', () => {
  const accounts = accountsOf('A');
  const plan = planAutoScanStart({ allAccounts: accounts, requestedIndices: [99], registry: new AutoCourseRegistry() });
  assert.deepEqual(plan.unresolved, [99]);
  assert.equal(plan.resolved.length, 0);
  const resolution = resolveRequestedAccounts(accounts, [99, 'abc']);
  assert.deepEqual(resolution.unresolved, [99, 'abc']);
});

// 5. Phiên đang chạy thật thì chặn start trùng.
test('5. phiên đang chạy chặn start trùng', () => {
  const registry = new AutoCourseRegistry();
  const running = makeSession('run', { status: 'studying', phase: PHASE_RUNNING });
  registry.adopt(running);
  const plan = planAutoScanStart({ allAccounts: [{ name: 'A', email: 'run@x.vn' }], requestedIndices: [1], registry });
  assert.equal(plan.plans[0].action, 'skip');
  assert.equal(plan.plans[0].sessionId, 'run');
});

// 6. Phiên tạm dừng thật thì chặn start trùng (không được dọn).
test('6. phiên tạm dừng chặn start trùng', () => {
  const registry = new AutoCourseRegistry();
  const paused = makeSession('pause', { status: 'paused', phase: PHASE_FINISHED });
  registry.adopt(paused);
  const verdict = classifyAutoScanBlocker(paused);
  assert.equal(verdict.blocking, true);
  assert.equal(verdict.category, 'paused');
  const plan = planAutoScanStart({ allAccounts: [{ name: 'A', email: 'pause@x.vn' }], requestedIndices: [1], registry });
  assert.equal(plan.plans[0].action, 'skip');
});

// 7. Phiên hẹn lịch tương lai thật thì chặn start trùng.
test('7. phiên hẹn lịch tương lai chặn start trùng', () => {
  const registry = new AutoCourseRegistry();
  const future = makeSession('future', {
    status: 'next-day',
    phase: PHASE_FINISHED,
    nextRunTime: new Date(Date.now() + 3600_000).toISOString(),
  });
  registry.adopt(future);
  const plan = planAutoScanStart({ allAccounts: [{ name: 'A', email: 'future@x.vn' }], requestedIndices: [1], registry });
  assert.equal(plan.plans[0].action, 'skip');
  assert.equal(plan.plans[0].status, 'next-day');

  // idle đang chờ lịch random trong tương lai cũng là blocker hợp lệ.
  const waiting = makeSession('waiting', {
    status: 'idle',
    phase: PHASE_NEW,
    nextRunTime: new Date(Date.now() + 3600_000).toISOString(),
  });
  assert.equal(classifyAutoScanBlocker(waiting).blocking, true);
});

// 8. Phiên non-terminal mồ côi KHÔNG chặn start mới.
test('8. phiên non-terminal mồ côi không chặn start mới', () => {
  const registry = new AutoCourseRegistry();
  const orphan = makeSession('orphan', { status: 'idle', phase: PHASE_FINISHED });
  registry.adopt(orphan);
  const plan = planAutoScanStart({ allAccounts: [{ name: 'A', email: 'orphan@x.vn' }], requestedIndices: [1], registry });
  assert.equal(plan.plans[0].action, 'cleanup+start');
  assert.deepEqual(plan.plans[0].stale.map(s => s.sessionId), ['orphan']);
});

// 9. Lịch quá hạn được dọn và phiên mới start được.
test('9. lịch quá hạn bị dọn rồi start phiên mới', async () => {
  const registry = new AutoCourseRegistry();
  const expired = makeSession('expired', {
    status: 'daily-limit',
    phase: PHASE_FINISHED,
    nextRunTime: new Date(Date.now() - 60_000).toISOString(),
  });
  registry.adopt(expired);

  const plan = planAutoScanStart({ allAccounts: [{ name: 'A', email: 'expired@x.vn' }], requestedIndices: [1], registry });
  assert.equal(plan.plans[0].action, 'cleanup+start');
  assert.equal(plan.plans[0].stale[0].category, 'stale-schedule');

  await registry.forget('expired');
  assert.equal(registry.has('expired'), false);
  const after = planAutoScanStart({ allAccounts: [{ name: 'A', email: 'expired@x.vn' }], requestedIndices: [1], registry });
  assert.equal(after.plans[0].action, 'start');
});

// 10. Entry mồ côi ẩn trong registry được dọn (không còn chặn).
test('10. entry mồ côi ẩn trong registry được dọn khỏi trạng thái chặn', async () => {
  const registry = new AutoCourseRegistry();
  const hidden = makeSession('hidden', { status: 'scanning', phase: PHASE_FINISHED });
  registry.adopt(hidden);
  assert.equal(findBlockingAutoScanSession(registry, 'hidden@x.vn'), null);

  await registry.forget('hidden');
  assert.equal(registry.has('hidden'), false);
  const plan = planAutoScanStart({ allAccounts: [{ name: 'A', email: 'hidden@x.vn' }], requestedIndices: [1], registry });
  assert.equal(plan.plans[0].action, 'start');
});

// 11. Xóa phiên trên Dashboard cũng xóa trạng thái chặn trong registry.
test('11. xóa phiên Dashboard gỡ luôn blocker hợp lệ trong registry', async () => {
  const registry = new AutoCourseRegistry();
  registry.adopt(makeSession('blocker', { status: 'studying', phase: PHASE_RUNNING }));
  assert.equal(findBlockingAutoScanSession(registry, 'blocker@x.vn').session.id, 'blocker');

  await registry.forget('blocker');
  assert.equal(findBlockingAutoScanSession(registry, 'blocker@x.vn'), null);
  assert.equal(registry.has('blocker'), false);
});

// 12. Xóa phiên đã kết thúc không để lại khóa/state chặn.
test('12. phiên terminal không bao giờ là blocker và bị clear sạch', async () => {
  const registry = new AutoCourseRegistry();
  const done = makeSession('done', { status: 'completed', phase: PHASE_FINISHED });
  registry.adopt(done);
  assert.equal(classifyAutoScanBlocker(done).blocking, false);
  assert.equal(classifyAutoScanBlocker(done).stale, false);
  await registry.forget('done');
  assert.equal(registry.size, 0);
});

// 15. Chống double-click: sau khi phiên đầu được tạo, kế hoạch kế tiếp phải skip.
test('15. double-click không tạo hai phiên cho cùng tài khoản', () => {
  const registry = new AutoCourseRegistry();
  const accounts = [{ name: 'A', email: 'a@x.vn' }];

  const first = planAutoScanStart({ allAccounts: accounts, requestedIndices: [1], registry });
  assert.equal(first.plans[0].action, 'start');

  // Mô phỏng request 1 đã tạo phiên và đang chạy trước khi request 2 tới.
  registry.adopt(makeSession('fresh', { status: 'logging-in', phase: PHASE_RUNNING, email: 'a@x.vn', name: 'A' }));

  const second = planAutoScanStart({ allAccounts: accounts, requestedIndices: [1], registry });
  assert.equal(second.plans[0].action, 'skip');
  assert.equal(second.plans[0].sessionId, 'fresh');
});

// Response semantics.
test('response phân biệt all-started / partial / none-started', () => {
  const all = buildAutoScanStartResponse({ started: [{ account: 'A' }], skipped: [], unresolved: [] });
  assert.equal(all.result, 'all-started');
  assert.equal(all.ok, true);

  const partial = buildAutoScanStartResponse({ started: [{ account: 'A' }], skipped: [{ account: 'B' }], unresolved: [] });
  assert.equal(partial.result, 'partial');

  const none = buildAutoScanStartResponse({ started: [], skipped: [{ account: 'B', reason: 'x' }], unresolved: [] });
  assert.equal(none.result, 'none-started');
  assert.equal(none.ok, true);
});

test('isAutoScanSessionActive chỉ đúng khi phiên thật sự đang chạy', () => {
  assert.equal(isAutoScanSessionActive(makeSession('a', { status: 'idle', phase: PHASE_NEW })), false);
  assert.equal(isAutoScanSessionActive(makeSession('b', { status: 'studying', phase: PHASE_RUNNING })), true);
  assert.equal(isAutoScanSessionActive(makeSession('c', { status: 'paused', phase: PHASE_FINISHED })), true);
  assert.equal(isAutoScanSessionActive(makeSession('d', { status: 'completed', phase: PHASE_FINISHED })), false);
});
