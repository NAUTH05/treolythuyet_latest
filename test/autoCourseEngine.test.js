const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AutoCourseSession,
  courseReachedTarget,
  createCourseFinalizationPlan,
  getCourseTargetRemainingMs,
  POST_TARGET_GRACE_MINUTES,
  COURSE_FINALIZATION_STATES,
  isAutoCourseAccountBlockingStatus,
  getPersistentAutoCourseOptions,
  AUTO_COURSE_STATUSES,
  TERMINAL_STATUSES,
  SCHEDULED_STATUSES,
} = require('../autoCourseEngine');
const { extractSlideIdFromUrl, getNextShiftStart } = require('../courseScanner');

test('không hoàn thành khóa chỉ vì mọi bài hiển thị 100% khi chưa đủ giờ mục tiêu', () => {
  assert.equal(courseReachedTarget(63 * 60, 51 * 60 + 8, true), false);
});

test('hoàn thành khóa khi thời gian tích lũy đã đạt mục tiêu', () => {
  assert.equal(courseReachedTarget(14 * 60, 14 * 60, false), true);
});

test('khóa không cấu hình mục tiêu dùng trạng thái hoàn thành của bài học', () => {
  assert.equal(courseReachedTarget(0, 0, true), true);
  assert.equal(courseReachedTarget(0, 0, false), false);
});

test('course finalization finishes lessons with at most five minutes remaining', () => {
  const oneMinute = createCourseFinalizationPlan(null, 60 * 1000, 10 * 60 * 1000);
  const fiveMinutes = createCourseFinalizationPlan(null, 5 * 60 * 1000, 10 * 60 * 1000);
  const exactEnd = createCourseFinalizationPlan(null, 0, 10 * 60 * 1000);

  assert.equal(oneMinute.mode, 'finish-current-lesson');
  assert.equal(oneMinute.allowanceMs, 60 * 1000);
  assert.equal(fiveMinutes.mode, 'finish-current-lesson');
  assert.equal(fiveMinutes.allowanceMs, POST_TARGET_GRACE_MINUTES * 60 * 1000);
  assert.equal(exactEnd.allowanceMs, 0);
});

test('post-target grace period is a hard one-shot five-minute maximum', () => {
  const enteredAtMs = 30 * 60 * 1000;
  const plan = createCourseFinalizationPlan(null, 40 * 60 * 1000, enteredAtMs);
  const attemptedRepeat = createCourseFinalizationPlan(plan, 35 * 60 * 1000, plan.deadlineElapsedMs);

  assert.equal(plan.mode, 'grace-period');
  assert.equal(plan.allowanceMs, 5 * 60 * 1000);
  assert.equal(plan.deadlineElapsedMs, enteredAtMs + 5 * 60 * 1000);
  assert.strictEqual(attemptedRepeat, plan, 're-entering finalization must not create another grace window');
});

test('mid-lesson target boundary is reached before a checkpoint-gated grace allowance', () => {
  const studiedMs = 750 * 60 * 1000;
  const requiredMs = getCourseTargetRemainingMs(756, studiedMs);
  const afterTarget = createCourseFinalizationPlan(null, 54 * 60 * 1000, requiredMs);

  assert.equal(requiredMs, 6 * 60 * 1000, 'study exactly the six minutes still required');
  assert.equal(afterTarget.allowanceMs, 5 * 60 * 1000, 'only a below-target checkpoint may then use the bounded grace period');
});

