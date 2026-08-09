const test = require('node:test');
const assert = require('node:assert/strict');
const { AutoCourseSession, courseReachedTarget } = require('../autoCourseEngine');
const { extractSlideIdFromUrl } = require('../courseScanner');

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
