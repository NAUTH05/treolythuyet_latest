const test = require('node:test');
const assert = require('node:assert/strict');
const { AutoCourseSession, PHASE_RUNNING } = require('../autoCourseEngine');

const BASE = 'https://hoclythuyetlaixe.eco-tek.com.vn';
const abs = path => `${BASE}${path}`;

// Giả lập trang /slides/all?my=1: scanMyCoursesCompletion chạy page.evaluate(fn)
// và nhận thẳng mảng khóa đã kết xuất.
function discoveryContext(courses) {
  return {
    newPage: async () => ({
      goto: async () => {},
      waitForTimeout: async () => {},
      evaluate: async () => courses.map(c => ({ ...c })),
      close: async () => {},
    }),
  };
}

function raceCourse(title, path, { completed = false, progressPercent = null } = {}) {
  return {
    title,
    url: `https://hoclythuyetlaixe.eco-tek.com.vn${path}`,
    coursePath: path.replace(/\/+$/, ''),
    orderIndex: 0,
    completed,
    state: completed ? 'completed' : 'incomplete',
    progressPercent: completed ? 100 : progressPercent,
    source: completed ? 'my_courses_completed_badge' : 'my_courses_listed_incomplete',
  };
}

function discoverySession(id, courses) {
  const session = new AutoCourseSession(id, { name: id, email: `${id}@x.vn` }, []);
  session._phase = PHASE_RUNNING;
  session.status = 'idle';
  session.context = discoveryContext(courses);
  return session;
}

test('4 khóa được phát hiện tự động và giữ đúng thứ tự website', async () => {
  const session = discoverySession('disc-4', [
    raceCourse('Cấu tạo và sửa chữa thông thường xe', '/slides/course-1', { completed: true }),
    raceCourse('[TT17] Pháp Luật Giao thông đường bộ', '/slides/course-2', { completed: false, progressPercent: 98 }),
    raceCourse('Course 3', '/slides/course-3', { completed: true }),
    raceCourse('Course 4', '/slides/course-4', { completed: false, progressPercent: 70 }),
  ]);

  const discovered = await session._discoverCourses();
  assert.equal(discovered.length, 4);
  assert.deepEqual(discovered.map(c => c.orderIndex), [0, 1, 2, 3]);
  assert.deepEqual(
    session.coursesConfig.map(c => c.courseUrl),
    [abs('/slides/course-1'), abs('/slides/course-2'), abs('/slides/course-3'), abs('/slides/course-4')],
  );
  assert.deepEqual(discovered.map(c => c.coursePath), ['/slides/course-1', '/slides/course-2', '/slides/course-3', '/slides/course-4']);
  assert.deepEqual(discovered.map(c => c.completed), [true, false, true, false]);
  assert.equal(discovered[1].completionState, 'incomplete', 'In Progress 98% vẫn là incomplete');
  assert.equal(discovered[1].progressPercent, 98);
  assert.equal(discovered[0].completionState, 'completed');
});

test('khóa học dùng canonical URL path làm định danh, không dùng title', async () => {
  const session = discoverySession('disc-canonical', [
    raceCourse('Trùng tên A', '/slides/course-x', { completed: true }),
  ]);
  const discovered = await session._discoverCourses();
  assert.equal(discovered[0].coursePath, '/slides/course-x', 'định danh là path canonical');
  assert.equal(discovered[0].courseUrl, abs('/slides/course-x'), 'URL điều hướng là absolute');
  assert.ok(!discovered[0].coursePath.includes('Trùng tên'));
  assert.equal(session.courseProgress[abs('/slides/course-x')].websiteCourseCompleted, true);
});

test('targetHours/targetMinutes thủ công không còn bắt buộc (được zero hoá)', async () => {
  const session = new AutoCourseSession(
    'disc-notarget',
    { name: 'N', email: 'n@x.vn' },
    [{ courseUrl: 'https://x/slides/old', targetHours: 12, targetMinutes: 30 }],
  );
  session._phase = PHASE_RUNNING;
  session.status = 'idle';
  session.context = discoveryContext([raceCourse('Auto Course', '/slides/auto', { completed: false })]);
  await session._discoverCourses();
  assert.equal(session.coursesConfig.length, 1);
  assert.equal(session.coursesConfig[0].courseUrl, abs('/slides/auto'));
  assert.equal(session.coursesConfig[0].targetHours, 0);
  assert.equal(session.coursesConfig[0].targetMinutes, 0);
});

test('số lượng khóa động: 2 rồi 3 khóa đều hoạt động', async () => {
  const session = discoverySession('disc-dynamic', [
    raceCourse('A', '/slides/a', { completed: true }),
    raceCourse('B', '/slides/b', { completed: true }),
  ]);
  await session._discoverCourses();
  assert.equal(session.discoveredCourses.length, 2);

  session.context = discoveryContext([
    raceCourse('A', '/slides/a', { completed: true }),
    raceCourse('B', '/slides/b', { completed: true }),
    raceCourse('C', '/slides/c', { completed: false }),
  ]);
  await session._discoverCourses();
  assert.equal(session.discoveredCourses.length, 3);
  assert.equal(session._allDiscoveredCoursesCompleted(), false);
});

