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
  PHASE_RUNNING,
  PHASE_FINISHED,
} = require('../autoCourseEngine');
const { extractSlideIdFromUrl, getNextShiftStart } = require('../courseScanner');

// Giả lập kết quả auto-discovery từ /slides/all?my=1 cho unit test. Cập nhật
// discoveredCourses/coursesConfig/_discoveryValid giống _discoverCourses() thật.
function installDiscovery(session, courses, { completed = true } = {}) {
  const apply = () => {
    const normalized = courses.map((c, index) => {
      const isCompleted = typeof c.completed === 'boolean' ? c.completed : completed;
      return {
        courseUrl: c.courseUrl,
        title: c.title || c.courseUrl,
        orderIndex: index,
        completed: isCompleted,
        completionState: isCompleted ? 'completed' : 'incomplete',
        progressPercent: isCompleted ? 100 : (c.progressPercent ?? null),
        recordedMinutes: null,
        discoveredAt: '2026-01-01T00:00:00.000Z',
        source: 'test-discovery',
      };
    });
    session.discoveredCourses = normalized;
    session.coursesConfig = normalized.map(c => ({
      courseUrl: c.courseUrl,
      title: c.title,
      orderIndex: c.orderIndex,
      targetHours: 0,
      targetMinutes: 0,
    }));
    session._discoveryValid = true;
    for (const c of normalized) {
      session.courseProgress[c.courseUrl] = {
        ...(session.courseProgress[c.courseUrl] || {}),
        title: c.title,
        websiteCourseCompleted: c.completed,
        websiteCourseCompletionState: c.completionState,
      };
    }
    return normalized;
  };
  apply();
  session._discoverCourses = async () => apply();
  return session;
}

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
  session._phase = PHASE_RUNNING;
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
  session._phase = PHASE_RUNNING;
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
  session._phase = PHASE_RUNNING;
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
  session._phase = PHASE_RUNNING;
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
  session._phase = PHASE_RUNNING;
  session.status = 'studying';
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
    installDiscovery(session, [{ courseUrl: '/slides/course-1', title: 'Course 1', completed: true }]);
    await session.start();
    assert.equal(session.status, 'completed');
    assert.equal(session.id, 'production-regression');
    assert.equal(launchCount, 1, 'recovery must not launch a duplicate browser/session');
    assert.ok(pages.length >= 2, 'recovery may recreate the page within the existing session (discovery adds pages too)');
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

// ── SURPLUS MỚI: tuần tự theo khóa, mục tiêu RNG mỗi khóa, xác minh website ──

// Mô phỏng website: mỗi khóa có tổng phút + danh sách bài với progressPercent.
// Học một block sẽ tăng progress bài và tổng phút khóa (trừ khi confirmOnStudy=false).
function makeSurplusSession({
  id,
  courses,
  website,
  failingLessonUrls = [],
  confirmOnStudy = true,
  rngSequence = null,
  dailyMaxMinutes = 480,
  progressPerMinute = 4,
  surplusStrategy = 'legacy-random',
  extraOptions = {},
}) {
  const session = new AutoCourseSession(id, { name: id }, courses, {
    dailyMaxMinutes,
    // Các test này kiểm tra cơ chế RNG legacy (15-60) một cách tường minh, vì
    // default production giờ là phân bổ theo năng lực lịch còn lại.
    surplusStrategy,
    ...extraOptions,
  });
  session._phase = PHASE_RUNNING;
  session.context = {};
  session._fakeVisibilityAPI = async () => {};
  const gotoCounts = new Map();
  const studyCallsMs = [];
  const studyOrder = [];
  let currentLessonUrl = null;
  let rngIndex = 0;

  const courseOfLesson = (url) => Object.keys(website).find(cu => (website[cu].lessons || []).some(l => l.url === url));
  const snapshot = (courseUrl) => {
    const course = website[courseUrl];
    if (!course) return null;
    return {
      courseTitle: course.title || courseUrl,
      actualStudiedMinutes: Math.round(course.minutes * 1000) / 1000,
      courseCompletionState: 'completed',
      courseLevelCompleted: true,
      courseCompletionSource: 'test-fixture',
      totalLessons: course.lessons.length,
      allLessons: course.lessons.map(l => ({ ...l, isCompleted: l.progressPercent >= 100 })),
      uncompletedLessons: course.lessons.filter(l => l.progressPercent < 100).map(l => ({ ...l, isCompleted: false })),
    };
  };

  session._scanCourseDetailsForCheckpoint = async (courseUrl) => snapshot(courseUrl);
  session._randomBetween = (min) => {
    if (rngSequence && rngSequence.length > 0) {
      const value = rngSequence[Math.min(rngIndex++, rngSequence.length - 1)];
      return value;
    }
    return min;
  };
  session._waitForActiveStudyTime = async (ms) => {
    studyCallsMs.push(ms);
    if (currentLessonUrl) studyOrder.push(currentLessonUrl);
    if (confirmOnStudy && currentLessonUrl) {
      const courseUrl = courseOfLesson(currentLessonUrl);
      if (courseUrl) {
        const course = website[courseUrl];
        const lesson = course.lessons.find(l => l.url === currentLessonUrl);
        if (lesson) {
          const addMinutes = ms / 60000;
          course.minutes += addMinutes;
          lesson.progressPercent = Math.min(100, lesson.progressPercent + addMinutes * progressPerMinute);
        }
      }
    }
    return ms;
  };
  session.page = {
    url: () => currentLessonUrl || 'about:blank',
    goto: async (url) => {
      gotoCounts.set(url, (gotoCounts.get(url) || 0) + 1);
      if (failingLessonUrls.includes(url)) throw new Error('net::ERR_CONNECTION_REFUSED');
      currentLessonUrl = url;
    },
    waitForTimeout: async () => {},
    reload: async () => {},
    evaluate: async () => null,
    $: async () => null,
  };

  // Surplus chỉ chạy khi mọi khóa đã Completed → discovery mặc định completed.
  installDiscovery(session, courses);

  return { session, gotoCounts, studyCallsMs, studyOrder, website };
}

function makeWebsite(courses, { minutes = 60, lessons } = {}) {
  const website = {};
  for (const c of courses) {
    website[c.courseUrl] = {
      title: c.courseUrl,
      minutes,
      lessons: lessons || [{ title: 'Lesson 1', url: `${c.courseUrl}/lesson-1`, progressPercent: 0 }],
    };
  }
  return website;
}

