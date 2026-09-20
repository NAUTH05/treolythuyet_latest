const test = require('node:test');
const assert = require('node:assert/strict');
const { AutoCourseSession, getPersistentAutoCourseOptions } = require('../autoCourseEngine');
const { applyAutoScanRestoreState } = require('../autoScanRecovery');
const { normalizeSurplusOptions, SURPLUS_DEFAULTS } = require('../autoScanSurplus');

test('getPersistentAutoCourseOptions: preset/document cũ thiếu trường → default an toàn', () => {
  const opts = getPersistentAutoCourseOptions({ dailyMaxMinutes: 480, allowedDateRanges: ['18/09'] });
  assert.equal(opts.surplusStrategy, 'schedule');
  assert.equal(opts.surplusMinBlockMinutes, SURPLUS_DEFAULTS.surplusMinBlockMinutes);
  assert.equal(opts.surplusMaxUnconfirmedAttempts, SURPLUS_DEFAULTS.surplusMaxUnconfirmedAttempts);
  assert.equal(opts.courseDiscoveryRetryMinutes, SURPLUS_DEFAULTS.courseDiscoveryRetryMinutes);
  assert.equal(opts.postTargetGraceMinutes, SURPLUS_DEFAULTS.postTargetGraceMinutes);
  assert.equal(opts.surplusMaxPerCourseMinutes, null);
  // Các trường cũ vẫn nguyên
  assert.equal(opts.dailyMaxMinutes, 480);
  assert.deepEqual(opts.allowedDateRanges, ['18/09']);
});

test('getPersistentAutoCourseOptions: giá trị hợp lệ được giữ để sống qua restart', () => {
  const opts = getPersistentAutoCourseOptions({
    surplusStrategy: 'legacy-random',
    surplusMinBlockMinutes: 7,
    surplusMaxUnconfirmedAttempts: 4,
    courseDiscoveryRetryMinutes: 25,
    postTargetGraceMinutes: 10,
    surplusMaxPerCourseMinutes: 120,
  });
  assert.equal(opts.surplusStrategy, 'legacy-random');
  assert.equal(opts.surplusMinBlockMinutes, 7);
  assert.equal(opts.surplusMaxUnconfirmedAttempts, 4);
  assert.equal(opts.courseDiscoveryRetryMinutes, 25);
  assert.equal(opts.postTargetGraceMinutes, 10);
  assert.equal(opts.surplusMaxPerCourseMinutes, 120);
});

test('session với preset cũ (không có trường surplus mới) chạy được, default schedule', () => {
  const session = new AutoCourseSession('legacy-preset', { name: 'L' }, [], { dailyMaxMinutes: 480 });
  assert.equal(session.surplusOptions.surplusStrategy, 'schedule');
  assert.equal(session.surplusOptions.postTargetGraceMinutes, 5);
});

test('schedule giữ target lớn; legacy-random kẹp 15-60', () => {
  const states = { 'https://x/c1': { targetMinutes: 300, confirmedMinutes: 10 } };
  const scheduled = new AutoCourseSession('s', { name: 'S' }, [], {
    surplusStrategy: 'schedule',
    surplusCourseStates: states,
  });
  assert.equal(scheduled.surplusCourseStates['https://x/c1'].targetMinutes, 300);
  assert.equal(scheduled.surplusCourseStates['https://x/c1'].confirmedMinutes, 10);

  const legacy = new AutoCourseSession('l', { name: 'L' }, [], {
    surplusStrategy: 'legacy-random',
    surplusCourseStates: states,
  });
  assert.equal(legacy.surplusCourseStates['https://x/c1'].targetMinutes, 60);
});

test('restore sau restart giữ target schedule (không kẹp 60)', () => {
  const session = new AutoCourseSession('r', { name: 'R' }, [], { surplusStrategy: 'schedule' });
  applyAutoScanRestoreState(session, {
    surplusMode: true,
    surplusCourseStates: { 'https://x/c1': { targetMinutes: 480, confirmedMinutes: 200 } },
    surplusCurrentCourseIndex: 0,
  });
  assert.equal(session.surplusMode, true);
  assert.equal(session.surplusCourseStates['https://x/c1'].targetMinutes, 480);
  assert.equal(session.surplusCourseStates['https://x/c1'].confirmedMinutes, 200);
});

test('restore document cũ (target RNG nhỏ) không seed confirmedMinutes', () => {
  const session = new AutoCourseSession('r2', { name: 'R2' }, [], { surplusStrategy: 'schedule' });
  applyAutoScanRestoreState(session, {
    surplusTargetMinutes: 37,
    surplusStudiedMinutes: 12,
    surplusCourseStates: { 'https://x/c1': { targetMinutes: 37 } },
  });
  assert.equal(session.surplusCourseStates['https://x/c1'].targetMinutes, 37);
  assert.equal(session.surplusCourseStates['https://x/c1'].confirmedMinutes, 0);
});

test('preset config có courses=[] hợp lệ về mặt chuẩn hoá tham số', () => {
  // Khóa học thủ công là tuỳ chọn; chỉ tham số nâng cao cần chuẩn hoá.
  const o = normalizeSurplusOptions({ surplusStrategy: 'schedule', courses: [] });
  assert.equal(o.surplusStrategy, 'schedule');
});
