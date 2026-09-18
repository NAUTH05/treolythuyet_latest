const test = require('node:test');
const assert = require('node:assert/strict');
const { AutoCourseSession, PHASE_RUNNING, PHASE_FINISHED } = require('../autoCourseEngine');
const { AutoCourseRegistry } = require('../autoCourseRegistry');
const {
  isScheduledAutoScan,
  canRestartScheduledSession,
  isStaleScheduledSession,
  restartScheduledSession,
  applyAutoScanRestoreState,
} = require('../autoScanRecovery');

// Phiên hẹn giờ giả lập cho tầng điều phối (server). Không mở browser.
function fakeScheduledSession(id, {
  status = 'daily-limit',
  nextRunTime = null,
  phase = PHASE_FINISHED,
  stopped = false,
} = {}) {
  return {
    id,
    status,
    _phase: phase,
    _stopped: stopped,
    nextRunTime,
    account: { name: id, email: `${id}@x.vn` },
    coursesConfig: [],
    options: {},
    ownsAccountSession: () => phase === PHASE_RUNNING,
  };
}

// 7. Scheduled run transitions to PHASE_FINISHED (đã kiểm ở engine) — ở đây xác
// nhận trạng thái hẹn giờ vẫn được coi là "cần restart" bởi tầng điều phối.
test('trạng thái hẹn giờ là nguồn duy nhất cho restart, không phải trạng thái kết thúc', () => {
  for (const status of ['daily-limit', 'date-limit', 'time-window', 'next-day', 'discovery-retry']) {
    assert.equal(isScheduledAutoScan(fakeScheduledSession('s', { status })), true, status);
    assert.equal(canRestartScheduledSession(fakeScheduledSession('s', { status })), true, status);
  }
  for (const status of ['stopped', 'completed', 'error', 'studying', 'paused', 'idle']) {
    assert.equal(isScheduledAutoScan(fakeScheduledSession('s', { status })), false, status);
    assert.equal(canRestartScheduledSession(fakeScheduledSession('s', { status })), false, status);
  }
});

// 8. Timer tạo đúng MỘT phiên mới.
test('hẹn giờ tạo đúng MỘT phiên mới và không tái sử dụng đối tượng phiên cũ', () => {
  const registry = new AutoCourseRegistry();
  const old = fakeScheduledSession('s1', { nextRunTime: new Date(Date.now() - 1000).toISOString() });
  registry.adopt(old);

  let created = 0;
  const fresh = restartScheduledSession(registry, 's1', {
    createFreshSession: (previous) => {
      created++;
      const next = fakeScheduledSession(previous.id, { status: 'idle', phase: 'new', nextRunTime: null });
      registry.adopt(next); // server làm việc này trong createAutoScanSession()
      return next;
    },
    startSession: () => {},
  });

  assert.equal(created, 1, 'chỉ tạo đúng một phiên mới');
  assert.notEqual(fresh, old);
  assert.equal(registry.get('s1'), fresh);
  assert.equal(registry.isCurrent(old), false, 'phiên cũ bị thu hồi, không còn là chủ ID');

  // Timer trùng: phiên mới đã ở trạng thái 'idle' nên không restart thêm lần nữa.
  const again = restartScheduledSession(registry, 's1', {
    createFreshSession: () => { created++; return fakeScheduledSession('s1', { status: 'idle', phase: 'new' }); },
    startSession: () => {},
  });
  assert.equal(again, null);
  assert.equal(created, 1, 'timer trùng không được tạo thêm phiên');
});

test('phiên hẹn giờ còn đang chạy (phase running) không được restart để tránh hai browser', () => {
  const registry = new AutoCourseRegistry();
  const running = fakeScheduledSession('running', { status: 'daily-limit', phase: PHASE_RUNNING });
  registry.adopt(running);
  let created = 0;
  const fresh = restartScheduledSession(registry, 'running', {
    createFreshSession: () => { created++; return fakeScheduledSession('running', { status: 'idle', phase: 'new' }); },
    startSession: () => {},
  });
  assert.equal(fresh, null);
  assert.equal(created, 0);
});

// 9. Đối tượng phiên cũ không bao giờ restart (engine + registry).
test('đối tượng phiên cũ đã bị thu hồi không thể là nguồn của một lần chạy mới', async () => {
  const session = new AutoCourseSession('retired', { name: 'Retired', email: 'r@x.vn' }, []);
  session._phase = PHASE_RUNNING;
  session._activeCourseRunId = 2;
  session.status = 'studying';
  session._enterScheduledStatus('daily-limit');
  assert.equal(session._phase, PHASE_FINISHED);

  const warns = [];
  session.on('log', entry => { if (entry.level === 'warn') warns.push(entry.msg); });
  await session.start();
  assert.equal(session.status, 'daily-limit', 'phiên cũ không tự chạy lại');
  assert.equal(warns.some(msg => msg.includes('trùng lặp')), true);
});