test('surplus target per-course is generated once and stays within 15-60 minutes', () => {
  const c1 = 'https://x/slides/course-1';
  const session = new AutoCourseSession('surplus-target', { name: 'Target' }, [{ courseUrl: c1 }]);
  const state = session._surplusStateFor(c1);
  session._randomBetween = () => 37;
  assert.equal(session._surplusTargetFor(state), 37);
  session._randomBetween = () => 60;
  assert.equal(session._surplusTargetFor(state), 37, 'không regenerate');
  assert.ok(state.targetMinutes >= 15 && state.targetMinutes <= 60);
});

test('surplus pass xử lý khóa TUẦN TỰ theo coursesConfig, không chọn ngẫu nhiên', async () => {
  const courses = [
    { courseUrl: 'https://x/slides/course-1', targetMinutes: 30 },
    { courseUrl: 'https://x/slides/course-2', targetMinutes: 30 },
    { courseUrl: 'https://x/slides/course-3', targetMinutes: 30 },
  ];
  const { session, studyOrder } = makeSurplusSession({
    id: 'surplus-seq',
    courses,
    website: makeWebsite(courses),
    rngSequence: [15, 15, 15],
  });
  assert.equal(await session._initializeSurplusMode(), true);
  assert.equal(await session._runSurplusStudy(), true);

  const courseOf = (lessonUrl) => courses.find(c => lessonUrl.startsWith(c.courseUrl)).courseUrl;
  const order = [...new Set(studyOrder.map(courseOf))];
  assert.deepEqual(order, [courses[0].courseUrl, courses[1].courseUrl, courses[2].courseUrl], 'đúng thứ tự 1 → 2 → 3');
  assert.equal(session.surplusCurrentCourseIndex, 3);
});

test('mỗi khóa nhận mục tiêu RNG riêng, sinh một lần và persist', async () => {
  const courses = [
    { courseUrl: 'https://x/slides/course-1', targetMinutes: 30 },
    { courseUrl: 'https://x/slides/course-2', targetMinutes: 30 },
  ];
  const { session } = makeSurplusSession({
    id: 'surplus-rng',
    courses,
    website: makeWebsite(courses),
    rngSequence: [18, 27],
  });
  assert.equal(await session._initializeSurplusMode(), true);
  await session._runSurplusStudy();

  assert.equal(session.surplusCourseStates[courses[0].courseUrl].targetMinutes, 18);
  assert.equal(session.surplusCourseStates[courses[1].courseUrl].targetMinutes, 27);
});

test('khóa completed cấp khóa với bài 0%/70% vẫn surplus-eligible; bài 100% bị bỏ qua', async () => {
  const c1 = 'https://x/slides/course-1';
  const website = {
    [c1]: {
      title: 'Course 1',
      minutes: 60,
      lessons: [
        { title: 'L0', url: `${c1}/l0`, progressPercent: 0 },
        { title: 'L70', url: `${c1}/l70`, progressPercent: 70 },
        { title: 'L100', url: `${c1}/l100`, progressPercent: 100 },
      ],
    },
  };
  const { session, gotoCounts } = makeSurplusSession({
    id: 'surplus-eligible',
    courses: [{ courseUrl: c1, targetMinutes: 60 }],
    website,
    rngSequence: [15],
  });
  await session._initializeSurplusMode();
  await session._runSurplusStudy();

  assert.equal(session.surplusCourseStates[c1].confirmedMinutes, 15);
  assert.equal(gotoCounts.get(`${c1}/l100`) || 0, 0, 'bài 100% không bao giờ được chọn');
  assert.ok((gotoCounts.get(`${c1}/l0`) || 0) + (gotoCounts.get(`${c1}/l70`) || 0) > 0);
});

test('local wait KHÔNG thay đổi website thì KHÔNG được credit là surplus thành công', async () => {
  const c1 = 'https://x/slides/course-1';
  const website = { [c1]: { title: 'C1', minutes: 60, lessons: [{ title: 'L', url: `${c1}/l1`, progressPercent: 0 }] } };
  const { session } = makeSurplusSession({
    id: 'surplus-noconfirm',
    courses: [{ courseUrl: c1, targetMinutes: 60 }],
    website,
    rngSequence: [15],
    confirmOnStudy: false,
  });
  await session._initializeSurplusMode();
  await session._runSurplusStudy();

  const state = session.surplusCourseStates[c1];
  assert.equal(state.confirmedMinutes, 0, 'không credit');
  assert.ok(state.localActiveMinutes > 0, 'vẫn ghi nhận local active (chưa xác nhận)');
  assert.equal(state.exhausted, true, 'bài bị đánh dấu unusable sau số lần tối đa → khóa kiệt khẩu');
  assert.deepEqual(state.unusableLessons, [`${c1}/l1`]);
});

test('lesson progress tăng xác nhận surplus dù thời gian khóa bị capped', async () => {
  const c1 = 'https://x/slides/course-1';
  const website = { [c1]: { title: 'C1', minutes: 60, lessons: [{ title: 'L', url: `${c1}/l1`, progressPercent: 70 }] } };
  const { session } = makeSurplusSession({
    id: 'surplus-lesson-confirm',
    courses: [{ courseUrl: c1, targetMinutes: 60 }],
    website,
    rngSequence: [15],
  });
  // Tổng thời gian khóa đứng yên, chỉ tiến độ bài tăng.
  session._waitForActiveStudyTime = async (ms) => {
    website[c1].lessons[0].progressPercent = Math.min(100, website[c1].lessons[0].progressPercent + 5);
    return ms;
  };
  await session._initializeSurplusMode();
  await session._runSurplusStudy();

  const state = session.surplusCourseStates[c1];
  assert.ok(state.confirmedMinutes > 0, 'xác nhận qua tiến độ bài');
  assert.equal(state.verifiedMinutes, 60, 'thời gian khóa vẫn capped ở 60');
});

test('_classifySurplusProgress: thời gian khóa tăng HOẶC tiến độ bài tăng đều xác nhận', () => {
  const session = new AutoCourseSession('classify', { name: 'C' });
  const before = { courseMinutes: 60, lessonPercent: 70, lessonCompleted: false };
  assert.equal(session._classifySurplusProgress(before, { courseMinutes: 65, lessonPercent: 70, lessonCompleted: false }, 5).confirmed, true);
  assert.equal(session._classifySurplusProgress(before, { courseMinutes: 60, lessonPercent: 80, lessonCompleted: false }, 5).via, 'lesson_progress');
  assert.equal(session._classifySurplusProgress(before, { courseMinutes: 60, lessonPercent: 70, lessonCompleted: false }, 5).confirmed, false);
});