test('course checkpoint refreshes before re-scan and trusts refreshed Web Odoo progress', async () => {
  const session = new AutoCourseSession('test', { name: 'Test' });
  const courseUrl = 'https://x/slides/course-1';
  const events = [];
  session.courseProgress[courseUrl] = {
    title: 'Course 1',
    targetMinutes: 756,
    studiedMinutes: 761,
    completed: false,
    finalizationState: COURSE_FINALIZATION_STATES.TARGET_REACHED,
  };
  session._activeCourseRunId = 7;
  session.page = {
    reload: async () => { events.push('reload'); },
    waitForTimeout: async () => { events.push('stabilize'); },
  };
  session._fakeVisibilityAPI = async () => {};
  session._scanCourseDetailsForCheckpoint = async () => {
    events.push('scan');
    return {
      courseTitle: 'Course 1',
      actualStudiedMinutes: 756,
      totalLessons: 3,
      uncompletedLessons: [{ progressPercent: 90 }],
      allLessons: [],
    };
  };

  const result = await session._checkpointAndVerifyCourse({
    courseUrl,
    targetMinutes: 756,
    courseTitle: 'Course 1',
    courseRunId: 7,
  });

  assert.equal(result.confirmed, true);
  assert.deepEqual(events, ['reload', 'stabilize', 'scan']);
  assert.equal(session.courseProgress[courseUrl].studiedMinutes, 756);
  assert.equal(session.courseProgress[courseUrl].completed, true);
  assert.equal(session.courseProgress[courseUrl].finalizationState, COURSE_FINALIZATION_STATES.COMPLETED);
});

test('final checkpoint below target never resumes the old course or marks it complete locally', async () => {
  const session = new AutoCourseSession('test', { name: 'Test' });
  const courseUrl = 'https://x/slides/course-1';
  session.courseProgress[courseUrl] = {
    title: 'Course 1',
    targetMinutes: 756,
    studiedMinutes: 761,
    completed: false,
    finalizationState: COURSE_FINALIZATION_STATES.TARGET_REACHED,
  };
  session._activeCourseRunId = 9;
  session.page = {
    reload: async () => {},
    waitForTimeout: async () => {},
  };
  session._fakeVisibilityAPI = async () => {};
  session._scanCourseDetailsForCheckpoint = async () => ({
    courseTitle: 'Course 1',
    actualStudiedMinutes: 755,
    totalLessons: 3,
    uncompletedLessons: [{ progressPercent: 90 }],
    allLessons: [],
  });

  const result = await session._checkpointAndVerifyCourse({
    courseUrl,
    targetMinutes: 756,
    courseTitle: 'Course 1',
    courseRunId: 9,
  });

  assert.equal(result.confirmed, false);
  assert.equal(session.courseProgress[courseUrl].studiedMinutes, 755);
  assert.equal(session.courseProgress[courseUrl].completed, false);
  assert.equal(session.courseProgress[courseUrl].finalizationState, COURSE_FINALIZATION_STATES.VERIFICATION_PENDING);
});

test('checkpoint below target can explicitly continue the current lesson', async () => {
  const session = new AutoCourseSession('test', { name: 'Test' });
  const courseUrl = 'https://x/slides/course-1';
  const events = [];
  session.courseProgress[courseUrl] = {
    title: 'Course 1',
    targetMinutes: 756,
    studiedMinutes: 756,
    completed: false,
    finalizationState: COURSE_FINALIZATION_STATES.CHECKPOINT,
  };
  session._activeCourseRunId = 10;
  session.page = {
    reload: async () => { events.push('reload'); },
    waitForTimeout: async () => { events.push('stabilize'); },
  };
  session._fakeVisibilityAPI = async () => {};
  session._scanCourseDetailsForCheckpoint = async () => {
    events.push('scan');
    return {
      courseTitle: 'Course 1',
      actualStudiedMinutes: 755,
      totalLessons: 3,
      uncompletedLessons: [{ progressPercent: 90 }],
      allLessons: [],
    };
  };

  const result = await session._checkpointAndVerifyCourse({
    courseUrl,
    targetMinutes: 756,
    courseTitle: 'Course 1',
    courseRunId: 10,
    preserveCurrentPage: true,
    continueStudying: true,
  });

  assert.equal(result.confirmed, false);
  assert.deepEqual(events, ['reload', 'stabilize', 'scan']);
  assert.equal(session.courseProgress[courseUrl].completed, false);
  assert.equal(session.courseProgress[courseUrl].finalizationState, COURSE_FINALIZATION_STATES.NORMAL_STUDY);
});

