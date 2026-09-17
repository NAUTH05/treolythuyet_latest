// ============================================================
//  AUTO-SCAN START FLOW
//  Logic thuần cho endpoint POST /api/auto-scan/start:
//    - phân giải tài khoản được chọn (account index mapping)
//    - phân loại phiên Auto-Scan hiện có: "blocker sống" hay "xác chết"
//    - dựng kế hoạch start (skip / start / cleanup+start)
//    - chuẩn hoá response { ok, result, started, skipped, unresolved }
//
//  Tách khỏi server.js (tự listen cổng, không require được trong test) để các
//  bất biến chống trùng phiên / chống deadlock có unit test thật.
//
//  BẤT BIẾN: KHÔNG dùng mỗi `!TERMINAL_STATUSES.has(status)` làm bằng chứng một
//  phiên còn sống. Phải dựa vào vòng đời thật của engine (0c3cc1a):
//    - phase running / ownsAccountSession()  → đang chạy
//    - status 'paused'                        → người dùng chủ động giữ
//    - nextRunTime còn ở tương lai            → đang chờ tới lịch hẹn
//    - có phiên khác ĐANG sống giữ tài khoản  → không được đụng vào
//  Còn lại (status không terminal nhưng không chạy, không lịch tương lai)
//  là phiên mồ côi / lịch quá hạn → dọn được, không được chặn start mãi mãi.
// ============================================================

const { SCHEDULED_STATUSES, TERMINAL_STATUSES, SCHEDULED_START_STATUS, PHASE_RUNNING } = require('./autoCourseEngine');

// Chuẩn hoá một "khoá tài khoản" về number nếu là số (kể cả chuỗi số), ngược lại
// giữ nguyên chuỗi đã trim. Nhờ vậy 7 và "7" được coi là cùng một tài khoản.
function normalizeAccountKey(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const trimmed = String(value).trim();
  if (trimmed === '') return null;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : trimmed;
}

// Bỏ trùng nhưng phân biệt number/string một cách an toàn sau chuẩn hoá.
function dedupeRequestedKeys(keys) {
  const seen = new Set();
  const out = [];
  for (const key of keys) {
    if (key === null) continue;
    const token = `${typeof key}:${key}`;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(key);
  }
  return out;
}

// ============================================================
//  PHÂN GIẢI TÀI KHOẢN
//  Frontend gửi `acc.index`. Backend cũ giả định index === vị trí + 1 và tra
//  `allAccounts[idx - 1]`. Giả định đó chỉ đúng khi mọi tài khoản không có
//  trường index ổn định riêng. Nếu tài khoản mang `index` (kể cả lệch vị trí),
//  phải ưu tiên trường đó và KHÔNG fallback vị trí (tránh trỏ nhầm tài khoản).
// ============================================================
function accountHasStableIndex(account) {
  return Boolean(account) && account.index !== null && account.index !== undefined && account.index !== '';
}

function resolveRequestedAccounts(allAccounts, requestedIndices) {
  const accounts = Array.isArray(allAccounts) ? allAccounts : [];
  const requested = dedupeRequestedKeys(
    (Array.isArray(requestedIndices) ? requestedIndices : []).map(normalizeAccountKey),
  );
  const anyStableIndex = accounts.some(accountHasStableIndex);

  const resolved = [];
  const unresolved = [];

  for (const key of requested) {
    let account = null;
    const numeric = typeof key === 'number' ? key : Number(key);

    if (anyStableIndex) {
      account = accounts.find(a => accountHasStableIndex(a) && normalizeAccountKey(a.index) === key) || null;
    } else if (Number.isInteger(numeric) && numeric >= 1) {
      account = accounts[numeric - 1] || null;
    }

    if (!account && typeof key === 'string') {
      account = accounts.find(a => a && (a.email === key || a.name === key)) || null;
    }

    if (account) resolved.push({ account, requested: key });
    else unresolved.push(key);
  }

  return { resolved, unresolved };
}

