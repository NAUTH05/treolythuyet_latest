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

test('surplus gate ignores local target completion without website course-level completion', () => {
  const courses = [
    { courseUrl: 'https://x/slides/course-1', targetMinutes: 1 },
    { courseUrl: 'https://x/slides/course-2', targetMinutes: 1 },
  ];
  const session = new AutoCourseSession('gate', { name: 'Gate' }, courses);
  session.courseProgress = {
    [courses[0].courseUrl]: { completed: true, websiteCourseCompleted: true },
    [courses[1].courseUrl]: { completed: true, websiteCourseCompleted: false },
  };
  assert.equal(session._allConfiguredCoursesCompleted(), true);
  assert.equal(session._allConfiguredCoursesWebsiteCompleted(), false);
});

test('surplus target is generated once and remains within 15-60 minutes', () => {
  const session = new AutoCourseSession('surplus-target', { name: 'Target' });
  session._randomBetween = () => 37;
  assert.equal(session._generateSurplusTargetOnce(), 37);
  session._randomBetween = () => 15;
  assert.equal(session._generateSurplusTargetOnce(), 37);
  assert.equal(session.getStatus().surplusTargetMinutes, 37);
});

test('surplus initialization builds an eligible pool dynamically and preserves target', async () => {
  const courses = [
    { courseUrl: 'https://x/slides/course-1', targetMinutes: 1 },
    { courseUrl: 'https://x/slides/course-2', targetMinutes: 1 },
    { courseUrl: 'https://x/slides/course-3', targetMinutes: 1 },
  ];
  const session = new AutoCourseSession('surplus-init', { name: 'Init' }, courses);
  session.context = {};
  session._verifyAllConfiguredCoursesCompleted = async () => true;
  session._scanCourseDetailsForCheckpoint = async (url) => ({
    courseLevelCompleted: url !== courses[1].courseUrl,
    courseTitle: url,
    allLessons: url === courses[1].courseUrl ? [] : [{ title: 'Lesson', url: `${url}/lesson-1` }],
  });
  session.surplusTargetMinutes = 47;
  assert.equal(await session._initializeSurplusMode(), true);
  assert.equal(session.surplusMode, true);
  assert.deepEqual(session.surplusEligibleCourses, [courses[0].courseUrl, courses[2].courseUrl]);
  assert.equal(session.surplusTargetMinutes, 47);
});

test('surplus initialization exhausts cleanly when all completed courses have no lessons', async () => {
  const courseUrl = 'https://x/slides/course-1';
  const session = new AutoCourseSession('surplus-empty', { name: 'Empty' }, [{ courseUrl }]);
  session.context = {};
  session._verifyAllConfiguredCoursesCompleted = async () => true;
  session._scanCourseDetailsForCheckpoint = async () => ({ courseLevelCompleted: true, allLessons: [] });
  assert.equal(await session._initializeSurplusMode(), false);
  assert.equal(session.surplusExhausted, true);
  assert.equal(session.surplusMode, false);
  assert.equal(session.surplusTargetMinutes, null);
});

// ── Surplus hardening: mục tiêu RNG chỉ là mức mong muốn TỐI ĐA ──

