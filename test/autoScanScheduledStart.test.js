const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  AUTO_COURSE_STATUSES,
  SCHEDULED_STATUSES,
  TERMINAL_STATUSES,
  SCHEDULED_START_STATUS,
  AutoCourseSession,
  PHASE_NEW,
  PHASE_RUNNING,
  PHASE_FINISHED,
} = require('../autoCourseEngine');
const {
  applyScheduledStart,
  hasFutureNextRun,
  classifyAutoScanBlocker,
  findBlockingAutoScanSession,
  describeAutoScanBlocker,
} = require('../autoScanStart');
const {
  canRestartScheduledSession,
  isStaleScheduledSession,
} = require('../autoScanRecovery');
const { AutoCourseRegistry } = require('../autoCourseRegistry');
const { autoScanSnapshot, createAutoScanBroadcaster } = require('../autoScanBroadcast');

function makeSession(id, { status = 'idle', phase = PHASE_NEW, nextRunTime = null, email = `${id}@x.vn`, name = id } = {}) {
  return {
    id,
    status,
    _phase: phase,
    nextRunTime,
    account: { name, email },
    options: {},
    getStatus() {
      return { id, account: name, status: this.status, currentCourseIndex: 0, totalCourses: 0 };
    },
    ownsAccountSession: () => phase === PHASE_RUNNING || status === 'paused',
    removeAllListeners: () => {},
    stop: async () => {},
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 3. scheduled-start là trạng thái chính thức, thuộc nhóm hẹn lịch, không terminal.
test('engine: scheduled-start là trạng thái hẹn lịch không terminal', () => {
  assert.equal(AUTO_COURSE_STATUSES.includes(SCHEDULED_START_STATUS), true);
  assert.equal(SCHEDULED_STATUSES.has(SCHEDULED_START_STATUS), true);
  assert.equal(TERMINAL_STATUSES.has(SCHEDULED_START_STATUS), false);
});

// 3,4,6. applyScheduledStart đặt status + nextRunTime, không dùng idle, không đụng phase.
test('applyScheduledStart: lịch tương lai → scheduled-start + nextRunTime, giữ PHASE_NEW', () => {
  const at = new Date(Date.now() + 3600_000);
  const session = makeSession('s');
  // Phiên có options.randomStartEnabled trong thực tế; hàm thuần không cần.
  const applied = applyScheduledStart(session, at);
  assert.equal(applied, true);
  assert.equal(session.status, 'scheduled-start');
  assert.notEqual(session.status, 'idle');
  assert.equal(session.nextRunTime, at.toISOString());
  assert.equal(session._phase, PHASE_NEW, 'không được set PHASE_RUNNING sớm');
  assert.equal(hasFutureNextRun(session, Date.now()), true);
});

test('applyScheduledStart: lịch đã qua/không hợp lệ → không áp dụng', () => {
  const past = makeSession('past');
  assert.equal(applyScheduledStart(past, new Date(Date.now() - 60_000)), false);
  assert.equal(past.status, 'idle');
  assert.equal(past.nextRunTime, null);

  const invalid = makeSession('invalid');
  assert.equal(applyScheduledStart(invalid, 'not-a-date'), false);
  assert.equal(invalid.status, 'idle');
});

// 7. scheduled-start với nextRunTime tương lai là blocker hợp lệ.
test('scheduled-start tương lai chặn Start trùng', () => {
  const future = makeSession('future', {
    status: SCHEDULED_START_STATUS,
    phase: PHASE_FINISHED,
    nextRunTime: new Date(Date.now() + 3600_000).toISOString(),
  });
  const verdict = classifyAutoScanBlocker(future);
  assert.equal(verdict.blocking, true);
  assert.equal(verdict.category, 'scheduled');
  assert.match(describeAutoScanBlocker(future, verdict), /đã hẹn lịch/);
});

// 8. scheduled-start quá hạn, không có engine/owner → đủ điều kiện stale recovery.
test('scheduled-start quá hạn là stale, đủ điều kiện khôi phục', () => {
  const expired = makeSession('expired', {
    status: SCHEDULED_START_STATUS,
    phase: PHASE_FINISHED,
    nextRunTime: new Date(Date.now() - 60_000).toISOString(),
  });
  const verdict = classifyAutoScanBlocker(expired);
  assert.equal(verdict.blocking, false);
  assert.equal(verdict.stale, true);
  assert.equal(verdict.category, 'stale-schedule');
  assert.equal(isStaleScheduledSession(expired), true);
  assert.equal(canRestartScheduledSession(expired), true);
});

// 8b. scheduled-start còn phase running thì không được coi là stale/khôi phục.
test('scheduled-start còn running không bị stale recovery', () => {
  const running = makeSession('running', {
    status: SCHEDULED_START_STATUS,
    phase: PHASE_RUNNING,
    nextRunTime: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal(canRestartScheduledSession(running), false);
  assert.equal(isStaleScheduledSession(running), false);
});

// 1,2. Session mới phải được broadcast ngay, không cần F5.
test('autoScanSnapshot/broadcaster phát autoscan-status ngay khi tạo phiên', () => {
  const emitted = [];
  const emit = createAutoScanBroadcaster({ emit: (event, payload) => emitted.push({ event, payload }) });
  const session = makeSession('new', { status: 'idle' });
  const sent = emit(session);

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'autoscan-status');
  assert.equal(emitted[0].payload.id, 'new');
  assert.equal('nextRunTime' in emitted[0].payload, true);
  assert.equal('completedAt' in emitted[0].payload, true);
  assert.deepEqual(sent, emitted[0].payload);
});

// 13,16. Nhiều tài khoản hẹn lịch → nhiều snapshot phát ra ngay.
test('4 phiên hẹn lịch phát ra 4 snapshot riêng biệt ngay lập tức', () => {
  const emitted = [];
  const emit = createAutoScanBroadcaster({ emit: (event, payload) => emitted.push(payload) });
  const times = [6, 15, 4, 22];
  times.forEach((minute, index) => {
    const session = makeSession(`acc${index}`, {
      status: SCHEDULED_START_STATUS,
      phase: PHASE_FINISHED,
      nextRunTime: new Date(Date.now() + 3600_000 + minute * 60_000).toISOString(),
      name: `Tài khoản ${index}`,
    });
    emit(session);
  });
  assert.equal(emitted.length, 4);
  const ids = emitted.map(s => s.id).sort();
  assert.deepEqual(ids, ['acc0', 'acc1', 'acc2', 'acc3']);
  for (const snap of emitted) {
    assert.equal(snap.status, SCHEDULED_START_STATUS);
    assert.ok(snap.nextRunTime, 'mỗi snapshot có giờ hẹn riêng');
  }
});

// 14. Reconnect/init phải cho cùng snapshot với luồng live.
test('snapshot cho cùng một phiên là bất biến (init = live)', () => {
  const session = makeSession('stable', {
    status: SCHEDULED_START_STATUS,
    phase: PHASE_FINISHED,
    nextRunTime: new Date(Date.now() + 7200_000).toISOString(),
  });
  const a = autoScanSnapshot(session);
  const b = autoScanSnapshot(session);
  assert.deepEqual(a, b);
  assert.deepEqual(a, b, 'init và live dùng chung autoScanSnapshot nên không lệch');
});

// 9. Timer trùng không nổ hai lần cho cùng phiên.
test('setTimer cho cùng sessionId chỉ nổ đúng một lần', async () => {
  const registry = new AutoCourseRegistry();
  let fires = 0;
  registry.setTimer('s', Date.now() + 20, () => { fires++; });
  registry.setTimer('s', Date.now() + 20, () => { fires++; });
  // registry.setTimer kẹp delay tối thiểu 1000ms để tránh timer bão hòa.
  await sleep(1300);
  assert.equal(fires, 1);
});

// 11. Stop/Xóa scheduled-start gỡ timer + không còn blocker.
test('xóa phiên scheduled-start gỡ timer và blocker', async () => {
  const registry = new AutoCourseRegistry();
  const scheduled = makeSession('sched', {
    status: SCHEDULED_START_STATUS,
    phase: PHASE_FINISHED,
    nextRunTime: new Date(Date.now() + 3600_000).toISOString(),
  });
  registry.adopt(scheduled);
  registry.setTimer('sched', Date.now() + 3600_000, () => {});
  assert.equal(registry.hasTimer('sched'), true);
  assert.equal(findBlockingAutoScanSession(registry, 'sched@x.vn').session.id, 'sched');

  await registry.forget('sched');
  assert.equal(registry.hasTimer('sched'), false);
  assert.equal(registry.has('sched'), false);
  assert.equal(findBlockingAutoScanSession(registry, 'sched@x.vn'), null);
});

// 12. scheduled-start đã Dừng không hồi sinh.
test('scheduled-start đã stopped không hồi sinh', () => {
  const stopped = makeSession('stopped', {
    status: 'stopped',
    phase: PHASE_FINISHED,
    nextRunTime: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal(isStaleScheduledSession(stopped), false);
  assert.equal(canRestartScheduledSession(stopped), false);
  assert.equal(classifyAutoScanBlocker(stopped).blocking, false);
});

// 10. Khi tới giờ, scheduled-start chuyển sang trạng thái làm việc bình thường.
test('scheduled-start chuyển sang logging-in khi engine bắt đầu', () => {
  const session = new AutoCourseSession('transition', { name: 'T', email: 't@x.vn' }, []);
  session.status = SCHEDULED_START_STATUS;
  session._phase = PHASE_RUNNING;
  assert.equal(session._isRunActive(), false, 'chưa chạy khi còn scheduled-start');
  assert.equal(session._setStatus('logging-in'), true);
  assert.equal(session.status, 'logging-in');
  assert.equal(session._isRunActive(), true, 'đã chạy sau khi rời scheduled-start');
});

// 5. Frontend phải xếp scheduled-start vào nhóm hẹn lịch, không phải đang chạy.
function setMembers(source, name) {
  const match = source.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`));
  assert.notEqual(match, null, `không tìm thấy ${name}`);
  return new Set([...match[1].matchAll(/'([a-z-]+)'/g)].map(m => m[1]));
}

test('Dashboard xếp scheduled-start vào nhóm hẹn lịch, không phải đang chạy', () => {
  const panelPath = path.join(__dirname, '..', 'client', 'src', 'components', 'AutoScanPanel.jsx');
  const source = fs.readFileSync(panelPath, 'utf8');
  assert.equal(setMembers(source, 'SCHEDULED_STATUSES').has('scheduled-start'), true);
  assert.equal(setMembers(source, 'ACTIVE_STATUSES').has('scheduled-start'), false);
  assert.equal(setMembers(source, 'DONE_STATUSES').has('scheduled-start'), false);
  assert.match(source, /Đã hẹn lịch/);
});

// 13,20. Trước auto-discovery phải hiển thị "Chưa quét", không bịa 1/1.
test('Dashboard hiển thị "Chưa quét" khi chưa có dữ liệu khóa học', () => {
  const panelPath = path.join(__dirname, '..', 'client', 'src', 'components', 'AutoScanPanel.jsx');
  const source = fs.readFileSync(panelPath, 'utf8');
  assert.match(source, /Chưa quét/);
  assert.equal(
    source.includes("Math.min((scan.currentCourseIndex || 0) + 1, scan.totalCourses || 1)}/{scan.totalCourses || 1}"),
    false,
    'vẫn còn công thức bịa 1/1',
  );
});
