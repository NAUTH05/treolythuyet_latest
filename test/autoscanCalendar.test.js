const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const MODULE = path.join(__dirname, '..', 'src', 'autoscanCalendar.mjs');
let modulePromise = null;
function load() {
  if (!modulePromise) modulePromise = import(pathToFileURL(MODULE).href);
  return modulePromise;
}

const REF = 2026;

test('chọn/bỏ chọn một ngày (single click)', async () => {
  const { toggleDateSelection } = await load();
  let sel = toggleDateSelection([], '2026-09-18');
  assert.deepEqual(sel, ['2026-09-18']);
  sel = toggleDateSelection(sel, '2026-09-18');
  assert.deepEqual(sel, []);
});

test('drag 18 → 21 chọn cả dải', async () => {
  const { paintDateSelection } = await load();
  const sel = paintDateSelection([], '2026-09-18', '2026-09-21', 'select');
  assert.deepEqual(sel, ['2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21']);
});

test('drag bắt đầu từ ô đã chọn → deselect cả dải', async () => {
  const { paintDateSelection } = await load();
  const initial = ['2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21'];
  const sel = paintDateSelection(initial, '2026-09-19', '2026-09-21', 'deselect');
  assert.deepEqual(sel, ['2026-09-18']);
});

test('serialize nén dải liên tiếp: 18-20,23,25-27 → "18/09-20/09, 23/09, 25/09-27/09"', async () => {
  const { serializeSelectedDates } = await load();
  const dates = [
    '2026-09-18', '2026-09-19', '2026-09-20',
    '2026-09-23',
    '2026-09-25', '2026-09-26', '2026-09-27',
  ];
  assert.equal(serializeSelectedDates(dates, { referenceYear: REF }), '18/09-20/09, 23/09, 25/09-27/09');
});

test('serialize sắp xếp và bỏ trùng trước khi nén', async () => {
  const { serializeSelectedDates } = await load();
  const dates = ['2026-09-20', '2026-09-18', '2026-09-19', '2026-09-18'];
  assert.equal(serializeSelectedDates(dates, { referenceYear: REF }), '18/09-20/09');
});

test('parse chuỗi preset cũ "18/09-20/09, 23/09"', async () => {
  const { parseAllowedDateRanges } = await load();
  const dates = parseAllowedDateRanges('18/09-20/09, 23/09', { referenceYear: REF });
  assert.deepEqual(dates, ['2026-09-18', '2026-09-19', '2026-09-20', '2026-09-23']);
});

test('round-trip serialize ↔ parse', async () => {
  const { serializeSelectedDates, parseAllowedDateRanges } = await load();
  const dates = ['2026-09-18', '2026-09-19', '2026-09-20', '2026-09-23', '2026-09-25'];
  const text = serializeSelectedDates(dates, { referenceYear: REF });
  assert.deepEqual(parseAllowedDateRanges(text, { referenceYear: REF }), dates);
});

test('qua ranh giới năm: ngày khác năm được ghi kèm năm và round-trip đúng', async () => {
  const { serializeSelectedDates, parseAllowedDateRanges } = await load();
  const dates = ['2026-12-30', '2026-12-31', '2027-01-01'];
  const text = serializeSelectedDates(dates, { referenceYear: REF });
  assert.ok(text.includes('2027'), `phải giữ năm cho ngày 2027: ${text}`);
  assert.deepEqual(parseAllowedDateRanges(text, { referenceYear: REF }), dates);
});

test('manual text hợp lệ → cập nhật selection', async () => {
  const { validateAllowedDateText } = await load();
  const res = validateAllowedDateText('18/09-20/09, 23/09', { referenceYear: REF });
  assert.equal(res.valid, true);
  assert.deepEqual(res.dates, ['2026-09-18', '2026-09-19', '2026-09-20', '2026-09-23']);
});

test('manual text sai KHÔNG âm thầm phá selection (trả lỗi)', async () => {
  const { validateAllowedDateText } = await load();
  const bad = validateAllowedDateText('18/09-abc', { referenceYear: REF });
  assert.equal(bad.valid, false);
  assert.ok(bad.error);
  const reversed = validateAllowedDateText('20/09-18/09', { referenceYear: REF });
  assert.equal(reversed.valid, false);
});

test('manual text rỗng hợp lệ (bỏ trống = không giới hạn)', async () => {
  const { validateAllowedDateText } = await load();
  const res = validateAllowedDateText('   ', { referenceYear: REF });
  assert.equal(res.valid, true);
  assert.deepEqual(res.dates, []);
});

test('buildMonthGrid Thứ 2 → Chủ nhật, tháng 9/2026 bắt đầu 31/08', async () => {
  const { buildMonthGrid } = await load();
  const weeks = buildMonthGrid(2026, 9);
  assert.deepEqual(Object.keys(weeks[0][0]), ['iso', 'day', 'inMonth']);
  assert.equal(weeks[0][0].iso, '2026-08-31');
  assert.equal(weeks[0][1].iso, '2026-09-01');
  assert.equal(weeks[0][0].inMonth, false);
  assert.equal(weeks[0][1].inMonth, true);
  // Mọi tuần đủ 7 ô
  for (const week of weeks) assert.equal(week.length, 7);
  // Ô 01/09 có mặt
  const flat = weeks.flat();
  assert.ok(flat.some(c => c.iso === '2026-09-01' && c.inMonth));
});

test('addMonths xử lý chuyển năm', async () => {
  const { addMonths } = await load();
  assert.deepEqual(addMonths(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(addMonths(2026, 1, -1), { year: 2025, month: 12 });
  assert.deepEqual(addMonths(2026, 9, 0), { year: 2026, month: 9 });
});

test('monthLabel đúng định dạng', async () => {
  const { monthLabel } = await load();
  assert.equal(monthLabel(2026, 9), 'Tháng 9/2026');
});

test('todayISO theo múi giờ Việt Nam, không lệch ngày do UTC', async () => {
  const { todayISO } = await load();
  // 2026-09-20T18:00:00Z → 01:00 ngày 21/09 giờ VN
  assert.equal(todayISO(new Date('2026-09-20T18:00:00Z')), '2026-09-21');
  // 2026-09-20T16:59:00Z → 23:59 ngày 20/09 giờ VN
  assert.equal(todayISO(new Date('2026-09-20T16:59:00Z')), '2026-09-20');
});

test('isValidISODate từ chối ngày không tồn tại', async () => {
  const { isValidISODate } = await load();
  assert.equal(isValidISODate('2026-02-30'), false);
  assert.equal(isValidISODate('2026-13-01'), false);
  assert.equal(isValidISODate('2026-02-28'), true);
  assert.equal(isValidISODate('nonsense'), false);
});
