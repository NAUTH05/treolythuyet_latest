const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const MODULE = path.join(ROOT, 'src', 'logStream.mjs');
const PANEL = path.join(ROOT, 'client', 'src', 'components', 'LogPanel.jsx');

let modulePromise = null;
function load() {
  if (!modulePromise) modulePromise = import(pathToFileURL(MODULE).href);
  return modulePromise;
}

const TODAY = '23-09-2026';
const CAO = 'Cao Thị Kim Anh';
const HA = 'Hà Thị Cẩm Tú';
const PHAN = 'Phan Trọng Nghĩa';

function entry(account, msg, { level = 'info', date = TODAY, id = null, timestamp = '10:00:00' } = {}) {
  const e = { account, msg, level, date, timestamp };
  if (id) e.id = id;
  return e;
}

// ─────────────────────────────────────────────────────────────────────────────
// TÁI HIỆN BUG PRODUCTION: đang lọc 1 tài khoản mà vẫn thấy log tài khoản khác
// ─────────────────────────────────────────────────────────────────────────────

test('TÁI HIỆN: lọc "Cao Thị Kim Anh" → realtime của Hà/Phan KHÔNG được lọt vào', async () => {
  const { mergeLogStreams } = await load();
  const loadedLogs = [entry(CAO, 'Cao #1'), entry(CAO, 'Cao #2')];
  const liveLogs = [entry(CAO, 'Cao #3'), entry(HA, 'Hà #1'), entry(PHAN, 'Phan #1')];

  const visible = mergeLogStreams({
    loadedLogs, liveLogs, date: TODAY, account: CAO, isToday: true,
  });

  assert.deepEqual(visible.map(e => e.msg), ['Cao #1', 'Cao #2', 'Cao #3']);
  assert.equal(visible.some(e => e.account === HA), false);
  assert.equal(visible.some(e => e.account === PHAN), false);
});

test('lọc tài khoản khớp CHÍNH XÁC (không khớp một phần)', async () => {
  const { filterVisibleLiveLogs } = await load();
  const live = [entry(CAO, 'a'), entry(`${CAO} 2`, 'b'), entry('cao thị kim anh', 'c'), entry(null, 'd')];
  const visible = filterVisibleLiveLogs(live, { date: TODAY, account: CAO });
  assert.deepEqual(visible.map(e => e.msg), ['a']);
});

test('entry thiếu account được coi là "system" (khớp hợp đồng server)', async () => {
  const { filterVisibleLiveLogs } = await load();
  const live = [{ msg: 'x', date: TODAY, level: 'info' }];
  assert.equal(filterVisibleLiveLogs(live, { date: TODAY, account: 'system' }).length, 1);
  assert.equal(filterVisibleLiveLogs(live, { date: TODAY, account: CAO }).length, 0);
});

// ── Level filter ──

test('realtime tôn trọng bộ lọc LEVEL', async () => {
  const { mergeLogStreams } = await load();
  const liveLogs = [
    entry(CAO, 'lỗi', { level: 'error' }),
    entry(CAO, 'thông tin', { level: 'info' }),
    entry(HA, 'lỗi tk khác', { level: 'error' }),
  ];

  const errors = mergeLogStreams({ loadedLogs: [], liveLogs, date: TODAY, account: CAO, level: 'error', isToday: true });
  assert.deepEqual(errors.map(e => e.msg), ['lỗi']);

  const infos = mergeLogStreams({ loadedLogs: [], liveLogs, date: TODAY, account: CAO, level: 'info', isToday: true });
  assert.deepEqual(infos.map(e => e.msg), ['thông tin']);
});

test('entry thiếu level được coi là "info"', async () => {
  const { filterVisibleLiveLogs } = await load();
  const live = [{ account: CAO, msg: 'x', date: TODAY }];
  assert.equal(filterVisibleLiveLogs(live, { date: TODAY, account: CAO, level: 'info' }).length, 1);
  assert.equal(filterVisibleLiveLogs(live, { date: TODAY, account: CAO, level: 'error' }).length, 0);
});

// ── Date filter ──

