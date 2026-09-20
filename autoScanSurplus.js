// ============================================================
//  AUTO-SCAN SURPLUS CAPACITY PLANNER (pure helpers)
// ============================================================
// Triết lý surplus mới: sau khi MỌI khóa hiện tại đã Completed cấp website,
// dùng phần năng lực học còn lại (hợp pháp) trước khi hết lịch, chia ĐỀU cho
// các khóa còn dùng được. KHÔNG còn mục tiêu random 15–60 mặc định.
//
// Bất biến quan trọng:
//   - Năng lực học là PER-DAY. Thời gian dư của một ngày KHÔNG BAO GIỜ được
//     cộng dồn sang ngày khác. Mỗi bucket gắn chặt với ngày của nó.
//   - Tổng năng lực chỉ dùng cho HIỂN THỊ / chia fair-share; khi chạy vẫn bị
//     giới hạn bởi bucket của ngày hiện tại (dailyMaxMinutes + khung giờ/ca).
//   - allowedDateRanges rỗng ⇒ KHÔNG có chân trời hữu hạn ⇒ chỉ dùng năng lực
//     hợp pháp còn lại của HÔM NAY.
//
// Module thuần (không I/O, không Playwright) để unit-test dễ dàng.

'use strict';

const { getShiftsForDate, isAllowedStudyDate, parseVNShortDate } = require('./courseScanner');

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const DEFAULT_DAILY_MAX_MINUTES = 480;
const MAX_PLAN_HORIZON_DAYS = 366;

// ── Default cho các tham số vận hành an toàn (mở ở Cài đặt nâng cao) ──
const SURPLUS_DEFAULTS = Object.freeze({
  surplusStrategy: 'schedule', // 'schedule' = năng lực còn lại | 'legacy-random' = 15-60 cũ
  surplusMinBlockMinutes: 5,
  surplusMaxUnconfirmedAttempts: 2,
  courseDiscoveryRetryMinutes: 10,
  postTargetGraceMinutes: 5,
  surplusMaxPerCourseMinutes: null, // null = không giới hạn nhân tạo
});

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  return Math.min(max, Math.max(min, rounded));
}

function positiveInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Chuẩn hoá các tham số nâng cao. Chịu được document cũ thiếu trường, giá trị
// NaN/Infinity/âm, chuỗi số. Đây là lớp phòng thủ phía server (không tin FE).
function normalizeSurplusOptions(options = {}) {
  const strategy = options.surplusStrategy === 'legacy-random' ? 'legacy-random' : 'schedule';
  return {
    surplusStrategy: strategy,
    surplusMinBlockMinutes: clampInt(
      options.surplusMinBlockMinutes, 1, 60, SURPLUS_DEFAULTS.surplusMinBlockMinutes
    ),
    surplusMaxUnconfirmedAttempts: clampInt(
      options.surplusMaxUnconfirmedAttempts, 1, 10, SURPLUS_DEFAULTS.surplusMaxUnconfirmedAttempts
    ),
    courseDiscoveryRetryMinutes: clampInt(
      options.courseDiscoveryRetryMinutes, 1, 120, SURPLUS_DEFAULTS.courseDiscoveryRetryMinutes
    ),
    postTargetGraceMinutes: clampInt(
      options.postTargetGraceMinutes, 0, 30, SURPLUS_DEFAULTS.postTargetGraceMinutes
    ),
    surplusMaxPerCourseMinutes: options.surplusMaxPerCourseMinutes == null
      || options.surplusMaxPerCourseMinutes === ''
      ? null
      : positiveInt(options.surplusMaxPerCourseMinutes, 1, 24 * 60),
  };
}

