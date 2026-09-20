// ============================================================
//  LOG STORE (đọc/ghi file log theo ngày)
// ============================================================
// Định dạng mới: `logs/daily/DD-MM-YYYY/log.ndjson` — ghi THÊM từng dòng
// (append-only) thay vì ghi lại toàn bộ file JSON mỗi 60 giây.
//
// Tương thích ngược: file `logs/daily/DD-MM-YYYY/logs.json` cũ vẫn ĐỌC được.
// Không bao giờ ghi đè/hủy file cũ. Migration chỉ diễn ra ở tầng server cho
// ngày hiện tại.

'use strict';

const fs = require('fs');
const path = require('path');

const LOG_NDJSON_NAME = 'log.ndjson';

function dailyDirPath(baseDir, date) { return path.join(baseDir, date); }
function legacyLogsPath(baseDir, date) { return path.join(dailyDirPath(baseDir, date), 'logs.json'); }
function ndjsonPath(baseDir, date) { return path.join(dailyDirPath(baseDir, date), LOG_NDJSON_NAME); }

function parseNdjson(text, date) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry && typeof entry === 'object') out.push(entry.date ? entry : { ...entry, date });
    } catch { /* bỏ dòng hỏng thay vì làm hỏng cả file */ }
  }
  return out;
}

function fileStatKey(file) {
  try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return null; }
}

const readCache = new Map(); // `${baseDir}|${date}` -> { key, entries }
function clearCache(baseDir, date) { readCache.delete(`${baseDir}|${date}`); }

// Đọc toàn bộ entry của một ngày. NDJSON là nguồn chính; fallback logs.json cũ.
function readDailyLogFile(baseDir, date) {
  if (!baseDir || !date) return [];
  const cacheKey = `${baseDir}|${date}`;

  const nd = ndjsonPath(baseDir, date);
  if (fs.existsSync(nd)) {
    const key = fileStatKey(nd);
    const cached = readCache.get(cacheKey);
    if (cached && cached.key === key) return cached.entries;
    const entries = parseNdjson(fs.readFileSync(nd, 'utf8'), date);
    readCache.set(cacheKey, { key, entries });
    return entries;
  }

  const legacy = legacyLogsPath(baseDir, date);
  if (fs.existsSync(legacy)) {
    const key = fileStatKey(legacy);
    const cached = readCache.get(cacheKey);
    if (cached && cached.key === key) return cached.entries;
    let entries = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      if (Array.isArray(parsed)) {
        entries = parsed
          .filter(entry => entry && typeof entry === 'object')
          .map(entry => (entry.date ? entry : { ...entry, date }));
      }
    } catch { entries = []; }
    readCache.set(cacheKey, { key, entries });
    return entries;
  }

  return [];
}

// Ghi thêm các entry mới vào NDJSON. Trả về số dòng đã ghi.
function appendDailyLogFile(baseDir, date, entries) {
  if (!baseDir || !date || !entries || entries.length === 0) return 0;
  const dir = dailyDirPath(baseDir, date);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(ndjsonPath(baseDir, date), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  clearCache(baseDir, date);
  return entries.length;
}

module.exports = {
  LOG_NDJSON_NAME,
  dailyDirPath,
  legacyLogsPath,
  ndjsonPath,
  parseNdjson,
  clearCache,
  readDailyLogFile,
  appendDailyLogFile,
};
