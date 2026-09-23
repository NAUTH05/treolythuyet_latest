// ============================================================
//  LOG STREAM HELPERS (thuần — dùng chung UI + test)
// ============================================================
// Tách khỏi LogPanel.jsx để unit-test bằng Node (dynamic import), tránh phải
// dựng React/browser.
//
// BẤT BIẾN LỌC (một quy tắc DUY NHẤT cho mọi dòng vào danh sách hiển thị):
//   DATE phải khớp ngày đang chọn
//   AND khi filterAccount khác rỗng: (entry.account || 'system') === filterAccount
//   AND khi filterLevel khác rỗng:   (entry.level || 'info') === filterLevel
//
// Dòng realtime từ Socket.io đi qua CÙNG quy tắc đó — trước đây chúng được trộn
// vào kết quả đã lọc server-side mà chỉ kiểm tra ngày, nên log của tài khoản khác
// vẫn hiện khi đang lọc 1 tài khoản, và volume lớn của tài khoản khác có thể đẩy
// dòng của tài khoản đang chọn ra khỏi trần MAX_RENDER.

// Trần số dòng giữ trong DOM sau khi trộn realtime (khớp LogPanel).
export const LOG_MAX_RENDER = 2000;

// 'DD-MM-YYYY' hoặc 'YYYY-MM-DD' → 'DD-MM-YYYY'; không đọc được → ''.
export function normalizeLogDate(value) {
  const text = String(value || '').trim();
  if (/^\d{2}-\d{2}-\d{4}$/.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-');
    return `${day}-${month}-${year}`;
  }
  return '';
}

// Khóa ổn định để trộn realtime + lịch sử mà không trùng (khớp logQuery.logEntryKey).
export function logKey(entry) {
  if (entry && entry.id) return String(entry.id);
  const e = entry || {};
  return `${e.date || ''}|${e.timestamp || ''}|${e.account || 'system'}|${e.level || 'info'}|${e.msg || ''}`;
}

export function entryAccount(entry) {
  return (entry && entry.account) || 'system';
}

export function entryLevel(entry) {
  return (entry && entry.level) || 'info';
}

// Một dòng có thoả bộ lọc đang bật không?
//
// Ngày: entry realtime LUÔN được server đóng dấu `date` (server.addLog), nên dòng
// thiếu/không đọc được ngày KHÔNG thể chứng minh thuộc ngày đang xem → loại. Đây là
// chủ ý: không để một event cũ/hỏng lọt vào view "hôm nay" chỉ vì thiếu `date`.
export function matchesVisibleFilter(entry, { date = '', account = '', level = '' } = {}) {
  const e = entry || {};
  if (date && normalizeLogDate(e.date) !== date) return false;
  if (account && entryAccount(e) !== account) return false;
  if (level && entryLevel(e) !== level) return false;
  return true;
}

// Lọc dòng realtime theo ĐÚNG bộ lọc đang áp cho dòng lịch sử.
export function filterVisibleLiveLogs(liveLogs, { date = '', account = '', level = '' } = {}) {
  const list = Array.isArray(liveLogs) ? liveLogs : [];
  return list.filter(entry => matchesVisibleFilter(entry, { date, account, level }));
}

// Trộn lịch sử (đã lọc server-side) + realtime (lọc client-side cùng quy tắc).
//
// THỨ TỰ BẮT BUỘC: lọc realtime → dedupe → cap MAX_RENDER.
// KHÔNG được cap trước khi lọc: volume của tài khoản khác sẽ đẩy dòng của tài khoản
// đang chọn ra khỏi trần.
//
// Không có dòng realtime nào lọt qua bộ lọc → trả nguyên `loadedLogs` (giữ nguyên
// hành vi cũ: không cap khi không trộn realtime).
export function mergeLogStreams({
  loadedLogs = [],
  liveLogs = [],
  date = '',
  account = '',
  level = '',
  isToday = false,
  maxRender = LOG_MAX_RENDER,
} = {}) {
  const history = Array.isArray(loadedLogs) ? loadedLogs : [];
  const visibleLive = isToday ? filterVisibleLiveLogs(liveLogs, { date, account, level }) : [];
  if (visibleLive.length === 0) return history;

  const map = new Map();
  for (const entry of history) map.set(logKey(entry), entry);
  for (const entry of visibleLive) map.set(logKey(entry), entry);
  const merged = [...map.values()];
  return merged.length > maxRender ? merged.slice(-maxRender) : merged;
}

// Số dòng realtime ĐÃ được trộn vào danh sách hiển thị (dùng cho footer).
export function countMergedLiveRows(visibleLogs, loadedLogs) {
  const historyKeys = new Set((Array.isArray(loadedLogs) ? loadedLogs : []).map(logKey));
  return (Array.isArray(visibleLogs) ? visibleLogs : []).filter(entry => !historyKeys.has(logKey(entry))).length;
}

// Đếm theo level trên một tập dòng đã lọc (thường là tập đã lọc NGÀY + TÀI KHOẢN,
// chưa áp level) → bộ đếm không phụ thuộc chính bộ lọc level và không đếm tài khoản khác.
export function countLevels(entries) {
  const counts = { error: 0, warn: 0, success: 0, info: 0 };
  for (const entry of Array.isArray(entries) ? entries : []) {
    const lvl = entryLevel(entry);
    if (counts[lvl] !== undefined) counts[lvl]++;
  }
  return counts;
}

// Danh sách tài khoản cho dropdown: ưu tiên metadata server, lùi về tài khoản có
// trong dòng đang hiển thị. Tài khoản ĐANG CHỌN luôn được thêm vào — metadata cũ
// không được làm biến mất lựa chọn hiện tại.
export function buildAccountList({ metadataAccounts = [], fallbackAccounts = [], selectedAccount = '' } = {}) {
  const set = new Set();
  const meta = (Array.isArray(metadataAccounts) ? metadataAccounts : []).filter(Boolean);
  if (meta.length > 0) {
    for (const account of meta) set.add(account);
  } else {
    for (const account of (Array.isArray(fallbackAccounts) ? fallbackAccounts : [])) {
      if (account) set.add(account);
    }
  }
  if (selectedAccount) set.add(selectedAccount);
  return [...set].sort();
}

// Áp phản hồi trang ĐẦU vào state hiển thị.
// Trả về `null` khi phản hồi thuộc một request ĐÃ BỊ THAY THẾ (người dùng đổi
// ngày/bộ lọc trong lúc chờ) → caller phải bỏ qua hoàn toàn, không được ghi đè
// kết quả của bộ lọc mới hơn.
export function resolveFirstPageResponse({ requestId, currentRequestId, response } = {}) {
  if (requestId !== currentRequestId) return null;
  const rows = response && Array.isArray(response.logs) ? response.logs : [];
  return {
    loadedLogs: rows.slice().reverse(),
    nextCursor: response ? (response.nextCursor ?? null) : null,
    hasMore: Boolean(response && response.hasMore),
    total: response && Number.isFinite(response.total) ? response.total : rows.length,
  };
}

// Ghép một trang CŨ hơn lên ĐẦU danh sách để giữ thứ tự thời gian (cũ → mới).
export function prependOlderPage(previous, response) {
  const rows = response && Array.isArray(response.logs) ? response.logs : [];
  const base = Array.isArray(previous) ? previous : [];
  return [...rows.slice().reverse(), ...base];
}
