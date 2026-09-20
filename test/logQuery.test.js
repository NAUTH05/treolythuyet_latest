const test = require('node:test');
const assert = require('node:assert/strict');
const {
  filterLogEntries,
  paginateNewestFirst,
  logEntryKey,
  DEFAULT_LOG_PAGE,
  MAX_LOG_PAGE,
} = require('../logQuery');

function makeEntries(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    timestamp: `10:00:${String(i).padStart(2, '0')}`,
    account: i % 2 === 0 ? 'A' : 'B',
    level: i % 3 === 0 ? 'warn' : 'info',
    msg: `msg ${i}`,
    date: '20-09-2026',
  }));
}

test('mặc định trang log là 200 dòng', () => {
  assert.equal(DEFAULT_LOG_PAGE, 200);
  assert.equal(MAX_LOG_PAGE, 500);
});

test('có 10.000 dòng nhưng chỉ trả về đúng 1 trang', () => {
  const entries = makeEntries(10000);
  const page = paginateNewestFirst(entries, { limit: 200, cursor: 0 });
  assert.equal(page.logs.length, 200);
  assert.equal(page.total, 10000);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor, 200);
  // newest-first: dòng mới nhất đứng đầu
  assert.equal(page.logs[0].id, 'id-9999');
  assert.equal(page.logs[199].id, 'id-9800');
});

test('requested limit bị kẹp ở MAX_LOG_PAGE', () => {
  const entries = makeEntries(2000);
  const page = paginateNewestFirst(entries, { limit: 99999, cursor: 0 });
  assert.equal(page.logs.length, MAX_LOG_PAGE);
});

test('limit vô lý (0/NaN/âm) rơi về mặc định', () => {
  const entries = makeEntries(500);
  assert.equal(paginateNewestFirst(entries, { limit: 0 }).logs.length, DEFAULT_LOG_PAGE);
  assert.equal(paginateNewestFirst(entries, { limit: NaN }).logs.length, DEFAULT_LOG_PAGE);
  assert.equal(paginateNewestFirst(entries, { limit: -5 }).logs.length, DEFAULT_LOG_PAGE);
});

test('trang 2 tiếp nối không trùng và kết thúc đúng', () => {
  const entries = makeEntries(450);
  const p1 = paginateNewestFirst(entries, { limit: 200, cursor: 0 });
  const p2 = paginateNewestFirst(entries, { limit: 200, cursor: p1.nextCursor });
  const p3 = paginateNewestFirst(entries, { limit: 200, cursor: p2.nextCursor });

  const ids = [...p1.logs, ...p2.logs, ...p3.logs].map(e => e.id);
  assert.equal(new Set(ids).size, ids.length, 'không trùng giữa các trang');
  assert.equal(ids.length, 450);
  assert.equal(p1.hasMore, true);
  assert.equal(p2.hasMore, true);
  assert.equal(p3.hasMore, false);
  assert.equal(p3.nextCursor, null);
  // Trang 3 là phần còn lại (cũ nhất) và vẫn newest-first trong trang
  assert.equal(p3.logs.length, 50);
  assert.equal(p3.logs[0].id, 'id-49');
  assert.equal(p3.logs[49].id, 'id-0');
});

test('ngày rỗng → trang rỗng, không hasMore', () => {
  const page = paginateNewestFirst([], { limit: 200, cursor: 0 });
  assert.deepEqual(page.logs, []);
  assert.equal(page.hasMore, false);
  assert.equal(page.total, 0);
  assert.equal(page.nextCursor, null);
});

test('lọc theo tài khoản CHẠY Ở SERVER trước khi phân trang', () => {
  const entries = makeEntries(100);
  const filtered = filterLogEntries(entries, { account: 'A' });
  assert.equal(filtered.length, 50);
  assert.ok(filtered.every(e => e.account === 'A'));
  const page = paginateNewestFirst(filtered, { limit: 200, cursor: 0 });
  assert.equal(page.total, 50);
});

test('lọc theo level', () => {
  const entries = makeEntries(30);
  const filtered = filterLogEntries(entries, { level: 'warn' });
  assert.ok(filtered.every(e => e.level === 'warn'));
  assert.ok(filtered.length > 0);
});

test('lọc kết hợp account + level', () => {
  const entries = makeEntries(60);
  const filtered = filterLogEntries(entries, { account: 'A', level: 'info' });
  assert.ok(filtered.every(e => e.account === 'A' && e.level === 'info'));
});

test('logEntryKey ưu tiên id; entry cũ dùng khóa ghép ổn định', () => {
  assert.equal(logEntryKey({ id: 'abc' }), 'abc');
  const legacy = { timestamp: '10:00', account: 'A', level: 'info', msg: 'x', date: '20-09-2026' };
  assert.equal(logEntryKey(legacy), logEntryKey({ ...legacy }), 'khóa ghép phải ổn định');
  assert.notEqual(logEntryKey(legacy), logEntryKey({ ...legacy, msg: 'y' }));
});
