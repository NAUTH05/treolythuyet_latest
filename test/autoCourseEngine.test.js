const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AutoCourseSession,
  courseReachedTarget,
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