test('stale checkpoint callback cannot update a course after switching runs', async () => {
  const session = new AutoCourseSession('test', { name: 'Test' });
  const courseUrl = 'https://x/slides/course-1';
  let scanned = false;
  session.courseProgress[courseUrl] = {
    targetMinutes: 60,
    studiedMinutes: 60,
    completed: false,
    finalizationState: COURSE_FINALIZATION_STATES.TARGET_REACHED,
  };
  session._activeCourseRunId = 11;
  session.page = {
    reload: async () => {},
    waitForTimeout: async () => { session._activeCourseRunId = 12; },
  };
  session._fakeVisibilityAPI = async () => {};
  session._scanCourseDetailsForCheckpoint = async () => {
    scanned = true;
    return null;
  };

  const result = await session._checkpointAndVerifyCourse({
    courseUrl,
    targetMinutes: 60,
    courseTitle: 'Course 1',
    courseRunId: 11,
  });

  assert.equal(result.stale, true);
  assert.equal(scanned, false);
  assert.equal(session.courseProgress[courseUrl].completed, false);
});

test('không dùng badge hoặc icon check chung của trang để kết luận bài đã xong', async () => {
  const session = new AutoCourseSession('test', { name: 'Test' });
  const queriedSelectors = [];
  session.page = {
    evaluate: async evaluator => {
      global.document = {
        querySelector: selector => {
          queriedSelectors.push(selector);
          return null;
        },
      };
      try {
        return evaluator();
      } finally {
        delete global.document;
      }
    },
  };

  assert.equal(await session._isCurrentLessonCompleted(), false);
  assert.equal(queriedSelectors.some(selector => selector === '.badge' || selector === '.fa-check'), false);
});

test('nhận marker data-completed của đúng slide hiện tại', async () => {
  const session = new AutoCourseSession('test', { name: 'Test' });
  session.page = {
    evaluate: async evaluator => {
      global.document = {
        querySelector: selector => selector.includes('[data-completed]')
          ? { getAttribute: () => 'true' }
          : null,
      };
      try {
        return evaluator();
      } finally {
        delete global.document;
      }
    },
  };

  assert.equal(await session._isCurrentLessonCompleted(), true);
});

test('lấy đúng slide ID là cụm số cuối URL thay vì số trong slug', () => {
  assert.equal(
    extractSlideIdFromUrl('https://hoclythuyetlaixe.eco-tek.com.vn/slides/slide/5-2-khoang-cach-an-toan-giua-hai-xe-50987?fullscreen=0'),
    50987
  );
  assert.equal(
    extractSlideIdFromUrl('/slides/slide/1-1-ac-iem-cua-uong-sa-50990'),
    50990
  );
});

test('xác minh chéo đúng tiến độ của bài từ trang khóa học', async () => {
  const session = new AutoCourseSession('test', { name: 'Test' });
  let verifyPageClosed = false;
  session.context = {
    newPage: async () => ({
      goto: async () => {},
      waitForTimeout: async () => {},
      evaluate: async () => ({
        allLessons: [
          {
            url: 'https://hoclythuyetlaixe.eco-tek.com.vn/slides/slide/5-2-khoang-cach-an-toan-giua-hai-xe-50987?fullscreen=0',
            progressPercent: 100,
          },
        ],
      }),
      close: async () => { verifyPageClosed = true; },
    }),
  };

  const result = await session._verifyLessonProgressFromCourse(
    'https://hoclythuyetlaixe.eco-tek.com.vn/slides/course-988',
    'https://hoclythuyetlaixe.eco-tek.com.vn/slides/slide/5-2-khoang-cach-an-toan-giua-hai-xe-50987'
  );

  assert.deepEqual(result, { completed: true, progressPercent: 100 });
  assert.equal(verifyPageClosed, true);
});

test('paused wall-clock time is not counted as active study time', async () => {
  const session = new AutoCourseSession('test', { name: 'Test' });
  session.status = 'studying';
  const waiting = session._waitForActiveStudyTime(80);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(session.pause(), true);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(session.resume(), true);

  const resumedAt = Date.now();
  const activeMs = await waiting;
  assert.ok(activeMs >= 70, `activeMs=${activeMs}`);
  assert.ok(Date.now() - resumedAt >= 45, 'remaining active time must still be studied after resume');
});

