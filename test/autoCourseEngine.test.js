const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AutoCourseSession,
  courseReachedTarget,
  isAutoCourseAccountBlockingStatus,
  getPersistentAutoCourseOptions,
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
