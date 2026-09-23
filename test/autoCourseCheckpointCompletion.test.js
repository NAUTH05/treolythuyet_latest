// ============================================================
//  CHECKPOINT HOÀN THÀNH KHÓA — CHẠY VÒNG LẶP HỌC THẬT
// ============================================================
// test/autoCourseEngine.test.js kiểm tra QUYẾT ĐỊNH tại ranh giới checkpoint.
// File này chạy VÒNG LẶP HỌC THẬT của start() để chứng minh tình huống production:
// khóa NORMAL đã Completed trên website trong khi bài đang treo mới 40% → phải
// DỪNG bài ngay tại checkpoint đó, KHÔNG đọc lại heartbeat, KHÔNG xác minh/gia hạn
// bài học, KHÔNG mở bài kế tiếp.
//
// LƯU Ý: autoCourseEngine destructure `scanCourseDetails` / `readDomTimer` từ
// courseScanner ngay lúc require → phải ghi đè exports TRƯỚC khi require engine.
// node --test chạy mỗi file test trong một tiến trình riêng nên các ghi đè này
// không ảnh hưởng tới các file test khác.

const test = require('node:test');
const assert = require('node:assert/strict');

const scanner = require('../courseScanner');

const COURSE_URL = 'https://x/slides/course-1';
const LESSON_URL = `${COURSE_URL}/lesson-4`;
// Bài kế tiếp trong CÙNG khóa: nếu vòng lặp không dừng ở checkpoint thì bài này
// sẽ bị mở — đây là bằng chứng "không mở bài kế tiếp".
const NEXT_LESSON_URL = `${COURSE_URL}/lesson-5`;

// Trạng thái "website" mô phỏng — test điều khiển để tái hiện đúng chuỗi thật.
const website = {
  completionState: 'incomplete',
  progressPercent: 97,
  recordedMinutes: 737,
  recordedText: '12h17m',
  lessonPercent: 40,
};

let currentPageUrl = 'about:blank';
let scanCalls = 0;
let domTimerCalls = 0;
// Phần trăm từng bài trong khóa. Mặc định: còn bài chưa xong (đúng production).
let lessonPercents = [40, 0];

scanner.scanCourseDetails = async (page, courseUrl) => {
  scanCalls++;
  // Chỉ trang CHÍNH mới đổi URL hiện tại; trang checkpoint phụ không được làm lệch
  // kiểm tra "đang đứng ở đâu" của vòng lặp.
  if (courseUrl && page && page.__main) currentPageUrl = courseUrl;
  const allLessons = lessonPercents.map((percentValue, index) => ({
    title: `Bài ${index + 4}`,
    url: `${COURSE_URL}/lesson-${index + 4}`,
    progressPercent: percentValue,
    isCompleted: percentValue >= 100,
  }));
  return {
    courseTitle: 'Cấu tạo và sửa chữa thông thường xe - Cát Tường Minh',
    courseCompletionState: website.completionState,
    courseLevelCompleted: website.completionState === 'completed',
    courseCompletionSource: 'test-fixture',
    courseProgressPercent: website.progressPercent,
    actualStudiedMinutes: website.recordedMinutes,
    actualStudiedText: website.recordedText,
    totalLessons: 5,
    allLessons,
    uncompletedLessons: allLessons
      .filter(lesson => !lesson.isCompleted)
      .map(lesson => ({ ...lesson, isCompleted: false })),
  };
};

// Bài học có bộ đếm 5 phút → vòng lặp mở bài với lessonMinutes = 5.
scanner.readDomTimer = async () => {
  domTimerCalls++;
  return { hours: 0, minutes: 5, seconds: 0, totalMinutes: 5 };
};

const { AutoCourseSession } = require('../autoCourseEngine');

// Mock tối thiểu cho Playwright: chỉ những API mà vòng lặp học thật sự gọi.
function makeBrowserHarness() {
  const { chromium } = require('playwright');
  const originalLaunch = chromium.launch;
  const events = { goto: [], reloads: 0, lessonChecks: 0, courseLessonVerifications: 0 };
  const pages = [];

  const makePage = () => {
    const page = {
      __main: pages.length === 0,
      url: () => currentPageUrl,
      isClosed: () => false,
      goto: async (url) => { events.goto.push(url); currentPageUrl = url; },
      reload: async () => { events.reloads++; },
      waitForTimeout: async () => {},
      waitForSelector: async () => ({}),
      evaluate: async () => null,
      $: async () => null,
      on: () => {},
      removeListener: () => {},
      close: async () => {},
    };
    pages.push(page);
    return page;
  };

  chromium.launch = async () => ({
    newContext: async () => ({ newPage: async () => makePage(), close: async () => {} }),
    close: async () => {},
  });

  return { events, pages, restore: () => { chromium.launch = originalLaunch; } };
}