test('realtime tôn trọng NGÀY đang chọn', async () => {
  const { mergeLogStreams } = await load();
  const liveLogs = [
    entry(CAO, 'hôm nay'),
    entry(CAO, 'hôm qua', { date: '22-09-2026' }),
    entry(CAO, 'định dạng ISO', { date: '2026-09-23' }),
  ];

  const visible = mergeLogStreams({ loadedLogs: [], liveLogs, date: TODAY, account: '', isToday: true });
  assert.deepEqual(visible.map(e => e.msg), ['hôm nay', 'định dạng ISO']);
});

test('entry THIẾU ngày KHÔNG được lọt vào view ngày hôm nay', async () => {
  // addLog() của server LUÔN đóng dấu `date`; thiếu ngày nghĩa là event cũ/hỏng →
  // không thể chứng minh thuộc ngày đang xem nên phải bị loại.
  const { mergeLogStreams } = await load();
  const liveLogs = [entry(CAO, 'không có ngày', { date: '' }), entry(CAO, 'ngày rác', { date: 'nonsense' })];

  const visible = mergeLogStreams({ loadedLogs: [], liveLogs, date: TODAY, account: '', isToday: true });
  assert.deepEqual(visible, []);
});

test('không xem hôm nay → KHÔNG trộn realtime', async () => {
  const { mergeLogStreams } = await load();
  const visible = mergeLogStreams({
    loadedLogs: [entry(CAO, 'history')],
    liveLogs: [entry(CAO, 'live')],
    date: '22-09-2026',
    isToday: false,
  });
  assert.deepEqual(visible.map(e => e.msg), ['history']);
});

// ── MAX_RENDER: dòng tài khoản khác không được đẩy dòng đang chọn ra ngoài ──

test('volume realtime của tài khoản KHÁC không đẩy dòng tài khoản đang chọn ra khỏi MAX_RENDER', async () => {
  const { mergeLogStreams } = await load();
  const loadedLogs = Array.from({ length: 200 }, (_, i) => entry(CAO, `Cao hist ${i}`, { id: `h${i}` }));
  const liveLogs = [
    ...Array.from({ length: 2500 }, (_, i) => entry(HA, `Hà live ${i}`, { id: `x${i}` })),
    ...Array.from({ length: 20 }, (_, i) => entry(CAO, `Cao live ${i}`, { id: `c${i}` })),
  ];

  const visible = mergeLogStreams({
    loadedLogs, liveLogs, date: TODAY, account: CAO, isToday: true, maxRender: 2000,
  });

  assert.equal(visible.some(e => e.account === HA), false, 'dòng tài khoản khác không được vào tập đã lọc');
  assert.equal(visible.filter(e => e.msg.startsWith('Cao hist')).length, 200, 'lịch sử của tài khoản đang chọn phải còn nguyên');
  assert.equal(visible.filter(e => e.msg.startsWith('Cao live')).length, 20, 'dòng live của tài khoản đang chọn vẫn hiện');
  assert.equal(visible.length, 220);
});

test('trần MAX_RENDER chỉ áp lên các dòng KHỚP bộ lọc', async () => {
  const { mergeLogStreams } = await load();
  const loadedLogs = Array.from({ length: 200 }, (_, i) => entry(CAO, `Cao hist ${i}`, { id: `h${i}` }));
  const liveLogs = [
    ...Array.from({ length: 2500 }, (_, i) => entry(HA, `Hà live ${i}`, { id: `x${i}` })),
    ...Array.from({ length: 10 }, (_, i) => entry(CAO, `Cao live ${i}`, { id: `c${i}` })),
  ];

  const visible = mergeLogStreams({
    loadedLogs, liveLogs, date: TODAY, account: CAO, isToday: true, maxRender: 150,
  });

  assert.equal(visible.length, 150, 'cap áp lên tập 210 dòng khớp bộ lọc');
  assert.equal(visible.every(e => e.account === CAO), true);
  // Giữ các dòng MỚI NHẤT (cap cắt phần cũ nhất).
  assert.equal(visible[visible.length - 1].msg, 'Cao live 9');
});