test('block cuối chỉ học đúng phần còn thiếu', async () => {
  const c1 = 'https://x/slides/course-1';
  const website = { [c1]: { title: 'C1', minutes: 60, lessons: [{ title: 'L', url: `${c1}/l1`, progressPercent: 0 }] } };
  const { session, studyCallsMs } = makeSurplusSession({
    id: 'surplus-partial',
    courses: [{ courseUrl: c1, targetMinutes: 60 }],
    website,
    rngSequence: [16],
  });
  await session._initializeSurplusMode();
  await session._runSurplusStudy();

  assert.deepEqual(studyCallsMs, [5 * 60000, 5 * 60000, 5 * 60000, 1 * 60000]);
  assert.equal(session.surplusCourseStates[c1].confirmedMinutes, 16);
});

test('kiệt khẩu theo TỪNG KHÓA: target 30, chỉ xác nhận được 11', async () => {
  const c1 = 'https://x/slides/course-1';
  const website = { [c1]: { title: 'C1', minutes: 60, lessons: [{ title: 'L', url: `${c1}/l1`, progressPercent: 0 }] } };
  const { session } = makeSurplusSession({
    id: 'surplus-course-exhaust',
    courses: [{ courseUrl: c1, targetMinutes: 60 }],
    website,
    rngSequence: [30],
  });
  session._waitForActiveStudyTime = async (ms) => {
    const capacity = Math.max(0, 11 - (website[c1].minutes - 60));
    const add = Math.min(ms / 60000, capacity);
    website[c1].minutes += add;
    website[c1].lessons[0].progressPercent = Math.min(100, website[c1].lessons[0].progressPercent + add * 4);
    return ms;
  };
  await session._initializeSurplusMode();
  await session._runSurplusStudy();

  const state = session.surplusCourseStates[c1];
  assert.equal(state.targetMinutes, 30);
  assert.equal(state.confirmedMinutes, 11, 'giữ đúng 11 phút thực đã xác nhận');
  assert.equal(state.exhausted, true);
  assert.equal(state.completed, false, 'không fake đủ 30');
});

test('bài không mở được bị đánh dấu unusable và chuyển sang bài kế tiếp', async () => {
  const c1 = 'https://x/slides/course-1';
  const url1 = `${c1}/l1`;
  const url2 = `${c1}/l2`;
  const website = {
    [c1]: { title: 'C1', minutes: 60, lessons: [{ title: 'L1', url: url1, progressPercent: 0 }, { title: 'L2', url: url2, progressPercent: 0 }] },
  };
  const { session, gotoCounts } = makeSurplusSession({
    id: 'surplus-unusable-next',
    courses: [{ courseUrl: c1, targetMinutes: 60 }],
    website,
    rngSequence: [15],
    failingLessonUrls: [url1],
  });
  await session._initializeSurplusMode();
  await session._runSurplusStudy();

  assert.equal(gotoCounts.get(url1), 1, 'bài lỗi chỉ thử một lần');
  assert.ok(session.surplusCourseStates[c1].unusableLessons.includes(url1));
  assert.ok(gotoCounts.get(url2) > 0, 'chuyển sang bài kế tiếp');
});

test('tất cả khóa kiệt khẩu vẫn hoàn tất surplus pass sạch sẽ', async () => {
  const courses = [
    { courseUrl: 'https://x/c1', targetMinutes: 30 },
    { courseUrl: 'https://x/c2', targetMinutes: 30 },
  ];
  const website = {};
  for (const c of courses) {
    website[c.courseUrl] = { title: c.courseUrl, minutes: 30, lessons: [{ title: 'L', url: `${c.courseUrl}/l1`, progressPercent: 100 }] };
  }
  const { session } = makeSurplusSession({ id: 'surplus-allexhaust', courses, website, rngSequence: [15, 15] });
  assert.equal(await session._initializeSurplusMode(), true);
  assert.equal(await session._runSurplusStudy(), true);
  assert.equal(session._surplusPassProcessed(), true);
  assert.equal(session.surplusExhausted, true);
});

test('_finalizeSurplusCompletion chỉ true khi mọi khóa đã xử lý xong surplus', async () => {
  const courses = [
    { courseUrl: 'https://x/c1', targetMinutes: 30 },
    { courseUrl: 'https://x/c2', targetMinutes: 30 },
  ];
  const website = {};
  for (const c of courses) {
    website[c.courseUrl] = { title: c.courseUrl, minutes: 30, lessons: [{ title: 'L', url: `${c.courseUrl}/l1`, progressPercent: 100 }] };
  }
  const { session } = makeSurplusSession({ id: 'surplus-final', courses, website, rngSequence: [15, 15] });
  assert.equal(await session._finalizeSurplusCompletion(), false, 'chưa xử lý khóa nào');
  await session._initializeSurplusMode();
  await session._runSurplusStudy();
  assert.equal(await session._finalizeSurplusCompletion(), true);
});

test('mục tiêu RNG per-course sống sót qua restart', () => {
  const c1 = 'https://x/c1';
  const session = new AutoCourseSession('surplus-persist', { name: 'P' }, [{ courseUrl: c1 }]);
  session.surplusCourseStates = {
    [c1]: {
      courseUrl: c1,
      targetMinutes: 27,
      confirmedMinutes: 12,
      localActiveMinutes: 0,
      verifiedMinutes: 72,
      completed: false,
      exhausted: false,
      unusableLessons: [],
      studiedLessons: [],
      lessonAttempts: {},
    },
  };
  const restored = new AutoCourseSession('surplus-persist-2', { name: 'P' }, [{ courseUrl: c1 }], {
    surplusCourseStates: session.surplusCourseStates,
    surplusCurrentCourseIndex: 0,
  });
  assert.equal(restored.surplusCourseStates[c1].targetMinutes, 27);
  assert.equal(restored.surplusCourseStates[c1].confirmedMinutes, 12);
  assert.equal(restored.surplusCourseStates[c1].verifiedMinutes, 72);
});

