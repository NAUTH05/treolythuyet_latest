const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

function parseTimeToMinutes(value, fallback = null) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return fallback;
  }
  return hours * 60 + minutes;
}

function formatTime(minutes, includeSeconds = false) {
  const total = Math.max(0, Math.floor(Number(minutes) || 0));
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}${includeSeconds ? `:${String(Math.floor((Number(minutes) * 60) % 60)).padStart(2, '0')}` : ''}`;
}

function getWindowDurationMinutes(start, end) {
  const startMinutes = parseTimeToMinutes(start);
  const endMinutes = parseTimeToMinutes(end);
  if (startMinutes == null || endMinutes == null) return null;
  let duration = endMinutes - startMinutes;
  if (duration <= 0) duration += 24 * 60;
  return duration;
}

function vnDateParts(date = new Date()) {
  const shifted = new Date(date.getTime() + VN_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

function operatingWindow(date, start, end) {
  const startMinutes = parseTimeToMinutes(start);
  const durationMinutes = getWindowDurationMinutes(start, end);
  if (startMinutes == null || durationMinutes == null) return null;
  const p = typeof date === 'string'
    ? (() => { const [year, month, day] = date.split('-').map(Number); return { year, month: month - 1, day }; })()
    : vnDateParts(date);
  const startAt = new Date(Date.UTC(p.year, p.month, p.day, 0, startMinutes, 0, 0) - VN_OFFSET_MS);
  return { startAt, endAt: new Date(startAt.getTime() + durationMinutes * 60000), durationMs: durationMinutes * 60000 };
}

function shuffle(values, rng = Math.random) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.max(0, Math.min(i, Math.floor(rng() * (i + 1))));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Stratified assignment: each account gets one sub-window, while the shuffled
// order decorrelates account identity from the first/last slot each day.
function assignDistributedStartTimes(accounts, start, end, { rng = Math.random, now = Date.now(), date = null } = {}) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (!list.length) return [];
  const window = operatingWindow(date || new Date(now), start, end);
  if (!window) throw new Error('Khung giờ bắt đầu không hợp lệ');
  const order = shuffle(list.map((_, index) => index), rng);
  return order.map((accountIndex, slot) => {
    const slotStart = window.startAt.getTime() + Math.floor(slot * window.durationMs / list.length);
    const slotEnd = window.startAt.getTime() + Math.floor((slot + 1) * window.durationMs / list.length);
    const span = Math.max(1, slotEnd - slotStart);
    const at = slotStart + Math.floor(rng() * span);
    return { accountIndex, scheduledStartAt: new Date(at).toISOString() };
  });
}

module.exports = {
  parseTimeToMinutes,
  formatTime,
  getWindowDurationMinutes,
  operatingWindow,
  shuffle,
  assignDistributedStartTimes,
};