test('không có dòng realtime nào khớp → giữ nguyên danh sách lịch sử (không cap)', async () => {
  const { mergeLogStreams } = await load();
  const loadedLogs = Array.from({ length: 200 }, (_, i) => entry(CAO, `Cao hist ${i}`, { id: `h${i}` }));
  const liveLogs = Array.from({ length: 2500 }, (_, i) => entry(HA, `Hà live ${i}`, { id: `x${i}` }));

  const visible = mergeLogStreams({
    loadedLogs, liveLogs, date: TODAY, account: CAO, isToday: true, maxRender: 10,
  });

  assert.equal(visible.length, 200);
  assert.equal(visible.every(e => e.account === CAO), true);
});

// ── Dedupe ──

test('dedupe theo id: cùng entry ở lịch sử và realtime chỉ hiện 1 lần', async () => {
  const { mergeLogStreams } = await load();
  const shared = entry(CAO, 'trùng', { id: 'dup1' });
  const visible = mergeLogStreams({
    loadedLogs: [shared], liveLogs: [{ ...shared }], date: TODAY, account: CAO, isToday: true,
  });
  assert.equal(visible.length, 1);
});

test('dòng cũ KHÔNG có id vẫn dedupe an toàn bằng khóa ghép', async () => {
  const { mergeLogStreams } = await load();
  const legacy = entry(CAO, 'không id', { timestamp: '09:00:00' });
  const visible = mergeLogStreams({
    loadedLogs: [legacy], liveLogs: [entry(CAO, 'không id', { timestamp: '09:00:00' })],
    date: TODAY, account: CAO, isToday: true,
  });
  assert.equal(visible.length, 1, 'khóa ghép phải trùng nhau với dữ liệu cũ');
});

test('hai dòng khác nhau (khác timestamp) KHÔNG bị dedupe nhầm', async () => {
  const { mergeLogStreams } = await load();
  const visible = mergeLogStreams({
    loadedLogs: [entry(CAO, 'a', { timestamp: '09:00:00' })],
    liveLogs: [entry(CAO, 'a', { timestamp: '09:00:01' })],
    date: TODAY, account: CAO, isToday: true,
  });
  assert.equal(visible.length, 2);
});

// ── Không có bộ lọc → hành vi realtime giữ nguyên ──

test('không bộ lọc → mọi tài khoản realtime của hôm nay vẫn hiện như trước', async () => {
  const { mergeLogStreams } = await load();
  const liveLogs = [entry(CAO, 'a'), entry(HA, 'b'), entry(PHAN, 'c')];
  const visible = mergeLogStreams({ loadedLogs: [], liveLogs, date: TODAY, account: '', level: '', isToday: true });
  assert.deepEqual(visible.map(e => e.msg), ['a', 'b', 'c']);
});

test('không bộ lọc → giữ thứ tự lịch sử rồi tới realtime mới', async () => {
  const { mergeLogStreams } = await load();
  const visible = mergeLogStreams({
    loadedLogs: [entry(CAO, 'hist1', { id: '1' }), entry(HA, 'hist2', { id: '2' })],
    liveLogs: [entry(CAO, 'live1', { id: '3' })],
    date: TODAY, isToday: true,
  });
  assert.deepEqual(visible.map(e => e.msg), ['hist1', 'hist2', 'live1']);
});

// ── Bộ đếm level ──

test('đếm level chỉ tính dòng của tài khoản đang lọc', async () => {
  const { countLevels, mergeLogStreams } = await load();
  const liveLogs = [
    entry(CAO, 'lỗi', { level: 'error' }),
    entry(CAO, 'cảnh báo', { level: 'warn' }),
    entry(HA, 'lỗi tk khác', { level: 'error' }),
    entry(PHAN, 'cảnh báo tk khác', { level: 'warn' }),
  ];

  const scoped = mergeLogStreams({ loadedLogs: [], liveLogs, date: TODAY, account: CAO, isToday: true });
  const counts = countLevels(scoped);

  assert.deepEqual(counts, { error: 1, warn: 1, success: 0, info: 0 });
});

// ── Dropdown tài khoản ──

test('tài khoản ĐANG CHỌN không bị mất khỏi dropdown dù metadata thiếu nó', async () => {
  const { buildAccountList } = await load();
  const list = buildAccountList({
    metadataAccounts: [HA],
    fallbackAccounts: [],
    selectedAccount: CAO,
  });

  assert.equal(list.includes(CAO), true, 'lựa chọn hiện tại phải còn trong danh sách');
  assert.equal(list.includes(HA), true);
  assert.deepEqual(list, [HA, CAO].sort());
});