test('vòng lặp NORMAL: khóa Completed giữa checkpoint → dừng bài ngay, không heartbeat/gia hạn/bài kế', async () => {
  website.completionState = 'incomplete';
  website.progressPercent = 97;
  website.recordedMinutes = 737;
  website.recordedText = '12h17m';
  lessonPercents = [40, 0];
  currentPageUrl = 'about:blank';
  scanCalls = 0;
  domTimerCalls = 0;

  const harness = makeBrowserHarness();
  const session = new AutoCourseSession(
    'loop-completion',
    { name: 'Cát Tường Minh', email: 'ctm@x.vn' },
    [],
    { dailyMaxMinutes: 480, refreshInterval: 15 },
  );

  // Đăng nhập không phải đối tượng của test này.
  session.login = async () => true;
  // Auto-discovery: khóa NORMAL tự động phát hiện → targetHours/targetMinutes = 0.
  const discovery = [{
    courseUrl: COURSE_URL,
    title: 'Cấu tạo và sửa chữa thông thường xe - Cát Tường Minh',
    orderIndex: 0,
    completed: false,
    completionState: 'incomplete',
    progressPercent: 97,
  }];
  const applyDiscovery = () => {
    session.discoveredCourses = discovery.map((c, index) => ({ ...c, discoveredAt: '2026-01-01T00:00:00.000Z', source: 'test-discovery', orderIndex: index }));
    session.coursesConfig = discovery.map((c, index) => ({
      courseUrl: c.courseUrl, title: c.title, orderIndex: index, targetHours: 0, targetMinutes: 0,
    }));
    session._discoveryValid = true;
    return session.discoveredCourses;
  };
  applyDiscovery();
  session._discoverCourses = async () => applyDiscovery();

  // Không chờ thật: mỗi bước trừ 1 phút và đổi trạng thái website để tái hiện
  // đúng chuỗi production: Checkpoint A còn In Progress → Checkpoint B Completed.
  let waitCount = 0;
  session._waitForActiveStudyTime = async () => {
    waitCount++;
    if (waitCount === 1) {
      website.progressPercent = 98;
      website.recordedMinutes = 754;
      website.recordedText = '12h34m';
    } else {
      website.completionState = 'completed';
      website.progressPercent = 100;
      website.recordedMinutes = 769;
      website.recordedText = '12h49m';
    }
    return 60000;
  };

  // Đếm xem có bị hỏi trạng thái BÀI HỌC sau khi khóa đã Completed hay không.
  session._isCurrentLessonCompleted = async () => { harness.events.lessonChecks++; return false; };
  session._verifyLessonProgressFromCourse = async () => {
    harness.events.courseLessonVerifications++;
    return { completed: false, progressPercent: website.lessonPercent };
  };

  const logs = [];
  // Mốc quan trọng: số lần đọc DOM timer ngay tại thời điểm ghi log quyết định dừng.
  // Sau mốc này KHÔNG được đọc thêm lần nào (không heartbeat).
  let domTimerCallsAtStopDecision = null;
  session.on('log', entry => {
    logs.push(entry.msg);
    if (domTimerCallsAtStopDecision === null
      && entry.msg.includes('Decision: stop current lesson and switch course')) {
      domTimerCallsAtStopDecision = domTimerCalls;
    }
  });

  try {
    await session.start();
  } finally {
    harness.restore();
  }

  const joined = logs.join('\n');

  // 1) Checkpoint A — còn In Progress → học tiếp.
  assert.match(joined, /Website status: In Progress/, 'checkpoint A phải đọc trạng thái website');
  assert.match(joined, /Course progress: 98%/, 'checkpoint A phải cập nhật tiến độ khóa');
  assert.match(joined, /Website recorded time: 12h34m/, 'checkpoint A phải cập nhật giờ ghi nhận');
  assert.match(joined, /Decision: continue current lesson/);

  // 2) Checkpoint B — Completed → dừng bài và chuyển khóa.
  assert.match(joined, /Website status: Completed/, 'checkpoint B phải thấy khóa đã Completed');
  assert.match(joined, /Website recorded time: 12h49m/);
  assert.match(joined, /Decision: stop current lesson and switch course/);

  // 3) Không còn log mốc 0 phút gây hiểu nhầm.
  assert.doesNotMatch(joined, /\/0 minutes/);

  // 4) Dừng NGAY: không heartbeat sau khi chốt, không xác minh bài, không gia hạn,
  //    không mở bài kế. (2 lần đọc DOM timer = 1 lần mở bài + 1 heartbeat ở
  //    Checkpoint A khi khóa CÒN In Progress — hợp lệ.)
  assert.equal(domTimerCallsAtStopDecision, 2, 'phải có đúng 1 heartbeat trước khi khóa Completed');
  assert.equal(domTimerCalls, domTimerCallsAtStopDecision, 'không được đọc lại DOM timer (heartbeat) sau khi khóa đã Completed');
  assert.equal(harness.events.lessonChecks, 0, 'không được kiểm tra badge hoàn thành bài học');
  assert.equal(harness.events.courseLessonVerifications, 0, 'không được xác minh/gia hạn bài học');
  assert.deepEqual(
    harness.events.goto,
    [LESSON_URL],
    'khóa còn bài 5 chưa xong nhưng KHÔNG được mở bài kế tiếp sau khi khóa đã Completed',
  );
  assert.equal(waitCount, 2, 'dừng ở checkpoint thứ hai, không treo thêm');

  // 5) Trạng thái cuối cùng mà dashboard đọc được.
  const progress = session.courseProgress[COURSE_URL];
  assert.equal(progress.completed, true, 'khóa phải được đánh dấu hoàn thành');
  assert.equal(progress.websiteCourseCompleted, true);
  assert.equal(progress.websiteCourseCompletionState, 'completed');
  assert.equal(progress.websiteCourseProgressPercent, 100);
  assert.equal(progress.websiteRecordedText, '12h49m');
  // Bài 4 vẫn 40% — không hề cản trở việc chốt khóa NORMAL.
  assert.equal(lessonPercents[0], 40);
  assert.ok(scanCalls >= 3, 'phải quét lại trang khóa học ở mỗi checkpoint');
});

