const test = require('node:test');
const assert = require('node:assert/strict');
const { AutoCourseSession, courseReachedTarget } = require('../autoCourseEngine');

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