test('daily limit trong Course 2 giữ state và resume đúng Course 2', async () => {
  const courses = [
    { courseUrl: 'https://x/c1', targetMinutes: 30 },
    { courseUrl: 'https://x/c2', targetMinutes: 30 },
    { courseUrl: 'https://x/c3', targetMinutes: 30 },
  ];
  const website = makeWebsite(courses, { minutes: 30 });
  const { session } = makeSurplusSession({
    id: 'surplus-daily',
    courses,
    website,
    rngSequence: [10, 30, 30],
    dailyMaxMinutes: 12,
  });
  session.dailyDate = session._vnDateStr();
  await session._initializeSurplusMode();
  await session._runSurplusStudy();

  assert.equal(session.status, 'daily-limit');
  assert.equal(session.surplusCurrentCourseIndex, 1, 'dừng ở Course 2');
  const c2State = session.surplusCourseStates[courses[1].courseUrl];
  assert.equal(c2State.targetMinutes, 30, 'target Course 2 không đổi');
  assert.equal(c2State.confirmedMinutes, 2, 'giữ 2/30 đã xác nhận');

  // Restart: khôi phục state per-course và resume đúng Course 2.
  const restored = new AutoCourseSession('surplus-daily-2', { name: 'D' }, courses, {
    surplusMode: true,
    dailyMaxMinutes: 12,
    surplusCourseStates: session.surplusCourseStates,
    surplusCurrentCourseIndex: session.surplusCurrentCourseIndex,
  });
  restored._phase = PHASE_RUNNING;
  restored.context = session.context;
  restored._scanCourseDetailsForCheckpoint = session._scanCourseDetailsForCheckpoint;
  restored._fakeVisibilityAPI = async () => {};
  restored.page = session.page;
  restored._randomBetween = () => 30;
  restored.dailyStudiedMinutes = 0;
  restored._ensureSurplusCourseStates();
  assert.equal(restored.surplusCurrentCourseIndex, 1);
  assert.equal(restored.surplusCourseStates[courses[1].courseUrl].targetMinutes, 30);
  assert.equal(restored.surplusCourseStates[courses[1].courseUrl].confirmedMinutes, 2);

  restored._waitForActiveStudyTime = async (ms) => ms;
  const resumed = [];
  const originalStudy = restored._studySurplusLesson.bind(restored);
  restored._studySurplusLesson = async (idx, config, state, lesson) => {
    resumed.push(config.courseUrl);
    return { outcome: 'unavailable' };
  };
  await restored._runSurplusStudy();
  assert.equal(resumed[0], courses[1].courseUrl, 'resume bắt đầu từ Course 2');
  assert.ok(!resumed.includes(courses[0].courseUrl), 'không quay lại Course 1');
});

test('migrate state surplus account-level cũ sang per-course không seed confirmedMinutes', () => {
  const c1 = 'https://x/c1';
  const session = new AutoCourseSession('surplus-legacy', { name: 'L' }, [{ courseUrl: c1 }], {
    surplusTargetMinutes: 45,
    surplusStudiedMinutes: 30,
    surplusExhausted: false,
  });
  session._phase = PHASE_RUNNING;
  session._ensureSurplusCourseStates();
  assert.equal(session.surplusCourseStates[c1].targetMinutes, null, 'mục tiêu per-course được sinh mới');
  assert.equal(session.surplusCourseStates[c1].confirmedMinutes, 0, 'số phút local cũ KHÔNG được coi là confirmed');
});

test('surplus pass xử lý xong nhưng final verification fail → defer, không re-arm', async () => {
  const c1 = 'https://x/c1';
  const session = new AutoCourseSession('surplus-defer-final', { name: 'Defer' }, [{ courseUrl: c1 }]);
  session._phase = PHASE_RUNNING;
  session._surplusStateFor(c1).completed = true;
  session._verifyAllConfiguredCoursesCompleted = async () => false;

  assert.equal(await session._finalizeSurplusCompletion(), false);
  assert.equal(session.surplusMode, false);
});

// ============ BẤT BIẾN VÒNG ĐỜI KHI VÀO TRẠNG THÁI HẸN GIỜ ============
// ff02e8c: một khi phiên đã hẹn giờ, callback async còn treo không được chạm
// state/khoá học, và đối tượng phiên phải chốt PHASE_FINISHED.

// 1. Daily limit trong lúc học.
test('daily limit trong lúc học chốt PHASE_FINISHED và vô hiệu thế hệ run', () => {
  const session = new AutoCourseSession(
    'limit-lesson',
    { name: 'Limit', email: 'l@x.vn' },
    [{ courseUrl: 'https://x/slides/course-1', targetMinutes: 60 }],
    { dailyMaxMinutes: 60 },
  );
  session._phase = PHASE_RUNNING;
  session._activeCourseRunId = 3;
  session.status = 'studying';
  session.dailyDate = session._vnDateStr();
  session.dailyStudiedMinutes = 60;

  assert.equal(session._peekSchedulingLimit(), 'daily-limit');
  assert.equal(session._hitSchedulingLimit(), true);
  assert.equal(session.status, 'daily-limit');
  assert.equal(session.isFinished(), true);
  assert.equal(session.isRunning(), false);
  assert.equal(session._activeCourseRunId, null, 'thế hệ run hiện tại bị vô hiệu');
  assert.equal(session.ownsAccountSession(), false, 'phiên hẹn giờ không còn chiếm tài khoản');
});

// 2. Daily limit trong lúc chờ checkpoint.
test('checkpoint hoàn tất sau daily-limit bị vứt bỏ, không ghi đè tiến độ hay học tiếp', async () => {
  const courseUrl = 'https://x/slides/course-1';
  const session = new AutoCourseSession(
    'limit-checkpoint',
    { name: 'Limit', email: 'l@x.vn' },
    [{ courseUrl, targetMinutes: 60 }],
    { dailyMaxMinutes: 60 },
  );
  session._phase = PHASE_RUNNING;
  session._activeCourseRunId = 8;
  session.status = 'studying';
  session.dailyDate = session._vnDateStr();
  session.dailyStudiedMinutes = 59;
  session.courseProgress[courseUrl] = {
    title: 'Course',
    targetMinutes: 60,
    studiedMinutes: 10,
    completed: false,
    finalizationState: COURSE_FINALIZATION_STATES.NORMAL_STUDY,
  };
  const logs = [];
  session.on('log', entry => logs.push(entry.msg));
  session._scanCourseDetailsForCheckpoint = async () => {
    // Giới hạn ngày đạt được trong lúc I/O đang chờ.
    session.dailyStudiedMinutes = 60;
    session._hitDailyLimit();
    return {
      courseTitle: 'Course',
      actualStudiedMinutes: 59,
      totalLessons: 3,
      uncompletedLessons: [{ progressPercent: 90 }],
      allLessons: [],
      courseLevelCompleted: false,
    };
  };

  const result = await session._verifyCourseProgressAfterCheckpoint({
    courseUrl,
    targetMinutes: 60,
    courseTitle: 'Course',
    courseRunId: 8,
    continueStudying: true,
  });

  assert.equal(result.stale, true);
  assert.equal(session.status, 'daily-limit');
  assert.equal(session.courseProgress[courseUrl].studiedMinutes, 10, 'tiến độ muộn không được ghi đè');
  assert.equal(
    session.courseProgress[courseUrl].finalizationState,
    COURSE_FINALIZATION_STATES.NORMAL_STUDY,
    'không được đổi finalization state sau khi hẹn giờ',
  );
  assert.equal(
    logs.some(msg => msg.includes('continuing the current lesson')),
    false,
    'không được log "continuing the current lesson" sau daily-limit',
  );
});