// ============================================================
//  PHÂN LOẠI PHIÊN
// ============================================================
function isAutoScanSessionActive(session) {
  if (!session) return false;
  if (typeof session.ownsAccountSession === 'function') {
    try {
      return session.ownsAccountSession() === true;
    } catch {
      return false;
    }
  }
  return session._phase === PHASE_RUNNING;
}

function hasFutureNextRun(session, now) {
  const raw = session && session.nextRunTime;
  if (!raw) return false;
  const at = new Date(raw).getTime();
  return Number.isFinite(at) && at > now;
}

// Đưa một phiên MỚI (phase vẫn PHASE_NEW) sang trạng thái `scheduled-start`.
// KHÔNG chạm tới `_phase`/`start()`: engine chỉ thực sự chạy khi timer nổ.
// Trả về true nếu lịch còn ở tương lai (đủ ngưỡng an toàn) và đã áp dụng.
function applyScheduledStart(session, scheduledAt, { now = Date.now(), thresholdMs = 500 } = {}) {
  if (!session) return false;
  const at = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  if (Number.isNaN(at.getTime()) || at.getTime() <= now + thresholdMs) return false;
  session.status = SCHEDULED_START_STATUS;
  session.nextRunTime = at.toISOString();
  return true;
}

// Tìm phiên KHÁC đang thật sự giữ tài khoản (đang chạy / tạm dừng).
function findLiveAccountOwner(registry, email, exclude = null) {
  if (!registry || !email || typeof registry.values !== 'function') return null;
  return registry.values().find(session => session
    && session !== exclude
    && session.account
    && session.account.email === email
    && isAutoScanSessionActive(session)) || null;
}

// Phiên này có đang là "blocker hợp lệ" hay chỉ là xác chết?
function classifyAutoScanBlocker(session, { now = Date.now(), hasLiveOwner = false } = {}) {
  if (!session) return { blocking: false, stale: false, category: 'not-found', reason: 'not-found' };

  const status = session.status;
  if (TERMINAL_STATUSES.has(status)) {
    return { blocking: false, stale: false, category: 'terminal', reason: `terminal:${status}` };
  }

  // 'paused' được xét trước để giữ đúng category hiển thị, dù ownsAccountSession()
  // cũng trả về true cho phiên tạm dừng.
  if (status === 'paused') {
    return { blocking: true, stale: false, category: 'paused', reason: 'paused' };
  }

  if (isAutoScanSessionActive(session)) {
    return { blocking: true, stale: false, category: 'running', reason: `active:${status}` };
  }

  if (hasFutureNextRun(session, now)) {
    return {
      blocking: true,
      stale: false,
      category: SCHEDULED_STATUSES.has(status) ? 'scheduled' : 'waiting',
      reason: SCHEDULED_STATUSES.has(status) ? `scheduled:${status}` : `waiting:${status}`,
    };
  }

  if (hasLiveOwner) {
    return { blocking: true, stale: false, category: 'live-owner', reason: 'live-owner' };
  }

  if (SCHEDULED_STATUSES.has(status)) {
    return { blocking: false, stale: true, category: 'stale-schedule', reason: `stale-schedule:${status}` };
  }

  // idle / logging-in / scanning / studying / surplus-study nhưng phase không
  // còn chạy và không có lịch tương lai → phiên mồ côi (timer thất lạc, restore lỗi).
  return { blocking: false, stale: true, category: 'orphan', reason: `orphan:${status}` };
}

// Tìm blocker hợp lệ đầu tiên cho một email.
function findBlockingAutoScanSession(registry, email, { now = Date.now() } = {}) {
  if (!registry || !email || typeof registry.values !== 'function') return null;
  const matches = registry.values().filter(s => s && s.account && s.account.email === email);
  for (const session of matches) {
    const hasLiveOwner = Boolean(findLiveAccountOwner(registry, email, session));
    const verdict = classifyAutoScanBlocker(session, { now, hasLiveOwner });
    if (verdict.blocking) return { session, verdict };
  }
  return null;
}

