const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeSurplusOptions,
  surplusTargetBounds,
  SURPLUS_DEFAULTS,
  planSurplusCapacity,
  allocateSurplusTargets,
  schedulableMinutesForDate,
  remainingSchedulableMinutesToday,
  mergeIntervals,
  intersectIntervals,
  totalIntervalMinutes,
  latestAllowedDateKey,
  enumerateAllowedStudyDates,
} = require('../autoScanSurplus');

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const Y = 2026;
// Thời điểm UTC thực ứng với giờ VN cho trước.
function vnAt(y, m, d, hh, mm) {
  return new Date(Date.UTC(y, m - 1, d, hh, mm, 0, 0) - VN_OFFSET_MS);
}

// ── TEST CASE A: năng lực theo ngày, KHÔNG cộng dồn ──
test('A: hôm nay dùng phần còn lại, ngày mai có hạn mức riêng của nó', () => {
  const now = vnAt(Y, 9, 18, 12, 0);
  const plan = planSurplusCapacity({
    now,
    dailyMaxMinutes: 480,
    dailyStudiedMinutes: 360,
    allowedDateRanges: [`18/09/${Y}-19/09/${Y}`],
  });
  assert.equal(plan.todayMinutes, 120);
  assert.equal(plan.futureTotalMinutes, 480);
  assert.equal(plan.totalMinutes, 600);
  assert.equal(plan.futureDays.length, 1);
  assert.equal(plan.futureDays[0].date, `${Y}-09-19`);
  assert.equal(plan.futureDays[0].availableMinutes, 480, 'ngày mai vẫn tối đa 8h, KHÔNG cộng dồn 120 phút dư');
});

// ── TEST CASE B: hôm nay còn ít thời gian khung giờ ──
test('B: năng lực hôm nay bị chặn bởi khung giờ còn lại, không phải daily remaining', () => {
  const now = vnAt(Y, 9, 18, 11, 30);
  const plan = planSurplusCapacity({
    now,
    dailyMaxMinutes: 480,
    dailyStudiedMinutes: 360,
    allowedDateRanges: [`18/09/${Y}`],
    timeWindows: [{ start: '11:30', end: '12:00' }],
  });
  assert.equal(plan.dailyRemainingMinutes, 120);
  assert.equal(plan.todayMinutes, 30, 'chỉ còn 30 phút khung giờ');
});

// ── TEST CASE C: ngày tương lai có ca học ngắn → không vượt quá ca đó ──
test('C: năng lực ngày tương lai = min(dailyMax, tổng ca)', () => {
  const now = vnAt(Y, 9, 18, 12, 0);
  const plan = planSurplusCapacity({
    now,
    dailyMaxMinutes: 480,
    dailyStudiedMinutes: 0,
    allowedDateRanges: [`18/09/${Y}-19/09/${Y}`],
    customTimeRules: [{ dates: `19/09/${Y}`, shifts: '07:00-10:00' }],
  });
  const tomorrow = plan.futureDays.find(d => d.date === `${Y}-09-19`);
  assert.equal(tomorrow.availableMinutes, 180, 'ca 07:00-10:00 = 3h, không phải 8h');
});

test('C2: nhiều ca cộng lại nhưng không vượt dailyMax', () => {
  const now = vnAt(Y, 9, 18, 0, 30);
  const plan = planSurplusCapacity({
    now,
    dailyMaxMinutes: 480,
    dailyStudiedMinutes: 0,
    allowedDateRanges: [`19/09/${Y}`],
    customTimeRules: [{ dates: `19/09/${Y}`, shifts: '07:00-11:30, 14:00-18:00' }],
  });
  assert.equal(plan.futureDays[0].availableMinutes, 480, '510 phút ca > 480 phút/ngày → 480');
});

test('C3: ca chồng lấn không bị đếm trùng', () => {
  const date = vnAt(Y, 9, 19, 12, 0);
  const minutes = schedulableMinutesForDate(date, {
    dailyMaxMinutes: 1440,
    customTimeRules: [{ dates: `19/09/${Y}`, shifts: '07:00-12:00, 10:00-15:00' }],
  });
  assert.equal(minutes, 480, '07:00-12:00 ∪ 10:00-15:00 = 07:00-15:00 = 8h');
});

test('C4: không ràng buộc lịch → năng lực = dailyMax', () => {
  const date = vnAt(Y, 9, 19, 12, 0);
  assert.equal(schedulableMinutesForDate(date, { dailyMaxMinutes: 480 }), 480);
});