function makeSurplusStudySession({ id, courses, lessonsByCourse, lessonMinutesByUrl = new Map(), failingLessonUrls = [] }) {
  const session = new AutoCourseSession(id, { name: id }, courses);
  session.context = {};
  const gotoCounts = new Map();
  const studyCallsMs = [];
  let currentUrl = 'about:blank';

  session._verifyAllConfiguredCoursesCompleted = async () => true;
  // Checkpoint rescan luôn trả về ĐẦY ĐỦ danh sách bài — buộc engine phải tự
  // lọc bớt bài đã học/bỏ được, nếu không sẽ treo lặp cùng một bài.
  session._scanCourseDetailsForCheckpoint = async (url) => ({
    courseLevelCompleted: true,
    courseTitle: url,
    allLessons: (lessonsByCourse.get(url) || []).map(lesson => ({ ...lesson })),
  });
  session._fakeVisibilityAPI = async () => {};
  session._waitForActiveStudyTime = async (ms) => {
    studyCallsMs.push(ms);
    return ms;
  };
  session._randomBetween = (min) => min;
  session.page = {
    url: () => currentUrl,
    goto: async (url) => {
      gotoCounts.set(url, (gotoCounts.get(url) || 0) + 1);
      if (failingLessonUrls.includes(url)) {
        currentUrl = 'about:blank';
        throw new Error('net::ERR_CONNECTION_REFUSED');
      }
      currentUrl = url;
    },
    waitForTimeout: async () => {},
    reload: async () => {},
    evaluate: async () => {
      const minutes = lessonMinutesByUrl.get(currentUrl);
      return minutes != null
        ? { hours: 0, minutes, seconds: 0, totalMinutes: minutes, source: 'test' }
        : null;
    },
  };

  return { session, gotoCounts, studyCallsMs };
}

test('surplus exhaustion keeps real studied minutes, never reopens lessons, never shrinks the target', async () => {
  const courses = [
    { courseUrl: 'https://x/slides/course-a', targetMinutes: 1 },
    { courseUrl: 'https://x/slides/course-b', targetMinutes: 1 },
    { courseUrl: 'https://x/slides/course-c', targetMinutes: 1 },
  ];
  const lessonsByCourse = new Map([
    [courses[0].courseUrl, [{ title: 'A1', url: 'https://x/slides/slide/course-a/lesson-a1-101' }]],
    [courses[1].courseUrl, [{ title: 'B1', url: 'https://x/slides/slide/course-b/lesson-b1-201' }]],
    [courses[2].courseUrl, [{ title: 'C1', url: 'https://x/slides/slide/course-c/lesson-c1-301' }]],
  ]);
  const lessonMinutesByUrl = new Map([
    ['https://x/slides/slide/course-a/lesson-a1-101', 10],
    ['https://x/slides/slide/course-b/lesson-b1-201', 8],
    ['https://x/slides/slide/course-c/lesson-c1-301', 13],
  ]);
  const { session, gotoCounts } = makeSurplusStudySession({ id: 'surplus-exhaust', courses, lessonsByCourse, lessonMinutesByUrl });
  session.surplusTargetMinutes = 52;

  assert.equal(await session._initializeSurplusMode(), true);
  assert.equal(await session._runSurplusStudy(), false);

  assert.equal(session.surplusExhausted, true, 'no studyable lessons remain → exhausted');
  assert.equal(session.surplusMode, false);
  assert.equal(session.surplusStudiedMinutes, 31, 'keeps the real 31 studied minutes — never reports 52/52');
  assert.equal(session.surplusTargetMinutes, 52, 'the RNG target is never regenerated or shrunk');
  for (const [url] of lessonMinutesByUrl) {
    assert.equal(gotoCounts.get(url), 1, `lesson ${url} must be opened exactly once`);
  }
  assert.equal(await session._finalizeSurplusCompletion(), true, 'exhaustion completes exactly like reaching the target');
  assert.equal(session.surplusMode, false);
});

