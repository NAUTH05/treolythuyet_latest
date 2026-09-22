// ============================================================
//  ACCOUNT COMPLETION & AUTO-SCAN MATCHING (hàm thuần, UI + test)
// ============================================================
// Ba trạng thái hiển thị của một tài khoản trong bộ chọn Auto-Scan:
//
//   completed  ✓  admin đã đánh dấu hoàn thành THỦ CÔNG (account.completed)
//   active     ●  đang có phiên Auto-Scan chạy / tạm dừng / đang chờ lịch
//   incomplete ○  còn lại
//
// Thứ tự ưu tiên: completed > active > incomplete.
//
// `account.completed` là NGUỒN CHÂN LÝ duy nhất cho trạng thái hoàn thành — nó
// không bao giờ được suy ra từ tiến độ AutoCourse/Auto-Scan. Vì vậy tài khoản đã
// đánh dấu hoàn thành vẫn hiển thị "hoàn thành" kể cả khi không còn phiên nào.

export const ACCOUNT_STATE_COMPLETED = 'completed';
export const ACCOUNT_STATE_ACTIVE = 'active';
export const ACCOUNT_STATE_INCOMPLETE = 'incomplete';

// Trạng thái phiên được coi là "đang học / đã lên lịch". Khớp ACTIVE_STATUSES +
// SCHEDULED_STATUSES + paused của Dashboard, nhưng KHÔNG gồm completed/stopped/
// error (phiên đã kết thúc thì không còn là "đang học").
export const ACCOUNT_LEARNING_STATUSES = new Set([
  'idle', 'logging-in', 'scanning', 'studying', 'surplus-study', 'paused',
  'scheduled-start', 'date-limit', 'daily-limit', 'time-window', 'next-day', 'discovery-retry',
]);

export const ACCOUNT_STATE_LABELS = {
  completed: '✓ Hoàn thành',
  active: '● Đang học / đã lên lịch',
  incomplete: '○ Chưa hoàn thành',
};

export function isAccountCompleted(account) {
  return Boolean(account) && account.completed === true;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

// Ghép một phiên Auto-Scan với tài khoản:
//   1. Ưu tiên email (`accountEmail` trong payload trạng thái).
//   2. Chỉ lùi về tên hiển thị cho payload CŨ/khôi phục không có `accountEmail`.
// Không so tên khi phiên đã có email khác: hai tài khoản khác nhau có thể trùng
// tên hiển thị, so tên lúc đó sẽ gán nhầm phiên.
export function matchAutoScan(account, autoScans = []) {
  const list = Array.isArray(autoScans) ? autoScans.filter(Boolean) : [];
  const email = normalizeEmail(account && account.email);
  if (email) {
    const byEmail = list.find(scan => normalizeEmail(scan.accountEmail) === email);
    if (byEmail) return byEmail;
  }
  const name = normalizeName(account && account.name);
  if (!name) return null;
  return list.find(scan => !scan.accountEmail && normalizeName(scan.account) === name) || null;
}

// Trạng thái hiển thị của một tài khoản trong bộ chọn Auto-Scan.
export function accountScanState(account, autoScans = []) {
  if (isAccountCompleted(account)) return ACCOUNT_STATE_COMPLETED;
  const scan = matchAutoScan(account, autoScans);
  if (scan && ACCOUNT_LEARNING_STATUSES.has(scan.status)) return ACCOUNT_STATE_ACTIVE;
  return ACCOUNT_STATE_INCOMPLETE;
}

export function accountStateLabel(state) {
  return ACCOUNT_STATE_LABELS[state] || ACCOUNT_STATE_LABELS.incomplete;
}

// Hậu tố class CSS cho chip (chip-completed / chip-learning / chip-incomplete).
export function accountStateClass(state) {
  if (state === ACCOUNT_STATE_COMPLETED) return 'chip-completed';
  if (state === ACCOUNT_STATE_ACTIVE) return 'chip-learning';
  return 'chip-incomplete';
}

// Ký hiệu ngắn đứng trước tên tài khoản trong chip.
export function accountStateMark(state) {
  if (state === ACCOUNT_STATE_COMPLETED) return '✓';
  if (state === ACCOUNT_STATE_ACTIVE) return '●';
  return '○';
}