// 3. Daily limit trong lúc xác minh cấp website.
test('xác minh cấp khóa hoàn tất sau daily-limit bị vứt bỏ, không đánh dấu websiteCourseCompleted', async () => {
  const courseUrl = 'https://x/slides/course-1';
  const session = new AutoCourseSession(
    'limit-webverify',
    { name: 'Limit', email: 'l@x.vn' },
    [{ courseUrl, targetMinutes: 60 }],
    { dailyMaxMinutes: 60 },
  );
  session.context = {};
  session._phase = PHASE_RUNNING;
  session.status = 'studying';
  session.dailyDate = session._vnDateStr();
  session.dailyStudiedMinutes = 60;
  session._scanCourseDetailsForCheckpoint = async () => {
    session._hitDailyLimit();
    return { courseLevelCompleted: true, courseTitle: 'Course', courseProgressPercent: 100, totalLessons: 0, allLessons: [] };
  };

  assert.equal(await session._verifyAllConfiguredCoursesCompleted(), false);
  assert.equal(session.courseProgress[courseUrl], undefined, 'kết quả xác minh muộn không được ghi vào tiến độ');
});

// 4. Daily limit trong lúc học surplus.
test('daily limit trong lúc treo surplus không credit phút và không checkpoint', async () => {
  const courseUrl = 'https://x/slides/course-a';
  const lessonUrl = `${courseUrl}/lesson-a1-101`;
  const website = { [courseUrl]: { title: 'Course A', minutes: 60, lessons: [{ title: 'A1', url: lessonUrl, progressPercent: 0 }] } };
  const { session } = makeSurplusSession({
    id: 'limit-surplus',
    courses: [{ courseUrl, targetMinutes: 60 }],
    website,
    rngSequence: [15],
  });
  let checkpointed = false;
  session._checkpointAndCaptureSurplusEvidence = async () => { checkpointed = true; return null; };
  session._waitForActiveStudyTime = async () => {
    session.dailyStudiedMinutes = session.options.dailyMaxMinutes;
    session._hitDailyLimit();
    return 5 * 60000; // kết quả treo trả về muộn — phải bị vứt bỏ
  };

  await session._initializeSurplusMode();
  const result = await session._runSurplusStudy();

  assert.equal(result, false);
  assert.equal(session.status, 'daily-limit');
  assert.equal(session.surplusCourseStates[courseUrl].confirmedMinutes, 0, 'phút học muộn không được credit');
  assert.equal(checkpointed, false, 'không checkpoint sau khi đã hẹn giờ');
});

test('stale surplus run sau async navigation (page.goto) không mutate progress', async () => {
  const c1 = 'https://x/slides/course-1';
  const website = { [c1]: { title: 'C1', minutes: 60, lessons: [{ title: 'L', url: `${c1}/l1`, progressPercent: 0 }] } };
  const { session } = makeSurplusSession({ id: 'surplus-stale-nav', courses: [{ courseUrl: c1, targetMinutes: 60 }], website, rngSequence: [15] });
  session.page.goto = async () => {
    session.dailyStudiedMinutes = session.options.dailyMaxMinutes;
    session._hitDailyLimit();
  };
  await session._initializeSurplusMode();
  const result = await session._runSurplusStudy();
  assert.equal(result, false);
  assert.equal(session.status, 'daily-limit');
  assert.equal(session.surplusCourseStates[c1].confirmedMinutes, 0);
});

test('stale surplus run sau checkpoint không mutate progress', async () => {
  const c1 = 'https://x/slides/course-1';
  const website = { [c1]: { title: 'C1', minutes: 60, lessons: [{ title: 'L', url: `${c1}/l1`, progressPercent: 0 }] } };
  const { session } = makeSurplusSession({ id: 'surplus-stale-checkpoint', courses: [{ courseUrl: c1, targetMinutes: 60 }], website, rngSequence: [15] });
  session._checkpointAndCaptureSurplusEvidence = async () => {
    session.dailyStudiedMinutes = session.options.dailyMaxMinutes;
    session._hitDailyLimit();
    return null;
  };
  await session._initializeSurplusMode();
  const result = await session._runSurplusStudy();
  assert.equal(result, false);
  assert.equal(session.status, 'daily-limit');
  assert.equal(session.surplusCourseStates[c1].confirmedMinutes, 0);
});

// 5/7. Callback checkpoint đến muộn không thể đổi status hẹn giờ.
test('callback checkpoint đến muộn không thể đổi trạng thái hẹn giờ hay mở lại việc học', async () => {
  const courseUrl = 'https://x/slides/course-1';
  const session = new AutoCourseSession(
    'late-status',
    { name: 'Late', email: 'l@x.vn' },
    [{ courseUrl, targetMinutes: 60 }],
  );
  session._phase = PHASE_RUNNING;
  session._activeCourseRunId = 4;
  session.status = 'studying';
  session._enterScheduledStatus('daily-limit');
  assert.equal(session.status, 'daily-limit');
  assert.equal(session.isFinished(), true);

  let scanned = false;
  session._scanCourseDetailsForCheckpoint = async () => { scanned = true; return null; };
  const result = await session._verifyCourseProgressAfterCheckpoint({
    courseUrl,
    targetMinutes: 60,
    courseTitle: 'Course',
    courseRunId: 4,
  });

  assert.equal(result.stale, true);
  assert.equal(scanned, false);
  assert.equal(session.status, 'daily-limit', 'status hẹn giờ không bị thay đổi');
  assert.equal(session.isRunning(), false);
});

// 6. Callback xác minh cấp khóa đến muộn không thể mở lại việc học.
test('xác minh cấp khóa đến muộn không thể mở lại việc học', async () => {
  const courseUrl = 'https://x/slides/course-1';
  const session = new AutoCourseSession(
    'late-verify',
    { name: 'Late', email: 'l@x.vn' },
    [{ courseUrl, targetMinutes: 60 }],
  );
  session.context = {};
  session._phase = PHASE_RUNNING;
  session.status = 'studying';
  session._enterScheduledStatus('daily-limit');
  let scanned = false;
  session._scanCourseDetailsForCheckpoint = async () => {
    scanned = true;
    return { courseLevelCompleted: true, allLessons: [] };
  };

  assert.equal(await session._verifyAllConfiguredCoursesCompleted(), false);
  assert.equal(scanned, false);
});