test('surplus stops exactly at the RNG target without finishing the current lesson', async () => {
  const courses = [
    { courseUrl: 'https://x/slides/course-a', targetMinutes: 1 },
    { courseUrl: 'https://x/slides/course-b', targetMinutes: 1 },
    { courseUrl: 'https://x/slides/course-c', targetMinutes: 1 },
  ];
  const lessonsByCourse = new Map([
    [courses[0].courseUrl, [{ title: 'A1', url: 'https://x/slides/slide/course-a/lesson-a1-101' }]],
    [courses[1].courseUrl, [{ title: 'B1', url: 'https://x/slides/slide/course-b/lesson-b1-201' }]],
    [courses[2].courseUrl, [{ title: 'C1', url: 'https://x/slides/slide/course-c/lesson-c1-301' }]],
  ]);
  const lessonMinutesByUrl = new Map([
    ['https://x/slides/slide/course-a/lesson-a1-101', 25],
    ['https://x/slides/slide/course-b/lesson-b1-201', 20],
    ['https://x/slides/slide/course-c/lesson-c1-301', 30],
  ]);
  const { session, gotoCounts, studyCallsMs } = makeSurplusStudySession({ id: 'surplus-exact-stop', courses, lessonsByCourse, lessonMinutesByUrl });
  session.surplusTargetMinutes = 50;

  assert.equal(await session._initializeSurplusMode(), true);
  assert.equal(await session._runSurplusStudy(), true);

  assert.equal(session.surplusStudiedMinutes, 50, 'studies exactly 25 + 20 + 5 = 50 minutes');
  assert.equal(session.surplusExhausted, false, 'enough lesson time exists → no exhaustion');
  assert.equal(session.surplusMode, false);
  assert.deepEqual(
    studyCallsMs,
    [25 * 60 * 1000, 20 * 60 * 1000, 5 * 60 * 1000],
    'the last lesson is studied for only the 5 remaining minutes, not its full 30'
  );
  for (const [url] of lessonMinutesByUrl) {
    assert.equal(gotoCounts.get(url), 1, `lesson ${url} must be opened exactly once`);
  }
  assert.equal(await session._finalizeSurplusCompletion(), true);
});

test('surplus lessons that cannot open are marked unusable once and exhaust cleanly', async () => {
  const courseUrl = 'https://x/slides/course-a';
  const url1 = 'https://x/slides/slide/course-a/lesson-a1-101';
  const url2 = 'https://x/slides/slide/course-a/lesson-a2-102';
  const { session, gotoCounts } = makeSurplusStudySession({
    id: 'surplus-unusable',
    courses: [{ courseUrl, targetMinutes: 1 }],
    lessonsByCourse: new Map([[courseUrl, [{ title: 'A1', url: url1 }, { title: 'A2', url: url2 }]]]),
    failingLessonUrls: [url1, url2],
  });
  session.surplusTargetMinutes = 20;

  assert.equal(await session._initializeSurplusMode(), true);
  assert.equal(await session._runSurplusStudy(), false);

  assert.equal(session.surplusExhausted, true);
  assert.equal(session.surplusMode, false);
  assert.equal(session.surplusStudiedMinutes, 0, 'nothing was studyable — real number stays 0');
  assert.equal(session.surplusTargetMinutes, 20);
  assert.equal(session._surplusUnusableLessons.size, 2);
  assert.equal(gotoCounts.get(url1), 1, 'an unusable lesson must never be retried');
  assert.equal(gotoCounts.get(url2), 1, 'an unusable lesson must never be retried');
  assert.equal(await session._finalizeSurplusCompletion(), true);
});

test('exhausted surplus defers completion on failed verification without re-entering surplus', async () => {
  const session = new AutoCourseSession('surplus-defer-exhausted', { name: 'Defer' });
  session.surplusTargetMinutes = 40;
  session.surplusStudiedMinutes = 31;
  session.surplusExhausted = true;
  session.surplusMode = false;
  session._verifyAllConfiguredCoursesCompleted = async () => false;

  assert.equal(await session._finalizeSurplusCompletion(), false);
  assert.equal(session.surplusMode, false, 'an exhausted session must not re-enter surplus mode');
  assert.equal(session.surplusStudiedMinutes, 31, 'real studied minutes survive the deferral');
});

test('target-reached surplus defers completion by re-arming surplus mode', async () => {
  const session = new AutoCourseSession('surplus-defer-target', { name: 'Defer' });
  session.surplusTargetMinutes = 40;
  session.surplusStudiedMinutes = 40;
  session._verifyAllConfiguredCoursesCompleted = async () => false;

  assert.equal(await session._finalizeSurplusCompletion(), false);
  assert.equal(session.surplusMode, true);
});