// ── TEST CASE F: không vượt ngày được phép cuối cùng ──
test('F: chân trời là ngày được phép cuối cùng, không lấn sang ngày sau', () => {
  const now = vnAt(Y, 9, 20, 12, 0);
  const plan = planSurplusCapacity({
    now,
    dailyMaxMinutes: 480,
    dailyStudiedMinutes: 360,
    allowedDateRanges: [`18/09/${Y}-20/09/${Y}`],
  });
  assert.equal(plan.todayMinutes, 120);
  assert.equal(plan.futureDays.length, 0, 'không có ngày tương lai sau 20/09');
  assert.equal(plan.totalMinutes, 120);
  assert.equal(plan.horizonDate, `${Y}-09-20`);
});

// ── TEST CASE G: lịch rỗng → không bịa chân trời vô hạn ──
test('G: lịch ngày rỗng → chỉ dùng năng lực hôm nay', () => {
  const now = vnAt(Y, 9, 18, 12, 0);
  const plan = planSurplusCapacity({
    now,
    dailyMaxMinutes: 480,
    dailyStudiedMinutes: 300,
    allowedDateRanges: [],
  });
  assert.equal(plan.hasFiniteHorizon, false);
  assert.deepEqual(plan.futureDays, []);
  assert.equal(plan.totalMinutes, 180);
});

// ── TEST CASE D: tái phân bổ khi một khóa kiệt khẩu ──
test('D: phần chưa dùng của khóa kiệt khẩu được tái phân bổ cho các khóa còn lại', () => {
  const courses = ['c1', 'c2', 'c3', 'c4'].map(courseUrl => ({ courseUrl, confirmedMinutes: 0 }));
  const initial = allocateSurplusTargets(courses, 960);
  assert.deepEqual(initial, { c1: 240, c2: 240, c3: 240, c4: 240 });

  const afterExhaust = [
    { courseUrl: 'c2', confirmedMinutes: 0 },
    { courseUrl: 'c3', confirmedMinutes: 0 },
    { courseUrl: 'c4', confirmedMinutes: 0 },
  ];
  const redistributed = allocateSurplusTargets(afterExhaust, 960, { consumedMinutes: 60 });
  // 960 - 60 (đã xác nhận ở c1) = 900 → 300 mỗi khóa
  assert.deepEqual(redistributed, { c2: 300, c3: 300, c4: 300 });
});

test('D2: cap mỗi khóa giới hạn phân bổ nhưng không phá tổng phần còn lại', () => {
  const a = allocateSurplusTargets([
    { courseUrl: 'c1', confirmedMinutes: 0 },
    { courseUrl: 'c2', confirmedMinutes: 0 },
  ], 960, { maxPerCourseMinutes: 120 });
  assert.deepEqual(a, { c1: 120, c2: 120 });
});

test('D3: khóa đã confirmed giữ tiến độ khi chia lại', () => {
  const targets = allocateSurplusTargets([
    { courseUrl: 'c1', confirmedMinutes: 50 },
    { courseUrl: 'c2', confirmedMinutes: 0 },
  ], 200);
  assert.equal(targets.c1, 125, '50 đã làm + 75 chia thêm');
  assert.equal(targets.c2, 75);
});

test('D4: danh sách khóa rỗng → không target', () => {
  assert.deepEqual(allocateSurplusTargets([], 960), {});
});

// ── Khoảng thời gian ──
test('mergeIntervals gộp khoảng chồng lấn và giữ khoảng rời', () => {
  assert.deepEqual(
    mergeIntervals([{ start: 0, end: 100 }, { start: 50, end: 150 }, { start: 200, end: 240 }]),
    [{ start: 0, end: 150 }, { start: 200, end: 240 }]
  );
});

test('intersectIntervals trả giao đúng', () => {
  assert.deepEqual(
    intersectIntervals([{ start: 0, end: 100 }], [{ start: 50, end: 150 }]),
    [{ start: 50, end: 100 }]
  );
  assert.deepEqual(intersectIntervals([{ start: 0, end: 10 }], [{ start: 20, end: 30 }]), []);
});

test('totalIntervalMinutes đếm không trùng', () => {
  assert.equal(totalIntervalMinutes([{ start: 0, end: 100 }, { start: 50, end: 150 }]), 150);
});