// 7. Mọi trạng thái hẹn giờ đều chốt PHASE_FINISHED.
test('mọi trạng thái hẹn giờ đều chốt PHASE_FINISHED và không còn chiếm tài khoản', () => {
  for (const status of SCHEDULED_STATUSES) {
    const session = new AutoCourseSession(`sched-${status}`, { name: 'S', email: 's@x.vn' });
    session._phase = PHASE_RUNNING;
    session._activeCourseRunId = 1;
    session.status = 'studying';
    assert.equal(session._enterScheduledStatus(status), true);
    assert.equal(session.status, status);
    assert.equal(session.isFinished(), true);
    assert.equal(session.isRunning(), false);
    assert.equal(session.ownsAccountSession(), false);
  }
});

// 9. Đối tượng phiên cũ đã chốt không bao giờ start() lại.
test('đối tượng phiên cũ đã chốt không bao giờ chạy lại', async () => {
  const session = new AutoCourseSession('old-restart', { name: 'Old', email: 'o@x.vn' }, []);
  session._phase = PHASE_RUNNING;
  session._enterScheduledStatus('daily-limit');
  const warns = [];
  session.on('log', entry => { if (entry.level === 'warn') warns.push(entry.msg); });

  await session.start();

  assert.equal(session.status, 'daily-limit', 'phiên cũ không được chạy lại');
  assert.equal(warns.some(msg => msg.includes('trùng lặp')), true);
  assert.equal(session._phase, PHASE_FINISHED);
});

test('phiên bị Dừng không được hồi sinh thành trạng thái hẹn giờ bởi callback muộn', async () => {
  const session = new AutoCourseSession('stopped-no-revive', { name: 'Stopped', email: 's@x.vn' }, []);
  session._phase = PHASE_RUNNING;
  session.status = 'studying';
  await session.cancel();
  assert.equal(session.status, 'stopped');

  session.dailyDate = session._vnDateStr();
  session.dailyStudiedMinutes = session.options.dailyMaxMinutes;
  assert.equal(session._hitDailyLimit(), true);
  assert.equal(session.status, 'stopped', 'daily-limit không được hồi sinh phiên đã Dừng');
  assert.equal(SCHEDULED_STATUSES.has(session.status), false);
  assert.equal(session.isFinished(), true);
});

test('_isRunActive từ chối mọi trạng thái hẹn giờ và thế hệ run lệch', () => {
  const session = new AutoCourseSession('active-guard', { name: 'G', email: 'g@x.vn' });
  session._phase = PHASE_RUNNING;
  session._activeCourseRunId = 7;
  session.status = 'studying';
  assert.equal(session._isRunActive(7), true);
  assert.equal(session._isRunActive(8), false, 'sai thế hệ run');
  for (const status of SCHEDULED_STATUSES) {
    session.status = status;
    assert.equal(session._isRunActive(7), false, `phải từ chối ${status}`);
  }
  session.status = 'studying';
  session._phase = PHASE_FINISHED;
  assert.equal(session._isRunActive(7), false, 'phải từ chối phiên đã finished');
});

// ============ CỔNG XÁC MINH CẤP KHÓA: completed / incomplete / unknown ============

function courseScan({ title = 'Course', actual = 0, state = 'unknown', percent = null, lessons = [], uncompleted = [] } = {}) {
  return {
    courseTitle: title,
    actualStudiedMinutes: actual,
    courseCompletionState: state,
    courseProgressPercent: percent,
    allLessons: lessons,
    uncompletedLessons: uncompleted,
    totalLessons: lessons.length,
  };
}

// Phiên có context giả + scan khóa giả. myCourses mô phỏng /slides/all?my=1.
function makeGateSession(id, courses, { scans = {}, myCourses = [], options = {} } = {}) {
  const session = new AutoCourseSession(id, { name: id, email: `${id}@x.vn` }, courses, options);
  session._phase = PHASE_RUNNING;
  session.status = 'studying';
  session.context = {
    newPage: async () => ({
      goto: async () => {},
      waitForTimeout: async () => {},
      evaluate: async () => myCourses,
      close: async () => {},
    }),
  };
  session._scanCourseDetailsForCheckpoint = async (url) => {
    const scan = scans[url];
    if (typeof scan === 'function') return scan();
    return scan === undefined ? null : scan;
  };
  return session;
}

test('gate: target reached + website completed → xác minh thành công', async () => {
  const c1 = 'https://x/slides/c1';
  const session = makeGateSession('gate-ok', [{ courseUrl: c1, targetMinutes: 60 }], {
    scans: { [c1]: courseScan({ title: 'C1', actual: 60, state: 'completed', percent: 100 }) },
  });
  assert.equal(await session._verifyAllConfiguredCoursesCompleted(), true);
  assert.equal(session.courseProgress[c1].websiteCourseCompletionState, 'completed');
});

test('gate: website tường minh 80% → KHÔNG bắt đầu surplus', async () => {
  const c1 = 'https://x/slides/c1';
  const session = makeGateSession('gate-incomplete', [{ courseUrl: c1, targetMinutes: 60 }], {
    scans: { [c1]: courseScan({ title: 'C1', actual: 60, state: 'incomplete', percent: 80 }) },
  });
  const logs = [];
  session.on('log', e => logs.push(e.msg));
  assert.equal(await session._verifyAllConfiguredCoursesCompleted(), false);
  assert.equal(logs.some(m => m.includes('Course progress detected: 80%')), true, 'phải log tiến độ + nguồn');
});

test('gate: UNKNOWN kích hoạt đúng MỘT lần xác minh tươi; vẫn UNKNOWN + đủ target → cho phép kèm cảnh báo', async () => {
  const c1 = 'https://x/slides/c1';
  const session = makeGateSession('gate-unknown', [{ courseUrl: c1, targetMinutes: 60 }], {
    scans: { [c1]: courseScan({ title: 'C1', actual: 60, state: 'unknown' }) },
    myCourses: [],
  });
  let calls = 0;
  const original = session._resolveUnknownCoursesViaMyCourses.bind(session);
  session._resolveUnknownCoursesViaMyCourses = async (unknown) => { calls++; return original(unknown); };
  const logs = [];
  session.on('log', e => logs.push(e.msg));

  assert.equal(await session._verifyAllConfiguredCoursesCompleted(), true);
  assert.equal(calls, 1, 'chỉ một lần xác minh tươi');
  assert.equal(logs.some(m => m.includes('Falling back to verified configured study-time targets')), true);
});