// Thông điệp tiếng Việt cho lý do bỏ qua (hiển thị trên Dashboard).
function describeAutoScanBlocker(session, verdict) {
  const status = session && session.status;
  switch (verdict && verdict.category) {
    case 'running':
      return `đã có phiên Auto-Scan đang chạy (${status})`;
    case 'paused':
      return 'đã có phiên Auto-Scan đang tạm dừng';
    case 'scheduled':
    case 'waiting':
      if (status === SCHEDULED_START_STATUS) return 'đã có phiên Auto-Scan đã hẹn lịch';
      return `đã có phiên Auto-Scan ${status}`;
    case 'live-owner':
      return 'tài khoản đang được một phiên Auto-Scan khác sử dụng';
    default:
      return `đã có phiên Auto-Scan ${status || ''}`.trim();
  }
}

// ============================================================
//  KẾ HOẠCH START
//  Trả về kế hoạch cho TỪNG tài khoản đã phân giải được:
//    action 'start'         → chưa có gì → tạo phiên mới
//    action 'cleanup+start' → chỉ có phiên mồ côi/lịch quá hạn → dọn rồi tạo phiên mới
//    action 'skip'          → có blocker hợp lệ → KHÔNG tạo (giữ chống trùng phiên)
// ============================================================
function planAutoScanStart({ allAccounts, requestedIndices, registry, now = Date.now() } = {}) {
  const { resolved, unresolved } = resolveRequestedAccounts(allAccounts, requestedIndices);
  const plans = [];

  for (const { account, requested } of resolved) {
    const email = account && account.email;
    const matches = registry && typeof registry.values === 'function'
      ? registry.values().filter(s => s && s.account && s.account.email === email)
      : [];

    let blocker = null;
    const stale = [];

    for (const session of matches) {
      const hasLiveOwner = Boolean(findLiveAccountOwner(registry, email, session));
      const verdict = classifyAutoScanBlocker(session, { now, hasLiveOwner });
      if (verdict.blocking) {
        if (!blocker) blocker = { session, verdict };
      } else if (verdict.stale) {
        stale.push({ session, verdict });
      }
    }

    if (blocker) {
      plans.push({
        account,
        requested,
        email,
        action: 'skip',
        sessionId: blocker.session.id,
        status: blocker.session.status,
        verdict: blocker.verdict,
        reason: describeAutoScanBlocker(blocker.session, blocker.verdict),
        stale: [],
      });
      continue;
    }

    plans.push({
      account,
      requested,
      email,
      action: stale.length > 0 ? 'cleanup+start' : 'start',
      stale: stale.map(item => ({
        sessionId: item.session.id,
        status: item.session.status,
        category: item.verdict.category,
        reason: item.verdict.reason,
      })),
    });
  }

  return { resolved, unresolved, plans };
}

// ============================================================
//  RESPONSE
//  Luôn HTTP 200 cho kết quả đã xử lý, nhưng `result` phân biệt rõ:
//    'all-started'  → mọi tài khoản được chọn đều khởi động
//    'partial'      → có khởi động, có bỏ qua/không phân giải được
//    'none-started' → KHÔNG tài khoản nào khởi động (không được coi là thành công)
// ============================================================
function buildAutoScanStartResponse({ started = [], skipped = [], unresolved = [] } = {}) {
  let result;
  if (started.length > 0 && skipped.length === 0 && unresolved.length === 0) result = 'all-started';
  else if (started.length > 0) result = 'partial';
  else result = 'none-started';

  return { ok: true, result, started, skipped, unresolved };
}

module.exports = {
  normalizeAccountKey,
  resolveRequestedAccounts,
  isAutoScanSessionActive,
  hasFutureNextRun,
  applyScheduledStart,
  findLiveAccountOwner,
  classifyAutoScanBlocker,
  findBlockingAutoScanSession,
  describeAutoScanBlocker,
  planAutoScanStart,
  buildAutoScanStartResponse,
};