test('next shift never uses today when today is outside allowed dates', () => {
  const from = new Date('2026-08-08T22:00:00.000Z'); // 05:00 09/08 in Vietnam
  const next = getNextShiftStart(
    from,
    [{ dates: '', shifts: '07:00-11:00' }],
    ['10/08/2026'],
    '06:00'
  );
  assert.equal(next.toISOString(), '2026-08-10T00:00:00.000Z');
});

test('a paused auto-course still owns its account session', () => {
  assert.equal(isAutoCourseAccountBlockingStatus('paused'), true);
  assert.equal(isAutoCourseAccountBlockingStatus('stopped'), false);
  assert.equal(isAutoCourseAccountBlockingStatus('completed'), false);
});

test('restart/resume persistence keeps custom date shifts and all scheduling options', () => {
  const options = getPersistentAutoCourseOptions({
    dailyMaxMinutes: 420,
    customTimeRules: [{ dates: '10/08/2026', shifts: '07:00-11:00' }],
    allowedDateRanges: ['10/08/2026'],
    timeWindows: [{ start: '06:30', end: '18:00' }],
    initialDailyMinutesToggle: true,
    initialDailyMinutes: 25,
    initialDailyDate: '2026-08-10',
  });

  assert.deepEqual(options.customTimeRules, [{ dates: '10/08/2026', shifts: '07:00-11:00' }]);
  assert.deepEqual(options.allowedDateRanges, ['10/08/2026']);
  assert.deepEqual(options.timeWindows, [{ start: '06:30', end: '18:00' }]);
  assert.equal(options.initialDailyMinutes, 25);
});

// ============ VÒNG ĐỜI PHIÊN: chống chạy trùng & trạng thái sai ============

// Hôm nay chắc chắn KHÔNG nằm trong danh sách ngày học → start() thoát sớm ở
// nhánh 'date-limit' và không mở Chromium, nên test chạy được offline.
function offDaySession(id = 'test') {
  return new AutoCourseSession(
    id,
    { name: 'Test', email: 't@x.vn' },
    [{ courseUrl: 'https://x/slides/course-1', targetMinutes: 60 }],
    { allowedDateRanges: ['01/01/2000'] }
  );
}

test('một đối tượng phiên chỉ được chạy đúng một lần', async () => {
  const session = offDaySession();
  const warns = [];
  session.on('log', entry => { if (entry.level === 'warn') warns.push(entry.msg); });

  await session.start();
  assert.equal(session.status, 'date-limit');
  assert.equal(session.isFinished(), true);
  assert.equal(session.isRunning(), false);

  await session.start(); // double-click / timer trùng / restore chồng lệnh
  assert.equal(session.status, 'date-limit', 'lần gọi thứ hai không được chạy lại');
  assert.equal(warns.some(msg => msg.includes('trùng lặp')), true, 'phải ghi log từ chối rõ ràng');
});

test('start() bị từ chối khi phiên đang chạy (hai request đồng thời)', async () => {
  const session = offDaySession();
  session._phase = 'running'; // giả lập vòng lặp start() đang chạy dở
  const warns = [];
  session.on('log', entry => { if (entry.level === 'warn') warns.push(entry.msg); });

  await session.start();
  assert.equal(session.status, 'idle', 'không được bắt đầu lần thứ hai');
  assert.equal(warns.some(msg => msg.includes('trùng lặp')), true);
});

test('phiên chưa khởi động không chiếm tài khoản; đang chạy hoặc tạm dừng thì có', () => {
  const session = offDaySession();
  assert.equal(session.ownsAccountSession(), false, 'phiên vừa tạo không chiếm gì cả');

  session._phase = 'running';
  assert.equal(session.ownsAccountSession(), true);

  session.status = 'studying';
  assert.equal(session.pause(), true);
  session._phase = 'finished'; // vòng lặp chết sau server restart, vẫn đang paused
  assert.equal(session.ownsAccountSession(), true, 'phiên tạm dừng vẫn giữ tài khoản');
});