// Khoảng giá trị hợp lệ cho targetMinutes per-course theo chiến lược hiện tại.
// Legacy giữ nguyên 15-60 để tương thích document cũ; schedule cho phép target
// lớn hơn (nhiều giờ) vì là phân bổ năng lực nhiều ngày.
function surplusTargetBounds(options = {}) {
  const normalized = normalizeSurplusOptions(options);
  if (normalized.surplusStrategy === 'legacy-random') {
    return { minTargetMinutes: 15, maxTargetMinutes: 60 };
  }
  const maxPerCourse = normalized.surplusMaxPerCourseMinutes;
  return {
    minTargetMinutes: 1,
    maxTargetMinutes: maxPerCourse != null ? maxPerCourse : 24 * 60 * MAX_PLAN_HORIZON_DAYS,
  };
}

// ── Lịch Việt Nam (UTC+7 cố định) ──
function vnDateParts(date = new Date()) {
  const shifted = new Date(date.getTime() + VN_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

function dateKey(year, month, day) {
  return year * 10000 + (month + 1) * 100 + day;
}

function vnDateKey(date = new Date()) {
  const p = vnDateParts(date);
  return dateKey(p.year, p.month, p.day);
}

function vnDateISO(date = new Date()) {
  const p = vnDateParts(date);
  const mm = String(p.month + 1).padStart(2, '0');
  const dd = String(p.day).padStart(2, '0');
  return `${p.year}-${mm}-${dd}`;
}

// Thời điểm UTC của 00:00 giờ VN ngày (y,m,d). Dùng Date.UTC để tự xử lý tràn.
function vnDayMoment(year, month, day, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, month, day, hour, minute, 0, 0) - VN_OFFSET_MS);
}