test('metadata rỗng → lùi về tài khoản trong dòng đang hiển thị, vẫn giữ tài khoản đang chọn', async () => {
  const { buildAccountList } = await load();
  const list = buildAccountList({
    metadataAccounts: [],
    fallbackAccounts: [HA, PHAN],
    selectedAccount: CAO,
  });
  assert.deepEqual(list, [HA, PHAN, CAO].sort());
});

test('metadata có dữ liệu → ưu tiên metadata (không trộn fallback)', async () => {
  const { buildAccountList } = await load();
  const list = buildAccountList({
    metadataAccounts: [HA],
    fallbackAccounts: [PHAN],
    selectedAccount: '',
  });
  assert.deepEqual(list, [HA]);
});

// ── Async race: request cũ không được ghi đè bộ lọc mới hơn ──

test('phản hồi của request CŨ (All) không ghi đè kết quả mới hơn (Cao)', async () => {
  const { resolveFirstPageResponse } = await load();
  const currentRequestId = 2; // request B (Cao) đã khởi chạy sau request A (All)

  // A (thế hệ 1) về muộn → phải bị vứt bỏ hoàn toàn.
  const stale = resolveFirstPageResponse({
    requestId: 1,
    currentRequestId,
    response: { logs: [entry(HA, 'Hà #1')], total: 1050, hasMore: true, nextCursor: 200 },
  });
  assert.equal(stale, null, 'phản hồi cũ phải trả null để caller không ghi state');

  // B (thế hệ 2) hợp lệ → áp bình thường.
  const fresh = resolveFirstPageResponse({
    requestId: 2,
    currentRequestId,
    response: { logs: [entry(CAO, 'Cao #1')], total: 487, hasMore: true, nextCursor: 200 },
  });
  assert.deepEqual(fresh.loadedLogs.map(e => e.account), [CAO]);
  assert.equal(fresh.total, 487, 'total là tổng ĐÃ LỌC phía server');
  assert.equal(fresh.hasMore, true);
  assert.equal(fresh.nextCursor, 200);
});

test('trang đầu đảo về thứ tự thời gian (cũ → mới) và chịu được phản hồi rỗng', async () => {
  const { resolveFirstPageResponse } = await load();
  const page = resolveFirstPageResponse({
    requestId: 5,
    currentRequestId: 5,
    response: { logs: [entry(CAO, 'mới'), entry(CAO, 'cũ')], total: 2, hasMore: false, nextCursor: null },
  });
  assert.deepEqual(page.loadedLogs.map(e => e.msg), ['cũ', 'mới']);

  const empty = resolveFirstPageResponse({ requestId: 5, currentRequestId: 5, response: null });
  assert.deepEqual(empty.loadedLogs, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.hasMore, false);
  assert.equal(empty.nextCursor, null);
});

// ── Load More ──

test('Load More chèn trang CŨ hơn lên đầu và giữ thứ tự cũ → mới', async () => {
  const { prependOlderPage } = await load();
  const previous = [entry(CAO, 'newest', { id: 'n1' })];
  // Server trả newest-first trong 1 trang.
  const response = { logs: [entry(CAO, 'newer', { id: 'n2' }), entry(CAO, 'older', { id: 'n3' })] };

  const next = prependOlderPage(previous, response);
  assert.deepEqual(next.map(e => e.msg), ['older', 'newer', 'newest']);
});

test('Load More với phản hồi rỗng không làm mất dòng đang có', async () => {
  const { prependOlderPage } = await load();
  const previous = [entry(CAO, 'giữ lại')];
  assert.deepEqual(prependOlderPage(previous, { logs: [] }).map(e => e.msg), ['giữ lại']);
  assert.deepEqual(prependOlderPage(previous, null).map(e => e.msg), ['giữ lại']);
});

// ── Hợp đồng phía SERVER (nguồn sự thật của việc lọc) ──