test('tạm dừng trong lúc đang khởi động không bị ghi đè bởi bước đăng nhập', () => {
  const session = offDaySession();
  session._phase = 'running';
  assert.equal(session.pause(), true);
  assert.equal(session.status, 'paused');

  // Engine đi tiếp tới bước đăng nhập / quét khóa trong lúc người dùng đã bấm Tạm dừng
  session._setStatus('logging-in');
  session._setStatus('scanning');
  assert.equal(session.status, 'paused', 'phải giữ nguyên Tạm dừng');
  assert.equal(session.pausedFromStatus, 'scanning', 'ghi nhớ trạng thái sẽ quay lại');

  assert.equal(session.resume(), true);
  assert.equal(session.status, 'scanning');
});

test('phiên đã bị Dừng không thể quay lại chạy hay tự nhận hoàn thành', async () => {
  const session = offDaySession();
  await session.cancel();

  assert.equal(session.status, 'stopped');
  assert.equal(session.isFinished(), true);

  assert.equal(session._setStatus('studying'), false);
  assert.equal(session._setStatus('completed'), false);
  assert.equal(session.status, 'stopped', 'trạng thái kết thúc là chốt cuối');

  // Giới hạn ngày cũng không được hồi sinh phiên đã hủy thành trạng thái hẹn giờ
  session.dailyStudiedMinutes = session.options.dailyMaxMinutes;
  assert.equal(session._hitDailyLimit(), true);
  assert.equal(session.status, 'stopped');
  assert.equal(SCHEDULED_STATUSES.has(session.status), false, 'server không được hẹn giờ chạy lại');
});

test('phiên hết ngày học chỉ hẹn giờ, không tự đánh dấu hoàn thành', async () => {
  const session = offDaySession();
  const statuses = [];
  session.on('status', s => statuses.push(s.status));

  await session.start();

  assert.deepEqual(statuses, ['date-limit']);
  assert.equal(SCHEDULED_STATUSES.has(session.status), true);
  assert.equal(TERMINAL_STATUSES.has(session.status), false);
});

test('danh sách trạng thái chính thức đủ và không chồng lấn', () => {
  for (const status of [...TERMINAL_STATUSES, ...SCHEDULED_STATUSES]) {
    assert.equal(AUTO_COURSE_STATUSES.includes(status), true, `thiếu ${status} trong danh sách chính thức`);
  }
  for (const status of SCHEDULED_STATUSES) {
    assert.equal(TERMINAL_STATUSES.has(status), false, `${status} vừa là hẹn giờ vừa là kết thúc`);
  }
});

function makeLoginPage(outcome, state) {
  return {
    url: () => state.url,
    isClosed: () => state.closed,
    goto: async () => {
      if (outcome === 'navigation-timeout' && !state.gotoAttempted) {
        state.gotoAttempted = true;
        throw new Error('Timeout 60000ms exceeded');
      }
      state.url = 'https://hoclythuyetlaixe.eco-tek.com.vn/web/login';
    },
    waitForSelector: async selector => {
      if (selector === 'input[name="login"]') return {};
      if (selector === '.alert-danger') {
        if (outcome === 'auth-rejected' || outcome === 'generic-alert') return {};
        throw new Error('timeout');
      }
      return {};
    },
    fill: async () => {},
    click: async () => {
      if (outcome === 'success') state.url = 'https://hoclythuyetlaixe.eco-tek.com.vn/web';
      if (outcome === 'delayed-redirect') {
        setTimeout(() => { state.url = 'https://hoclythuyetlaixe.eco-tek.com.vn/web'; }, 2);
      }
    },
    waitForURL: async () => {
      if (outcome === 'success') return 'redirect';
      if (outcome === 'delayed-redirect') {
        await new Promise(resolve => setTimeout(resolve, 5));
        return 'redirect';
      }
      throw new Error('timeout');
    },
    $: async selector => {
      if (selector !== '.alert-danger' || !['auth-rejected', 'generic-alert'].includes(outcome)) return null;
      return {
        isVisible: async () => true,
        textContent: async () => outcome === 'auth-rejected'
          ? 'Sai tên đăng nhập hoặc mật khẩu'
          : 'Internal Server Error',
      };
    },
    waitForTimeout: async ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5))),
    close: async () => { state.closed = true; },
  };
}