test('khóa MỚI được phát hiện, log và thêm vào knownCourseKeys (không trùng)', async () => {
  const session = discoverySession('disc-new', [
    raceCourse('A', '/slides/a', { completed: true }),
  ]);
  const logs = [];
  session.on('log', e => logs.push(e.msg));
  await session._discoverCourses();
  assert.deepEqual(session.knownCourseKeys, [abs('/slides/a')]);

  session.context = discoveryContext([
    raceCourse('A', '/slides/a', { completed: true }),
    raceCourse('MỚI', '/slides/new', { completed: false }),
  ]);
  await session._discoverCourses();
  assert.equal(logs.some(m => m.includes('New course detected')), true);
  assert.deepEqual(session.knownCourseKeys.sort(), [abs('/slides/a'), abs('/slides/new')].sort());
  assert.equal(session._allDiscoveredCoursesCompleted(), false, 'khóa mới chưa xong → account không còn complete');
});

test('phát hiện trùng lặp không tạo bản ghi khóa trùng', async () => {
  const session = discoverySession('disc-dedupe', [
    raceCourse('A', '/slides/a', { completed: true }),
    raceCourse('A (dup)', '/slides/a', { completed: true }),
    raceCourse('B', '/slides/b', { completed: true }),
  ]);
  await session._discoverCourses();
  assert.equal(session.discoveredCourses.length, 2);
  assert.equal(Object.keys(session.courseProgress).length, 2);
  await session._discoverCourses();
  assert.equal(session.discoveredCourses.length, 2, 'quét lại không nhân bản');
});

test('discovery rỗng/thất bại KHÔNG được coi là đã hoàn thành', async () => {
  const session = discoverySession('disc-empty', []);
  const discovered = await session._discoverCourses();
  assert.equal(discovered, null);
  assert.equal(session._discoveryValid, false);
  assert.equal(session._allDiscoveredCoursesCompleted(), false);
  assert.equal(await session._verifyAllCurrentCoursesCompleted(), null);
});

test('NORMAL có ưu tiên: surplus không khởi động khi còn khóa chưa Completed', async () => {
  const session = discoverySession('disc-priority', [
    raceCourse('A', '/slides/a', { completed: true }),
    raceCourse('B', '/slides/b', { completed: false, progressPercent: 50 }),
  ]);
  await session._discoverCourses();
  assert.equal(session._allDiscoveredCoursesCompleted(), false);
  const initialized = await session._initializeSurplusMode();
  assert.equal(initialized, false, 'surplus bị chặn khi còn khóa normal chưa xong');
  assert.equal(session.surplusMode, false);
});

test('surplus chỉ khởi động khi MỌI khóa hiện tại Completed', async () => {
  const session = discoverySession('disc-allcomplete', [
    raceCourse('A', '/slides/a', { completed: true }),
    raceCourse('B', '/slides/b', { completed: true }),
  ]);
  await session._discoverCourses();
  assert.equal(session._allDiscoveredCoursesCompleted(), true);
  const initialized = await session._initializeSurplusMode();
  assert.equal(initialized, true);
  assert.equal(session.surplusMode, true);
});

test('khóa mới xuất hiện sau khi đã Completed làm account active trở lại', async () => {
  const session = discoverySession('disc-reactivate', [
    raceCourse('A', '/slides/a', { completed: true }),
  ]);
  await session._discoverCourses();
  assert.equal(session._allDiscoveredCoursesCompleted(), true);

  session.context = discoveryContext([
    raceCourse('A', '/slides/a', { completed: true }),
    raceCourse('NEW', '/slides/new', { completed: false }),
  ]);
  await session._discoverCourses();
  assert.equal(session._allDiscoveredCoursesCompleted(), false);
  assert.equal(await session._initializeSurplusMode(), false, 'khóa mới buộc quay lại NORMAL');
});

test('discovery stale sau khi vào trạng thái hẹn giờ không mutate state', async () => {
  const session = discoverySession('disc-stale', [
    raceCourse('A', '/slides/a', { completed: true }),
  ]);
  session._enterScheduledStatus('daily-limit');
  const before = JSON.stringify(session.discoveredCourses);
  const discovered = await session._discoverCourses();
  assert.equal(discovered, null);
  assert.equal(JSON.stringify(session.discoveredCourses), before, 'không mutate khi stale');
});

test('_canonicalCourseUrl trả path từ URL và fallback khi thiếu URL', () => {
  const session = new AutoCourseSession('disc-url', { name: 'U', email: 'u@x.vn' }, []);
  assert.equal(
    session._canonicalCourseUrl('https://hoclythuyetlaixe.eco-tek.com.vn/slides/course-1?x=1', 'X'),
    '/slides/course-1',
  );
  const fallback = session._canonicalCourseUrl(null, 'Khóa Lạ Số 1');
  assert.ok(fallback.startsWith('my-courses:'));
});