test('gate: UNKNOWN được phân giải bởi trang My Courses', async () => {
  const c1 = 'https://x/slides/c1';
  const session = makeGateSession('gate-mycourses', [{ courseUrl: c1, targetMinutes: 60 }], {
    scans: { [c1]: courseScan({ title: 'Cấu tạo và sửa chữa', actual: 60, state: 'unknown' }) },
    myCourses: [{
      title: 'Cấu tạo và sửa chữa thông thường xe',
      completed: true,
      state: 'completed',
      source: 'my_courses_completed_badge',
    }],
  });
  assert.equal(await session._verifyAllConfiguredCoursesCompleted(), true);
  assert.equal(session.courseProgress[c1].websiteCourseCompletionState, 'completed');
});

test('gate: một khóa dưới target → không bao giờ vào surplus', async () => {
  const c1 = 'https://x/slides/c1';
  const c2 = 'https://x/slides/c2';
  const session = makeGateSession('gate-target', [
    { courseUrl: c1, targetMinutes: 60 },
    { courseUrl: c2, targetMinutes: 60 },
  ], {
    scans: {
      [c1]: courseScan({ title: 'C1', actual: 60, state: 'completed', percent: 100 }),
      [c2]: courseScan({ title: 'C2', actual: 59, state: 'completed', percent: 100 }),
    },
  });
  assert.equal(await session._verifyAllConfiguredCoursesCompleted(), false);
});

test('production fixture: 3781/3780 + bài ôn tập 70% → surplus tuần tự, mục tiêu mỗi khóa', async () => {
  const courses = [
    { courseUrl: 'https://x/c1', targetMinutes: 840 },
    { courseUrl: 'https://x/c2', targetMinutes: 840 },
    { courseUrl: 'https://x/c3', targetMinutes: 840 },
    { courseUrl: 'https://x/c4', targetMinutes: 840 },
  ];
  const website = {
    [courses[0].courseUrl]: { title: 'C1', minutes: 900, lessons: [{ title: 'L', url: 'https://x/c1/l1', progressPercent: 100 }] },
    [courses[1].courseUrl]: { title: 'C2', minutes: 900, lessons: [{ title: 'L', url: 'https://x/c2/l1', progressPercent: 100 }] },
    [courses[2].courseUrl]: { title: 'C3', minutes: 900, lessons: [{ title: 'L', url: 'https://x/c3/l1', progressPercent: 100 }] },
    [courses[3].courseUrl]: {
      title: 'Cấu tạo và sửa chữa thông thường xe - Cát Tường Minh',
      minutes: 3781,
      lessons: [
        { title: 'L1', url: 'https://x/c4/l1', progressPercent: 100 },
        { title: 'Ôn tập', url: 'https://x/c4/review-999', progressPercent: 70 },
      ],
    },
  };
  const { session, gotoCounts } = makeSurplusSession({ id: 'surplus-prod', courses, website, rngSequence: [47] });

  assert.equal(await session._initializeSurplusMode(), true);
  assert.equal(await session._runSurplusStudy(), true);

  for (const c of courses) {
    assert.equal(session.surplusCourseStates[c.courseUrl].targetMinutes, 47, 'mỗi khóa có mục tiêu RNG riêng');
  }
  assert.ok(session.surplusCourseStates[courses[3].courseUrl].confirmedMinutes > 0, 'bài ôn tập 70% được học surplus');
  assert.equal(gotoCounts.get('https://x/c4/l1') || 0, 0, 'bài 100% không bao giờ được chọn');
  assert.equal(session._surplusPassProcessed(), true);
});

test('final surplus verification: UNKNOWN + đủ target → hoàn thành, không lặp vô hạn', async () => {
  const c1 = 'https://x/slides/c1';
  const session = makeGateSession('final-unknown', [{ courseUrl: c1, targetMinutes: 60 }], {
    scans: { [c1]: courseScan({ title: 'C1', actual: 60, state: 'unknown' }) },
    myCourses: [],
  });
  // Discovery tươi xác nhận mọi khóa Completed → hoàn tất.
  installDiscovery(session, [{ courseUrl: c1, completed: true }]);
  session._surplusStateFor(c1).completed = true;
  assert.equal(await session._finalizeSurplusCompletion(), true);
  assert.equal(session.surplusMode, false);
});

test('final surplus verification: website tường minh incomplete → defer', async () => {
  const c1 = 'https://x/slides/c1';
  const session = makeGateSession('final-incomplete', [{ courseUrl: c1, targetMinutes: 60 }], {
    scans: { [c1]: courseScan({ title: 'C1', actual: 60, state: 'incomplete', percent: 82 }) },
  });
  // Discovery tươi vẫn còn khóa chưa Completed → KHÔNG hoàn tất.
  installDiscovery(session, [{ courseUrl: c1, completed: false }]);
  session._surplusStateFor(c1).completed = true;
  assert.equal(await session._finalizeSurplusCompletion(), false);
  assert.equal(session.surplusMode, false);
});

test('RNG surplus vẫn cố định 15-60 phút', () => {
  const session = new AutoCourseSession('rng-range', { name: 'R', email: 'r@x.vn' });
  for (let i = 0; i < 50; i++) {
    const value = session._randomBetween(15, 60);
    assert.ok(value >= 15 && value <= 60, `RNG=${value} ngoài 15-60`);
  }
});

// ── "Thời gian hoàn thành" của website: metadata hiển thị, KHÔNG quyết định
//    hoàn thành. null (chưa biết) khác 0 (đã biết là 0). ──