function vnMinutesOfDay(date = new Date()) {
  const shifted = new Date(date.getTime() + VN_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

// ── Khoảng thời gian trong ngày (phút) ──
function parseShiftIntervals(shifts = []) {
  const out = [];
  for (const s of shifts) {
    if (!s) continue;
    const start = Number(s.startMins);
    const end = Number(s.endMins);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    out.push({ start, end });
  }
  return out;
}

function parseWindowIntervals(timeWindows = []) {
  const out = [];
  for (const w of timeWindows || []) {
    if (!w) continue;
    const [sh, sm] = String(w.start || '').split(':').map(Number);
    const [eh, em] = String(w.end || '').split(':').map(Number);
    if ([sh, sm, eh, em].some(n => !Number.isFinite(n))) continue;
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    if (end <= start) continue;
    out.push({ start, end });
  }
  return out;
}

function sortIntervals(intervals) {
  return [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
}

// Gộp các khoảng chồng lấn để tránh đếm trùng ca/khung giờ.
function mergeIntervals(intervals = []) {
  const sorted = sortIntervals(intervals);
  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  return merged;
}

function intersectIntervals(a = [], b = []) {
  const left = mergeIntervals(a);
  const right = mergeIntervals(b);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const start = Math.max(left[i].start, right[j].start);
    const end = Math.min(left[i].end, right[j].end);
    if (end > start) out.push({ start, end });
    if (left[i].end < right[j].end) i++;
    else j++;
  }
  return out;
}

function totalIntervalMinutes(intervals = []) {
  return mergeIntervals(intervals).reduce((sum, iv) => sum + Math.max(0, iv.end - iv.start), 0);
}

function remainingIntervalMinutes(intervals = [], fromMins = 0) {
  return mergeIntervals(intervals).reduce(
    (sum, iv) => sum + Math.max(0, iv.end - Math.max(fromMins, iv.start)),
    0
  );
}

// Khoảng giờ được phép học trong một ngày = ca học của ngày đó ∩ khung giờ chung.
// Trả null khi KHÔNG có ràng buộc nào (học cả ngày).
function allowedIntervalsForDate(date, { customTimeRules = [], timeWindows = [] } = {}) {
  const shifts = getShiftsForDate(date, customTimeRules) || [];
  const shiftIntervals = shifts.length > 0 ? parseShiftIntervals(shifts) : null;
  const windowIntervals = (timeWindows && timeWindows.length > 0)
    ? parseWindowIntervals(timeWindows)
    : null;

  if (shiftIntervals && windowIntervals) return intersectIntervals(shiftIntervals, windowIntervals);
  if (shiftIntervals) return mergeIntervals(shiftIntervals);
  if (windowIntervals) return mergeIntervals(windowIntervals);
  return null;
}

// Năng lực học tối đa của MỘT ngày (đã bị chặn bởi dailyMaxMinutes + lịch).
function schedulableMinutesForDate(date, {
  dailyMaxMinutes = DEFAULT_DAILY_MAX_MINUTES,
  customTimeRules = [],
  timeWindows = [],
} = {}) {
  const dailyMax = Math.max(0, Math.round(Number(dailyMaxMinutes) || DEFAULT_DAILY_MAX_MINUTES));
  const allowed = allowedIntervalsForDate(date, { customTimeRules, timeWindows });
  if (allowed === null) return dailyMax;
  return Math.max(0, Math.min(dailyMax, totalIntervalMinutes(allowed)));
}

// Năng lực hợp pháp còn lại của HÔM NAY tính từ thời điểm `now`.
// Trả về số phút; Infinity khi không có ràng buộc lịch nào.
function remainingSchedulableMinutesToday(now, { customTimeRules = [], timeWindows = [] } = {}) {
  const allowed = allowedIntervalsForDate(now, { customTimeRules, timeWindows });
  if (allowed === null) return Infinity;
  return Math.max(0, remainingIntervalMinutes(allowed, vnMinutesOfDay(now)));
}

// Ngày được phép học CUỐI CÙNG (theo allowedDateRanges). null nếu rỗng.
function latestAllowedDateKey(allowedRanges = []) {
  if (!Array.isArray(allowedRanges) || allowedRanges.length === 0) return null;
  let maxKey = null;
  for (const item of allowedRanges) {
    if (!item) continue;
    const str = String(item).trim();
    if (!str) continue;
    const ends = str.includes('-') ? [str.split('-')[1]] : [str];
    for (const endStr of ends) {
      const parsed = parseVNShortDate(endStr);
      if (!parsed) continue;
      const key = dateKey(parsed.year, parsed.month, parsed.day);
      if (maxKey === null || key > maxKey) maxKey = key;
    }
  }
  return maxKey;
}

// Liệt kê các ngày được phép học SAU hôm nay (theo lịch VN), tăng dần, tối đa
// `maxDays` ngày. Dừng khi vượt ngày được phép cuối cùng.
function enumerateAllowedStudyDates(now, allowedRanges = [], { maxDays = MAX_PLAN_HORIZON_DAYS } = {}) {
  const horizonKey = latestAllowedDateKey(allowedRanges);
  if (horizonKey === null) return [];
  const today = vnDateParts(now);
  const todayKey = dateKey(today.year, today.month, today.day);
  const out = [];
  for (let i = 1; i <= maxDays; i++) {
    const candidate = vnDayMoment(today.year, today.month, today.day + i, 12, 0);
    const p = vnDateParts(candidate);
    const key = dateKey(p.year, p.month, p.day);
    if (key > horizonKey) break;
    if (!isAllowedStudyDate(candidate, allowedRanges)) continue;
    out.push(candidate);
  }
  return out;
}

// ── Kế hoạch năng lực surplus ──
// Mỗi bucket vẫn thuộc về ngày của nó; `totalMinutes` chỉ để chia fair-share.
function planSurplusCapacity({
  now = new Date(),
  dailyMaxMinutes = DEFAULT_DAILY_MAX_MINUTES,
  dailyStudiedMinutes = 0,
  allowedDateRanges = [],
  customTimeRules = [],
  timeWindows = [],
  maxFutureDays = MAX_PLAN_HORIZON_DAYS,
} = {}) {
  const dailyMax = Math.max(0, Math.round(Number(dailyMaxMinutes) || DEFAULT_DAILY_MAX_MINUTES));
  const studied = Math.max(0, Number(dailyStudiedMinutes) || 0);
  const dailyRemaining = Math.max(0, dailyMax - studied);

  const schedToday = remainingSchedulableMinutesToday(now, { customTimeRules, timeWindows });
  const todayMinutes = Math.max(
    0,
    Math.floor(schedToday === Infinity ? dailyRemaining : Math.min(dailyRemaining, schedToday))
  );

  const dates = enumerateAllowedStudyDates(now, allowedDateRanges, { maxDays: maxFutureDays });
  const futureDays = dates.map(date => ({
    date: vnDateISO(date),
    availableMinutes: schedulableMinutesForDate(date, { dailyMaxMinutes: dailyMax, customTimeRules, timeWindows }),
  }));
  const futureTotalMinutes = futureDays.reduce((sum, d) => sum + d.availableMinutes, 0);

  const hasFiniteHorizon = Array.isArray(allowedDateRanges) && allowedDateRanges.length > 0;

  return {
    todayMinutes,
    dailyRemainingMinutes: dailyRemaining,
    dailyMaxMinutes: dailyMax,
    futureDays,
    futureTotalMinutes,
    totalMinutes: todayMinutes + futureTotalMinutes,
    hasFiniteHorizon,
    horizonDate: hasFiniteHorizon ? vnDateISO(dates[dates.length - 1] || now) : null,
    allowedDateCount: futureDays.length + (hasFiniteHorizon ? 1 : 0),
  };
}

// Chia ĐỀU năng lực còn lại cho các khóa "dùng được". Không random, không
// reservation cứng: gọi lại sau mỗi lần một khóa kiệt khẩu để TÁI PHÂN BỔ.
// `courses`: [{ courseUrl, confirmedMinutes }] — ĐÃ lọc bỏ khóa completed/exhausted.
// `consumedMinutes`: tổng phút ĐÃ xác nhận của MỌI khóa (kể cả khóa đã xong) khi
// chia lại — để phần đã dùng không bị phân bổ lại lần hai.
function allocateSurplusTargets(courses = [], totalMinutes = 0, {
  maxPerCourseMinutes = null,
  consumedMinutes = null,
} = {}) {
  const targets = {};
  const remaining = courses.filter(c => c && c.courseUrl);
  if (remaining.length === 0) return targets;

  const consumed = consumedMinutes == null
    ? remaining.reduce((sum, c) => sum + Math.max(0, Number(c.confirmedMinutes) || 0), 0)
    : Math.max(0, Number(consumedMinutes) || 0);
  const capacityLeft = Math.max(0, Math.floor(Number(totalMinutes) || 0) - consumed);
  const n = remaining.length;
  const base = Math.floor(capacityLeft / n);
  const remainder = capacityLeft - base * n;
  const cap = maxPerCourseMinutes == null ? null : Math.max(1, Math.round(Number(maxPerCourseMinutes)));

  remaining.forEach((course, index) => {
    let share = base + (index < remainder ? 1 : 0);
    if (cap != null) share = Math.min(share, cap);
    const confirmed = Math.max(0, Number(course.confirmedMinutes) || 0);
    targets[course.courseUrl] = Math.max(0, Math.round(confirmed + share));
  });
  return targets;
}

module.exports = {
  SURPLUS_DEFAULTS,
  MAX_PLAN_HORIZON_DAYS,
  DEFAULT_DAILY_MAX_MINUTES,
  normalizeSurplusOptions,
  surplusTargetBounds,
  vnDateParts,
  vnDateKey,
  vnDateISO,
  vnDayMoment,
  vnMinutesOfDay,
  parseShiftIntervals,
  parseWindowIntervals,
  mergeIntervals,
  intersectIntervals,
  totalIntervalMinutes,
  remainingIntervalMinutes,
  allowedIntervalsForDate,
  schedulableMinutesForDate,
  remainingSchedulableMinutesToday,
  latestAllowedDateKey,
  enumerateAllowedStudyDates,
  planSurplusCapacity,
  allocateSurplusTargets,
};