// 10. Stale scheduled session self-recovers (điều kiện khôi phục).
test('lịch hẹn quá hạn không có chủ tài khoản được coi là mắc kẹt để tự khôi phục', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const stale = fakeScheduledSession('stale', { status: 'next-day', nextRunTime: past });
  assert.equal(isStaleScheduledSession(stale), true);
  assert.equal(isStaleScheduledSession(stale, { hasLiveOwner: true }), false, 'còn chủ tài khoản thì không khôi phục');
  assert.equal(isStaleScheduledSession(stale, { now: Date.now() - 120_000 }), false, 'chưa tới hạn thì không khôi phục');

  const future = fakeScheduledSession('future', { status: 'daily-limit', nextRunTime: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(isStaleScheduledSession(future), false);

  const noTime = fakeScheduledSession('no-time', { status: 'daily-limit', nextRunTime: null });
  assert.equal(isStaleScheduledSession(noTime), false);
});

test('khôi phục lịch quá hạn tạo đúng một phiên mới và xoá timer cũ', () => {
  const registry = new AutoCourseRegistry();
  const stale = fakeScheduledSession('stale2', { status: 'daily-limit', nextRunTime: new Date(Date.now() - 1).toISOString() });
  registry.adopt(stale);
  let timerCleared = false;
  const originalClear = registry.clearTimer.bind(registry);
  registry.clearTimer = (id) => { timerCleared = true; return originalClear(id); };
  let created = 0;
  const fresh = restartScheduledSession(registry, 'stale2', {
    createFreshSession: (previous) => {
      created++;
      const next = fakeScheduledSession(previous.id, { status: 'idle', phase: 'new' });
      registry.adopt(next);
      return next;
    },
    startSession: () => {},
  });
  assert.equal(timerCleared, true);
  assert.equal(created, 1);
  assert.equal(registry.get('stale2'), fresh);
});

// 11. Manual Stop prevents recovery/resurrection.
test('phiên đã bấm Dừng không bao giờ được tự khôi phục', () => {
  const stopped = fakeScheduledSession('stopped', {
    status: 'stopped',
    nextRunTime: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal(isStaleScheduledSession(stopped), false);
  assert.equal(canRestartScheduledSession(stopped), false);

  const registry = new AutoCourseRegistry();
  registry.adopt(stopped);
  let created = 0;
  const fresh = restartScheduledSession(registry, 'stopped', {
    createFreshSession: () => { created++; return {}; },
    startSession: () => {},
  });
  assert.equal(fresh, null);
  assert.equal(created, 0);
});

// 12. Surplus state persists correctly across next-day restart.
test('surplus state sống sót qua khôi phục next-day restart', () => {
  const source = new AutoCourseSession(
    'surplus-src',
    { name: 'S', email: 's@x.vn' },
    [{ courseUrl: 'https://x/slides/course-1', targetMinutes: 1 }],
    { dailyMaxMinutes: 480, surplusMode: true, surplusTargetMinutes: 42, surplusStudiedMinutes: 17, surplusEligibleCourses: ['a', 'a', 'b'] },
  );
  source.dailyStudiedMinutes = 200;
  source.dailyDate = '2026-09-16';
  source.courseProgress = { 'https://x/slides/course-1': { completed: true, websiteCourseCompleted: true } };

  const restored = new AutoCourseSession(
    'surplus-dst',
    { name: 'S', email: 's@x.vn' },
    [{ courseUrl: 'https://x/slides/course-1', targetMinutes: 1 }],
    { dailyMaxMinutes: 480 },
  );
  applyAutoScanRestoreState(restored, {
    dailyStudiedMinutes: source.dailyStudiedMinutes,
    dailyDate: source.dailyDate,
    courseProgress: source.courseProgress,
    surplusMode: source.surplusMode,
    surplusTargetMinutes: source.surplusTargetMinutes,
    surplusStudiedMinutes: source.surplusStudiedMinutes,
    surplusEligibleCourses: source.surplusEligibleCourses,
    surplusExhausted: source.surplusExhausted,
  });

  assert.equal(restored.surplusMode, true);
  assert.equal(restored.surplusTargetMinutes, 42, 'mục tiêu RNG không bị đổi/regenerate');
  assert.equal(restored.surplusStudiedMinutes, 17);
  assert.deepEqual(restored.surplusEligibleCourses, ['a', 'b'], 'loại tài khoản/khóa trùng');
  assert.equal(restored.surplusExhausted, false);
  assert.equal(restored.dailyStudiedMinutes, 200);
  assert.equal(restored.dailyDate, '2026-09-16');

  // Sang ngày mới chỉ reset bộ đếm ngày, KHÔNG đụng surplus.
  restored.dailyDate = '2000-01-01';
  restored._rolloverDailyCounter();
  assert.equal(restored.dailyStudiedMinutes, 0);
  assert.equal(restored.surplusTargetMinutes, 42);
  assert.equal(restored.surplusStudiedMinutes, 17);
  assert.equal(restored.surplusMode, true);
});

test('surplus exhaustion sống sót qua khôi phục restart', () => {
  const restored = new AutoCourseSession('exhausted-restore', { name: 'E', email: 'e@x.vn' }, []);
  applyAutoScanRestoreState(restored, {
    surplusMode: false,
    surplusTargetMinutes: 60,
    surplusStudiedMinutes: 31,
    surplusExhausted: true,
  });
  assert.equal(restored.surplusExhausted, true);
  assert.equal(restored.surplusMode, false);
  assert.equal(restored.surplusTargetMinutes, 60);
  assert.equal(restored.surplusStudiedMinutes, 31);
});

test('applyAutoScanRestoreState kẹp mục tiêu surplus trong 15-60 phút', () => {
  const session = new AutoCourseSession('clamp', { name: 'C', email: 'c@x.vn' }, []);
  applyAutoScanRestoreState(session, { surplusTargetMinutes: 5 });
  assert.equal(session.surplusTargetMinutes, 15);
  applyAutoScanRestoreState(session, { surplusTargetMinutes: 999 });
  assert.equal(session.surplusTargetMinutes, 60);
});