test('_websiteRecordedTime: đổi giờ/phút thành phút, giữ null và 0 chính xác', () => {
  assert.deepEqual(
    AutoCourseSession._websiteRecordedTime({ actualStudiedMinutes: 193, actualStudiedText: '3 giờ 13 phút' }),
    { websiteRecordedMinutes: 193, websiteRecordedText: '3 giờ 13 phút' },
  );
  assert.deepEqual(
    AutoCourseSession._websiteRecordedTime({ actualStudiedMinutes: 884, actualStudiedText: '14 giờ 44 phút' }),
    { websiteRecordedMinutes: 884, websiteRecordedText: '14 giờ 44 phút' },
  );
  // Không có text → CHƯA BIẾT (null), không phải 0.
  assert.deepEqual(
    AutoCourseSession._websiteRecordedTime({ actualStudiedMinutes: 0, actualStudiedText: '' }),
    { websiteRecordedMinutes: null, websiteRecordedText: null },
  );
  // Có text "0 giờ 0 phút" → đã biết là 0.
  assert.deepEqual(
    AutoCourseSession._websiteRecordedTime({ actualStudiedMinutes: 0, actualStudiedText: '0 giờ 0 phút' }),
    { websiteRecordedMinutes: 0, websiteRecordedText: '0 giờ 0 phút' },
  );
  // Scan lỗi/thiếu text KHÔNG được xoá giá trị hợp lệ cũ.
  assert.deepEqual(
    AutoCourseSession._websiteRecordedTime(
      { actualStudiedMinutes: 0, actualStudiedText: '' },
      { websiteRecordedMinutes: 193, websiteRecordedText: '3 giờ 13 phút' },
    ),
    { websiteRecordedMinutes: 193, websiteRecordedText: '3 giờ 13 phút' },
  );
  assert.deepEqual(
    AutoCourseSession._websiteRecordedTime(null, { websiteRecordedMinutes: 884, websiteRecordedText: '14 giờ 44 phút' }),
    { websiteRecordedMinutes: 884, websiteRecordedText: '14 giờ 44 phút' },
  );
});

test('course detail scan lưu websiteRecordedMinutes/Text và emit status live', async () => {
  const session = new AutoCourseSession('recorded', { name: 'R', email: 'r@x.vn' });
  const courseUrl = 'https://x/slides/course-1';
  const config = { courseUrl, title: 'Cấu tạo', targetHours: 0, targetMinutes: 0 };
  session.coursesConfig = [config];
  session._phase = PHASE_RUNNING;
  session._scanCourseDetailsForCheckpoint = async () => ({
    courseTitle: 'Cấu tạo và sửa chữa thông thường xe - Cát Tường Minh',
    actualStudiedMinutes: 193,
    actualStudiedText: '3 giờ 13 phút',
    courseProgressPercent: 25,
    courseCompletionState: 'incomplete',
    courseLevelCompleted: false,
    totalLessons: 5,
    uncompletedLessons: [{ progressPercent: 52 }],
    allLessons: [],
  });

  const statuses = [];
  session.on('status', snapshot => statuses.push(snapshot));

  const evaluation = await session._evaluateConfiguredCourse(config);

  assert.equal(session.courseProgress[courseUrl].websiteRecordedMinutes, 193);
  assert.equal(session.courseProgress[courseUrl].websiteRecordedText, '3 giờ 13 phút');
  assert.equal(session.courseProgress[courseUrl].websiteCourseProgressPercent, 25);
  assert.equal(session.courseProgress[courseUrl].websiteCourseCompletionState, 'incomplete');
  assert.equal(evaluation.state, 'incomplete');
  assert.equal(evaluation.percent, 25);
  // Live: một snapshot 'status' được phát sau khi ghi, mang đủ dữ liệu mới.
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].courseProgress[courseUrl].websiteRecordedMinutes, 193);
  assert.equal(statuses[0].courseProgress[courseUrl].websiteCourseProgressPercent, 25);
});

test('course detail scan thiếu "Thời gian hoàn thành" giữ nguyên giá trị cũ', async () => {
  const session = new AutoCourseSession('recorded-preserve', { name: 'R', email: 'r@x.vn' });
  const courseUrl = 'https://x/slides/course-1';
  const config = { courseUrl, title: 'C1', targetHours: 0, targetMinutes: 0 };
  session.coursesConfig = [config];
  session._phase = PHASE_RUNNING;
  session.courseProgress[courseUrl] = {
    websiteRecordedMinutes: 884,
    websiteRecordedText: '14 giờ 44 phút',
  };
  session._scanCourseDetailsForCheckpoint = async () => ({
    courseTitle: 'C1',
    actualStudiedMinutes: 0,
    actualStudiedText: '',
    courseProgressPercent: null,
    courseCompletionState: 'unknown',
    courseLevelCompleted: false,
    totalLessons: 1,
    uncompletedLessons: [],
    allLessons: [],
  });

  await session._evaluateConfiguredCourse(config);

  assert.equal(session.courseProgress[courseUrl].websiteRecordedMinutes, 884);
  assert.equal(session.courseProgress[courseUrl].websiteRecordedText, '14 giờ 44 phút');
});

// ── SURPLUS THEO NĂNG LỰC LỊCH (chiến lược 'schedule', default mới) ──

test('schedule strategy: chia đều năng lực còn lại, không dùng RNG', async () => {
  const courses = [
    { courseUrl: 'https://x/c1', targetMinutes: 0 },
    { courseUrl: 'https://x/c2', targetMinutes: 0 },
  ];
  const website = makeWebsite(courses);
  const { session } = makeSurplusSession({
    id: 'surplus-schedule-share',
    courses,
    website,
    surplusStrategy: 'schedule',
    dailyMaxMinutes: 480,
  });
  assert.equal(await session._initializeSurplusMode(), true);
  assert.equal(session.surplusCourseStates[courses[0].courseUrl].targetMinutes, 240);
  assert.equal(session.surplusCourseStates[courses[1].courseUrl].targetMinutes, 240);
  assert.equal(session.surplusPlan.totalMinutes, 480);
  assert.equal(session.surplusPlan.hasFiniteHorizon, false);
});

test('schedule strategy: khóa kiệt khẩu → năng lực chưa dùng dồn cho khóa còn lại', async () => {
  const courses = [
    { courseUrl: 'https://x/c1', targetMinutes: 0 },
    { courseUrl: 'https://x/c2', targetMinutes: 0 },
  ];
  const website = {
    'https://x/c1': { title: 'C1', minutes: 60, lessons: [{ title: 'L1', url: 'https://x/c1/l1', progressPercent: 100 }] },
    'https://x/c2': { title: 'C2', minutes: 60, lessons: [{ title: 'L2', url: 'https://x/c2/l2', progressPercent: 0 }] },
  };
  const { session } = makeSurplusSession({
    id: 'surplus-schedule-redistribute',
    courses,
    website,
    surplusStrategy: 'schedule',
    dailyMaxMinutes: 480,
  });
  await session._initializeSurplusMode();
  session._waitForActiveStudyTime = async (ms) => {
    website['https://x/c2'].minutes += ms / 60000;
    return ms;
  };
  await session._runSurplusStudy();

  assert.equal(session.surplusCourseStates['https://x/c1'].exhausted, true, 'C1 hết bài → kiệt khẩu');
  assert.ok(
    session.surplusCourseStates['https://x/c2'].targetMinutes >= 479,
    `C2 phải nhận lại năng lực chưa dùng (nhận ${session.surplusCourseStates['https://x/c2'].targetMinutes})`
  );
});

