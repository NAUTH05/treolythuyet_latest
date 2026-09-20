// ============================================================
//  LOG QUERY HELPERS (pure)
// ============================================================
// Tách khỏi server.js (server.js tự listen cổng, không require được trong test).
// Mục tiêu: lọc + phân trang log phía SERVER để Dashboard không phải tải/render
// hàng chục nghìn dòng cùng lúc.

'use strict';

const DEFAULT_LOG_PAGE = 200;
const MAX_LOG_PAGE = 500;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function entryAccount(entry) {
  return (entry && entry.account) || 'system';
}

function entryLevel(entry) {
  return (entry && entry.level) || 'info';
}

// Lọc theo tài khoản/cấp độ NGAY TRÊN SERVER (không đẩy toàn bộ rồi lọc ở client).
function filterLogEntries(entries, { account = '', level = '' } = {}) {
  let out = Array.isArray(entries) ? entries : [];
  if (account) out = out.filter(entry => entryAccount(entry) === account);
  if (level) out = out.filter(entry => entryLevel(entry) === level);
  return out;
}

// Phân trang NEWEST-FIRST. `cursor` = số dòng đã lấy tính từ mới nhất.
function paginateNewestFirst(entries, { limit = DEFAULT_LOG_PAGE, cursor = 0 } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const pageSize = clampInt(limit, 1, MAX_LOG_PAGE, DEFAULT_LOG_PAGE);
  const offset = Math.max(0, clampInt(cursor, 0, Number.MAX_SAFE_INTEGER, 0));
  const total = list.length;
  const end = Math.max(0, total - offset);
  const start = Math.max(0, end - pageSize);
  const logs = list.slice(start, end).slice().reverse();
  const hasMore = start > 0;
  return {
    logs,
    total,
    hasMore,
    nextCursor: hasMore ? offset + logs.length : null,
  };
}

// Khóa ổn định cho một entry log. Ưu tiên `id`; với dữ liệu lịch sử cũ không có
// id, dùng khóa ghép để client dedupe được khi trộn realtime + lịch sử.
function logEntryKey(entry) {
  if (entry && entry.id) return String(entry.id);
  const e = entry || {};
  return `${e.date || ''}|${e.timestamp || ''}|${e.account || 'system'}|${e.level || 'info'}|${e.msg || ''}`;
}

module.exports = {
  DEFAULT_LOG_PAGE,
  MAX_LOG_PAGE,
  filterLogEntries,
  paginateNewestFirst,
  logEntryKey,
};
