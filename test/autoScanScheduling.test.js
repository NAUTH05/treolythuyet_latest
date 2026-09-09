const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseTimeToMinutes,
  getWindowDurationMinutes,
  assignDistributedStartTimes,
} = require('../autoScanScheduling');
const { LoginLimiter, AutoCourseSession } = require('../autoCourseEngine');
const { getPersistentAutoCourseOptions } = require('../autoCourseEngine');

test('legacy fixed-time options migrate without enabling random startup', () => {
  const options = getPersistentAutoCourseOptions({ newDayStartTime: '06:00' });
  assert.equal(options.newDayStartTime, '06:00');
  assert.equal(options.randomStartEnabled, false);
  assert.equal(options.scheduledStartAt, null);
});

test('fixed and custom windows accept minute-level ranges including midnight crossing', () => {
  assert.equal(parseTimeToMinutes('06:00'), 360);
  assert.equal(getWindowDurationMinutes('06:00', '06:10'), 10);
  assert.equal(getWindowDurationMinutes('06:00', '07:00'), 60);
  assert.equal(getWindowDurationMinutes('23:30', '00:15'), 45);
});

test('stratified assignment spreads accounts across the configured window', () => {
  const assignments = assignDistributedStartTimes(
    Array.from({ length: 10 }, (_, i) => `account-${i}`),
    '06:00',
    '06:30',
    { now: Date.parse('2026-09-09T00:00:00.000Z'), rng: (() => { let n = 0; return () => ((n++ * 37) % 100) / 100; })() },
  );
  assert.equal(assignments.length, 10);
  const times = assignments.map(item => Date.parse(item.scheduledStartAt)).sort((a, b) => a - b);
  assert.equal(new Set(times).size, 10);
  assert.ok(times[0] >= Date.parse('2026-09-08T23:00:00.000Z'));
  assert.ok(times.at(-1) <= Date.parse('2026-09-08T23:30:00.000Z'));
  assert.ok(times.at(-1) - times[0] > 20 * 60 * 1000);
});

test('login limiter caps concurrent attempts and releases on failure', async () => {
  const limiter = new LoginLimiter(3);
  let active = 0;
  let maxActive = 0;
  await Promise.all(Array.from({ length: 20 }, async () => {
    assert.equal(await limiter.acquire(), true);
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    limiter.release();
  }));
  assert.equal(maxActive, 3);
  assert.equal(limiter.active, 0);
  assert.equal(limiter.pending, 0);
});

test('stopped queued login owner is cancelled without consuming a slot', async () => {
  const limiter = new LoginLimiter(1);
  const owner = new AutoCourseSession('queued', { name: 'Queued' });
  await limiter.acquire();
  const pending = limiter.acquire(owner);
  owner._stopped = true;
  limiter.cancel(owner);
  assert.equal(await pending, false);
  limiter.release();
  assert.equal(limiter.active, 0);
});