test('filterLogEntries khớp tài khoản CHÍNH XÁC và coi thiếu account là "system"', () => {
  const { filterLogEntries } = require('../logQuery');
  const entries = [
    entry(CAO, 'a'),
    entry(`${CAO} 2`, 'b'),
    entry(HA, 'c'),
    { msg: 'd', level: 'info' },
  ];
  assert.deepEqual(filterLogEntries(entries, { account: CAO }).map(e => e.msg), ['a']);
  assert.deepEqual(filterLogEntries(entries, { account: 'system' }).map(e => e.msg), ['d']);
  assert.deepEqual(filterLogEntries(entries, { account: HA, level: 'info' }).map(e => e.msg), ['c']);
  assert.deepEqual(filterLogEntries(entries, { level: 'error' }), []);
});

test('/api/logs/history LỌC trước khi PHÂN TRANG (không phân trang rồi mới lọc)', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = server.indexOf("app.get('/api/logs/history'");
  const end = server.indexOf("app.get('/api/logs/export'", start);
  assert.ok(start >= 0 && end > start, 'không tìm thấy route history');
  const route = server.slice(start, end);

  const filterIdx = route.indexOf('filterLogEntries(');
  const pageIdx = route.indexOf('paginateNewestFirst(');
  assert.ok(filterIdx >= 0, 'route phải gọi filterLogEntries');
  assert.ok(pageIdx > filterIdx, 'filterLogEntries phải chạy TRƯỚC paginateNewestFirst');
  assert.match(route, /req\.query\.account/);
  assert.match(route, /req\.query\.level/);
});

test('/api/logs/export giữ lọc server-side và trả TOÀN BỘ ngày (không phân trang)', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = server.indexOf("app.get('/api/logs/export'");
  const end = server.indexOf("app.get('/api/logs/by-date'", start);
  assert.ok(start >= 0 && end > start, 'không tìm thấy route export');
  const route = server.slice(start, end);

  assert.match(route, /filterLogEntries\(/, 'export phải lọc theo tài khoản/level ở server');
  assert.match(route, /req\.query\.account/);
  assert.match(route, /req\.query\.level/);
  assert.doesNotMatch(route, /paginateNewestFirst/, 'export không được cắt trang');
});

test('/api/logs/dates lấy danh sách tài khoản từ TOÀN BỘ ngày, không từ trang phân trang', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = server.indexOf('function listLogDates()');
  const end = server.indexOf('// Danh sách ngày + metadata', start);
  assert.ok(start >= 0 && end > start, 'không tìm thấy listLogDates');
  const fn = server.slice(start, end);

  assert.match(fn, /uniqueLogAccounts\(/, 'metadata phải có danh sách tài khoản của ngày');
  assert.doesNotMatch(fn, /paginateNewestFirst|slice\(/, 'không được lấy tài khoản từ trang phân trang');
});

// ── Hợp đồng UI: LogPanel phải lọc TRƯỚC khi cap ──

test('LogPanel dùng pipeline lọc-trước-cap và có chống race cho request', () => {
  const panel = fs.readFileSync(PANEL, 'utf8');

  assert.match(panel, /mergeLogStreams\(\{/, 'phải dùng helper trộn đã lọc');
  assert.doesNotMatch(
    panel,
    /merged\.slice\(-MAX_RENDER\)/,
    'không được tự trộn rồi cap — cap phải nằm SAU khi lọc trong mergeLogStreams',
  );
  assert.doesNotMatch(
    panel,
    /for \(const entry of liveLogs\) \{\s*const itemDate/,
    'không được trộn realtime chỉ với kiểm tra ngày',
  );
  assert.match(panel, /requestIdRef/, 'phải có thế hệ request chống race');
  assert.match(panel, /resolveFirstPageResponse\(\{/, 'phải bỏ qua phản hồi của request cũ');
  assert.match(panel, /prependOlderPage\(prev, res\)/, 'Load More phải ghép trang cũ lên đầu');
  assert.match(panel, /buildAccountList\(\{/, 'dropdown phải giữ tài khoản đang chọn');
  assert.match(panel, /countLevels\(scopedLogs\)/, 'bộ đếm level phải theo tập đã lọc tài khoản');
  // Export vẫn lấy từ server (đã lọc), không dùng dòng đã trộn realtime.
  assert.match(panel, /api\.fetchLogExport\(\{[\s\S]*?account: filterAccount[\s\S]*?level: filterLevel/);
  // Load More vẫn gửi kèm bộ lọc + cursor.
  assert.match(panel, /cursor: nextCursor/);
});
