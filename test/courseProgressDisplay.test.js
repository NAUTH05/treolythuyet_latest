const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const DISPLAY_MODULE = path.join(__dirname, '..', 'src', 'courseProgressDisplay.mjs');
let modulePromise = null;

function loadDisplay() {
  if (!modulePromise) modulePromise = import(pathToFileURL(DISPLAY_MODULE).href);
  return modulePromise;
}

test('dashboard: In Progress hiển thị "% · thời gian website"', async () => {
  const { courseRowDisplay } = await loadDisplay();
  const row = courseRowDisplay({
    websiteCourseCompleted: false,
    websiteCourseCompletionState: 'incomplete',
    websiteCourseProgressPercent: 25,
    websiteRecordedMinutes: 193,
    websiteRecordedText: '3 giờ 13 phút',
  });
  assert.equal(row.label, '25% · 3h 13m');
  assert.equal(row.done, false);
  assert.equal(row.pct, 25);
});

test('dashboard: Completed hiển thị "Completed · thời gian website"', async () => {
  const { courseRowDisplay } = await loadDisplay();
  const row = courseRowDisplay({
    websiteCourseCompleted: true,
    websiteCourseCompletionState: 'completed',
    websiteCourseProgressPercent: 100,
    websiteRecordedMinutes: 884,
    websiteRecordedText: '14 giờ 44 phút',
  });
  assert.equal(row.label, 'Completed · 14h 44m');
  assert.equal(row.done, true);
  assert.equal(row.pct, 100);
});

test('dashboard: thời gian chưa biết hiển thị "--", KHÔNG phải 0m', async () => {
  const { courseRowDisplay } = await loadDisplay();
  const row = courseRowDisplay({
    websiteCourseCompletionState: 'incomplete',
    websiteCourseProgressPercent: null,
    websiteRecordedMinutes: null,
  });
  assert.equal(row.label, 'In Progress · --');
  assert.equal(row.done, false);
});

test('dashboard: thiếu hẳn trường thời gian cũng hiển thị "--"', async () => {
  const { courseRowDisplay } = await loadDisplay();
  const row = courseRowDisplay({ websiteCourseCompletionState: 'incomplete' });
  assert.equal(row.label, 'In Progress · --');
});

test('dashboard: 0 phút đã biết hiển thị "0m"', async () => {
  const { courseRowDisplay } = await loadDisplay();
  const row = courseRowDisplay({
    websiteCourseCompletionState: 'incomplete',
    websiteRecordedMinutes: 0,
    websiteRecordedText: '0 giờ 0 phút',
  });
  assert.equal(row.label, 'In Progress · 0m');
});

test('dashboard: thời gian website KHÔNG quyết định hoàn thành', async () => {
  const { courseRowDisplay } = await loadDisplay();
  const row = courseRowDisplay({
    websiteCourseCompletionState: 'incomplete',
    websiteCourseProgressPercent: 57,
    websiteRecordedMinutes: 3780,
    websiteRecordedText: '63 giờ 0 phút',
  });
  assert.equal(row.done, false);
  assert.equal(row.label, '57% · 63h 0m');
});

test('dashboard: legacy row (không có website fields) vẫn hiển thị studied/target', async () => {
  const { courseRowDisplay } = await loadDisplay();
  const row = courseRowDisplay({ targetMinutes: 120, studiedMinutes: 60, completed: false });
  assert.equal(row.label, '1h 0m / 2h 0m');
  assert.equal(row.done, false);
});

test('dashboard: legacy row đạt mục tiêu giữ nhãn cũ', async () => {
  const { courseRowDisplay } = await loadDisplay();
  const row = courseRowDisplay({ targetMinutes: 120, studiedMinutes: 120, completed: true });
  assert.equal(row.label, 'Đã đạt mục tiêu');
  assert.equal(row.done, true);
});

// Production thật: [TT17] Pháp Luật Giao thông đường bộ hiển thị 100% + 62h49m
// nhưng KHÔNG có badge hoàn thành → phải hiển thị "100% · 62h 49m" (In Progress),
// KHÔNG được thành "Completed · 62h 49m" chỉ vì phần trăm bằng 100.
test('dashboard: 100% + In Progress + 62h 49m KHÔNG hiển thị Completed', async () => {
  const { courseRowDisplay } = await loadDisplay();
  const row = courseRowDisplay({
    websiteCourseCompleted: false,
    websiteCourseCompletionState: 'incomplete',
    websiteCourseProgressPercent: 100,
    websiteRecordedMinutes: 3769,
    websiteRecordedText: '62 giờ 49 phút',
  });

  assert.equal(row.label, '100% · 62h 49m');
  assert.notEqual(row.label, 'Completed · 62h 49m');
  assert.equal(row.done, false, 'không được tô xanh chỉ vì 100%');
  assert.equal(row.websiteCompleted, false);
  assert.equal(row.pct, 100);
});

test('dashboard: chỉ badge Completed mới cho nhãn Completed (100% không đủ)', async () => {
  const { courseRowDisplay } = await loadDisplay();
  const withoutBadge = courseRowDisplay({
    websiteCourseCompletionState: 'incomplete',
    websiteCourseProgressPercent: 100,
    websiteRecordedMinutes: 3769,
  });
  const withBadge = courseRowDisplay({
    websiteCourseCompleted: true,
    websiteCourseCompletionState: 'completed',
    websiteCourseProgressPercent: 100,
    websiteRecordedMinutes: 3769,
  });

  assert.equal(withoutBadge.done, false);
  assert.equal(withBadge.done, true);
  assert.equal(withBadge.label, 'Completed · 62h 49m');
});