function loginSession(outcomes, options = {}) {
  const session = new AutoCourseSession(
    'login-test',
    { name: 'Login Test', email: 'test@example.com', password: 'secret' },
    [],
    {
      loginRetryIntervalMs: 1,
      loginPostSubmitGraceMs: 0,
      loginPostSubmitTimeoutMs: 20,
      loginFormTimeoutMs: 20,
      loginNavigationTimeoutMs: 20,
      ...options,
    },
  );
  const pages = [];
  let index = 1;
  const newPage = async () => {
    const state = { url: 'about:blank', closed: false, gotoAttempted: false };
    const page = makeLoginPage(outcomes[Math.min(index++, outcomes.length - 1)], state);
    pages.push(page);
    return page;
  };
  session.context = { newPage };
  session.page = makeLoginPage(outcomes[0], { url: 'about:blank', closed: false, gotoAttempted: false });
  pages.push(session.page);
  return { session, pages };
}

test('login succeeds immediately after form submission', async () => {
  const { session } = loginSession(['success']);
  assert.equal(await session.login(), true);
  assert.equal(session.page.url().includes('/web/login'), false);
});

test('delayed redirect after submit is accepted during the grace period', async () => {
  const { session } = loginSession(['delayed-redirect'], { loginPostSubmitGraceMs: 10 });
  assert.equal(await session.login(), true);
});

test('staying on login without an auth error retries in the same session and then succeeds', async () => {
  const { session, pages } = loginSession(['transient', 'success']);
  assert.equal(await session.login(), true);
  assert.equal(session.id, 'login-test');
  assert.equal(pages.length, 2, 'recovery recreates only the page, not the Auto-Scan session');
});

test('Auto-Scan start remains alive after the production transient login scenario', async () => {
  const { chromium } = require('playwright');
  const originalLaunch = chromium.launch;
  let launchCount = 0;
  let pageIndex = 0;
  const pages = [];
  chromium.launch = async () => {
    launchCount++;
    return {
      newContext: async () => ({
        newPage: async () => {
          const state = { url: 'about:blank', closed: false, gotoAttempted: false };
          const page = makeLoginPage(['transient', 'success'][Math.min(pageIndex++, 1)], state);
          pages.push(page);
          return page;
        },
      }),
      close: async () => {},
    };
  };
  try {
    const session = new AutoCourseSession(
      'production-regression',
      { name: 'Production Regression', email: 'test@example.com', password: 'secret' },
      [],
      { loginRetryIntervalMs: 1, loginPostSubmitGraceMs: 0, loginPostSubmitTimeoutMs: 20 },
    );
    await session.start();
    assert.equal(session.status, 'completed');
    assert.equal(session.id, 'production-regression');
    assert.equal(launchCount, 1, 'recovery must not launch a duplicate browser/session');
    assert.equal(pages.length, 2, 'recovery may recreate the page within the existing session');
  } finally {
    chromium.launch = originalLaunch;
  }
});

test('multiple transient login failures are retried until success', async () => {
  const { session, pages } = loginSession(['transient', 'transient', 'transient', 'success']);
  assert.equal(await session.login(), true);
  assert.equal(pages.length, 4);
});

test('temporary navigation timeout is recoverable', async () => {
  const { session } = loginSession(['navigation-timeout', 'success']);
  assert.equal(await session.login(), true);
});

test('stopping while waiting for a login retry exits promptly', async () => {
  const { session } = loginSession(['transient'], { loginRetryIntervalMs: 1000 });
  const pending = session.login();
  setTimeout(() => { session._stopped = true; }, 5);
  assert.equal(await pending, false);
});

test('explicit server authentication rejection remains non-retryable and distinguishable', async () => {
  const { session } = loginSession(['auth-rejected']);
  await assert.rejects(session.login(), err => {
    assert.equal(err.code, 'AUTHENTICATION_REJECTED');
    assert.match(err.message, /Sai tên đăng nhập/);
    return true;
  });
});

test('generic alert-danger remains retryable when it does not describe authentication rejection', async () => {
  const { session } = loginSession(['generic-alert', 'success']);
  assert.equal(await session.login(), true);
});
