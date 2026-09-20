const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  readDailyLogFile,
  appendDailyLogFile,
  clearCache,
  legacyLogsPath,
  ndjsonPath,
} = require('../logStore');
const { paginateNewestFirst } = require('../logQuery');

function tmpBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'logstore-'));
}

test('ngày trống → không có entry', () => {
  const base = tmpBase();
  assert.deepEqual(readDailyLogFile(base, '01-01-2026'), []);
});

test('file logs.json CŨ vẫn đọc được và entry thiếu date được gán ngày', () => {
  const base = tmpBase();
  const date = '20-09-2026';
  fs.mkdirSync(path.join(base, date), { recursive: true });
  const legacy = [
    { timestamp: '10:00', account: 'A', level: 'info', msg: 'không có date' },
    { timestamp: '10:01', account: 'B', level: 'warn', msg: 'có date', date },
  ];
  fs.writeFileSync(legacyLogsPath(base, date), JSON.stringify(legacy, null, 2), 'utf8');

  const entries = readDailyLogFile(base, date);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].date, date);
  assert.equal(entries[1].date, date);
});

test('NDJSON append-only: ghi thêm 2 lần thì cộng dồn, không ghi đè', () => {
  const base = tmpBase();
  const date = '21-09-2026';
  appendDailyLogFile(base, date, [{ id: 'a', msg: 'first', date }]);
  appendDailyLogFile(base, date, [{ id: 'b', msg: 'second', date }]);
  const entries = readDailyLogFile(base, date);
  assert.deepEqual(entries.map(e => e.id), ['a', 'b']);
  // File chỉ có 2 dòng NDJSON hợp lệ
  const lines = fs.readFileSync(ndjsonPath(base, date), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
});

test('ưu tiên NDJSON khi cả hai file cùng tồn tại', () => {
  const base = tmpBase();
  const date = '22-09-2026';
  fs.mkdirSync(path.join(base, date), { recursive: true });
  fs.writeFileSync(legacyLogsPath(base, date), JSON.stringify([{ id: 'legacy', date }]), 'utf8');
  appendDailyLogFile(base, date, [{ id: 'ndjson', date }]);

  const entries = readDailyLogFile(base, date);
  assert.deepEqual(entries.map(e => e.id), ['ndjson']);
});

test('dòng NDJSON hỏng bị bỏ qua, dòng hợp lệ vẫn đọc', () => {
  const base = tmpBase();
  const date = '23-09-2026';
  const dir = path.join(base, date);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ndjsonPath(base, date), [
    JSON.stringify({ id: 'ok1', date }),
    '{ hỏng json',
    '',
    JSON.stringify({ id: 'ok2', date }),
  ].join('\n') + '\n', 'utf8');

  const entries = readDailyLogFile(base, date);
  assert.deepEqual(entries.map(e => e.id), ['ok1', 'ok2']);
});

test('10.000 dòng: đọc đủ nhưng phân trang CHỈ trả 1 trang', () => {
  const base = tmpBase();
  const date = '24-09-2026';
  const big = Array.from({ length: 10000 }, (_, i) => ({ id: `n${i}`, account: 'A', level: 'info', msg: `m${i}`, date }));
  appendDailyLogFile(base, date, big);

  const entries = readDailyLogFile(base, date);
  assert.equal(entries.length, 10000);

  const page = paginateNewestFirst(entries, { limit: 200, cursor: 0 });
  assert.equal(page.logs.length, 200);
  assert.equal(page.total, 10000);
  assert.equal(page.hasMore, true);
  assert.equal(page.logs[0].id, 'n9999');
});

test('entry cũ không có id vẫn tương thích (đọc + phân trang)', () => {
  const base = tmpBase();
  const date = '25-09-2026';
  appendDailyLogFile(base, date, [
    { timestamp: '09:00', account: 'A', level: 'info', msg: 'old-1', date },
    { timestamp: '09:01', account: 'A', level: 'info', msg: 'old-2', date },
  ]);
  const entries = readDailyLogFile(base, date);
  assert.equal(entries.length, 2);
  const page = paginateNewestFirst(entries, { limit: 10, cursor: 0 });
  assert.equal(page.logs[0].msg, 'old-2');
});

test('cache đọc được vô hiệu sau khi append', () => {
  const base = tmpBase();
  const date = '26-09-2026';
  appendDailyLogFile(base, date, [{ id: 'x', date }]);
  assert.equal(readDailyLogFile(base, date).length, 1);
  appendDailyLogFile(base, date, [{ id: 'y', date }]);
  assert.equal(readDailyLogFile(base, date).length, 2);
  clearCache(base, date);
  assert.equal(readDailyLogFile(base, date).length, 2);
});