test('vòng lặp NORMAL: MỌI bài 100% nhưng website CHƯA Completed → KHÔNG đánh dấu hoàn thành', async () => {
  website.completionState = 'incomplete';
  website.progressPercent = 100;
  website.recordedMinutes = 3769;
  website.recordedText = '62 giờ 49 phút';
  lessonPercents = [100, 100]; // không còn bài chưa xong
  currentPageUrl = 'about:blank';
  scanCalls = 0;
  domTimerCalls = 0;

  const harness = makeBrowserHarness();
  const session = new AutoCourseSession(
    'loop-all-lessons-complete',
    { name: 'TT17', email: 'tt17@x.vn' },
    [],
    { dailyMaxMinutes: 480, refreshInterval: 15 },
  );
  session.login = async () => true;
  const discovery = [{
    courseUrl: COURSE_URL,
    title: '[TT17] Pháp Luật Giao thông đường bộ',
    orderIndex: 0,
    completed: false,
    completionState: 'incomplete',
    progressPercent: 100,
  }];
  const applyDiscovery = () => {
    session.discoveredCourses = discovery.map((c, index) => ({
      ...c, discoveredAt: '2026-01-01T00:00:00.000Z', source: 'test-discovery', orderIndex: index,
    }));
    session.coursesConfig = discovery.map((c, index) => ({
      courseUrl: c.courseUrl, title: c.title, orderIndex: index, targetHours: 0, targetMinutes: 0,
    }));
    session._discoveryValid = true;
    return session.discoveredCourses;
  };
  applyDiscovery();
  session._discoverCourses = async () => applyDiscovery();
  session._waitForActiveStudyTime = async () => 60000;

  const logs = [];
  session.on('log', entry => logs.push(entry.msg));

  try {
    await session.start();
  } finally {
    harness.restore();
  }

  // Mọi bài 100% KHÔNG phải bằng chứng khóa hoàn thành — quyết định phải theo
  // trạng thái khóa trên website (vẫn In Progress).
  assert.equal(session.courseProgress[COURSE_URL].completed, false, 'mọi bài 100% không được tự chốt khóa');
  assert.equal(session.courseProgress[COURSE_URL].websiteCourseCompleted, false);
  assert.equal(session.courseProgress[COURSE_URL].websiteCourseCompletionState, 'incomplete');
  assert.equal(session.courseProgress[COURSE_URL].websiteCourseProgressPercent, 100, 'dashboard vẫn thấy 100% + In Progress');
  assert.equal(harness.events.goto.length, 0, 'không còn bài để mở nhưng khóa vẫn KHÔNG được coi là xong');
});