test('remainingSchedulableMinutesToday: ngoài khung nhưng còn ca sau vẫn được tính', () => {
  const now = vnAt(Y, 9, 18, 12, 0); // 12:00, giữa 2 ca
  const remaining = remainingSchedulableMinutesToday(now, {
    customTimeRules: [{ dates: `18/09/${Y}`, shifts: '07:00-11:30, 14:00-18:00' }],
  });
  assert.equal(remaining, 240, 'còn ca 14:00-18:00 = 4h');
});

test('remainingSchedulableMinutesToday: không ràng buộc → Infinity', () => {
  assert.equal(remainingSchedulableMinutesToday(vnAt(Y, 9, 18, 12, 0), {}), Infinity);
});

test('latestAllowedDateKey lấy ngày cuối của range và ngày đơn', () => {
  const key = latestAllowedDateKey([`18/09/${Y}-20/09/${Y}`, `25/09/${Y}`]);
  assert.equal(key, Y * 10000 + 9 * 100 + 25);
});

test('latestAllowedDateKey rỗng → null', () => {
  assert.equal(latestAllowedDateKey([]), null);
  assert.equal(latestAllowedDateKey(undefined), null);
});

test('enumerateAllowedStudyDates bỏ ngày nghỉ và dừng ở chân trời', () => {
  const now = vnAt(Y, 9, 18, 12, 0);
  const dates = enumerateAllowedStudyDates(now, [`18/09/${Y}-20/09/${Y}`]).map(d => d.toISOString());
  assert.equal(dates.length, 2, 'chỉ 19 và 20 (không tính hôm nay)');
});

// ── Chuẩn hoá tham số an toàn ──
test('normalizeSurplusOptions: mặc định đúng', () => {
  const o = normalizeSurplusOptions({});
  assert.equal(o.surplusStrategy, 'schedule');
  assert.equal(o.surplusMinBlockMinutes, SURPLUS_DEFAULTS.surplusMinBlockMinutes);
  assert.equal(o.surplusMaxUnconfirmedAttempts, SURPLUS_DEFAULTS.surplusMaxUnconfirmedAttempts);
  assert.equal(o.courseDiscoveryRetryMinutes, SURPLUS_DEFAULTS.courseDiscoveryRetryMinutes);
  assert.equal(o.postTargetGraceMinutes, SURPLUS_DEFAULTS.postTargetGraceMinutes);
  assert.equal(o.surplusMaxPerCourseMinutes, null);
});

test('normalizeSurplusOptions: kẹp giá trị vô lý', () => {
  const o = normalizeSurplusOptions({
    surplusMinBlockMinutes: NaN,
    surplusMaxUnconfirmedAttempts: -5,
    courseDiscoveryRetryMinutes: Infinity,
    postTargetGraceMinutes: 999,
    surplusMaxPerCourseMinutes: '0',
    surplusStrategy: 'legacy-random',
  });
  assert.equal(o.surplusMinBlockMinutes, 5);
  assert.equal(o.surplusMaxUnconfirmedAttempts, 1, 'kẹp min 1');
  assert.equal(o.courseDiscoveryRetryMinutes, 10);
  assert.equal(o.postTargetGraceMinutes, 30, 'kẹp max');
  assert.equal(o.surplusMaxPerCourseMinutes, null, '0/âm → null');
  assert.equal(o.surplusStrategy, 'legacy-random');
});

test('normalizeSurplusOptions: cap hợp lệ được giữ', () => {
  const o = normalizeSurplusOptions({ surplusMaxPerCourseMinutes: 120 });
  assert.equal(o.surplusMaxPerCourseMinutes, 120);
});

test('normalizeSurplusOptions: chiến lược lạ → mặc định schedule', () => {
  assert.equal(normalizeSurplusOptions({ surplusStrategy: 'hack' }).surplusStrategy, 'schedule');
});

test('surplusTargetBounds: legacy giữ 15-60, schedule nới rộng', () => {
  assert.deepEqual(surplusTargetBounds({ surplusStrategy: 'legacy-random' }), {
    minTargetMinutes: 15,
    maxTargetMinutes: 60,
  });
  assert.equal(surplusTargetBounds({}).minTargetMinutes, 1);
  assert.ok(surplusTargetBounds({}).maxTargetMinutes > 60);
  assert.equal(surplusTargetBounds({ surplusMaxPerCourseMinutes: 120 }).maxTargetMinutes, 120);
});
