const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const MODULE = path.join(ROOT, 'src', 'autoscanCalendar.mjs');

let modulePromise = null;
function load() {
  if (!modulePromise) modulePromise = import(pathToFileURL(MODULE).href);
  return modulePromise;
}

const REF = 2026;

// ── Bộ chọn năm ──

test('khoảng năm mặc định là năm hiện tại − 5 … năm hiện tại + 10', async () => {
  const { buildYearOptions, YEAR_RANGE_BACK, YEAR_RANGE_FORWARD } = await load();
  const years = buildYearOptions({ referenceYear: REF });
  assert.equal(years[0], REF - YEAR_RANGE_BACK);
  assert.equal(years[years.length - 1], REF + YEAR_RANGE_FORWARD);
  assert.equal(years.length, YEAR_RANGE_BACK + YEAR_RANGE_FORWARD + 1);
  assert.deepEqual(years, [...years].sort((a, b) => a - b), 'phải tăng dần');
  assert.equal(new Set(years).size, years.length, 'không trùng năm');
});

test('năm đang hiển thị luôn có trong danh sách (dù ngoài khoảng mặc định)', async () => {
  const { buildYearOptions } = await load();
  assert.ok(buildYearOptions({ referenceYear: REF, displayedYear: 2099 }).includes(2099));
  assert.ok(buildYearOptions({ referenceYear: REF, displayedYear: 1999 }).includes(1999));
});

test('năm có trong ngày đã chọn vẫn chọn được (preset cũ ngoài khoảng mặc định)', async () => {
  const { buildYearOptions } = await load();
  const years = buildYearOptions({
    referenceYear: REF,
    selectedDates: ['2019-03-05', '2033-12-31', '2026-09-18'],
  });
  assert.ok(years.includes(2019), 'năm 2019 của preset cũ phải còn trong danh sách');
  assert.ok(years.includes(2033));
  assert.ok(years.includes(2026));
  assert.deepEqual(years, [...years].sort((a, b) => a - b));
});

test('ngày hỏng trong lựa chọn bị bỏ qua, không làm vỡ bộ chọn năm', async () => {
  const { buildYearOptions } = await load();
  const years = buildYearOptions({ referenceYear: REF, selectedDates: ['', 'nonsense', '2026-13-40', '2027-01-01'] });
  assert.ok(years.includes(2027));
  assert.ok(years.every(year => Number.isInteger(year) && year > 0));
});

// ── Đổi năm giữ nguyên tháng + không mất ngày đã chọn ──

test('đổi năm GIỮ NGUYÊN tháng đang hiển thị', async () => {
  const { changeCalendarYear } = await load();
  assert.deepEqual(changeCalendarYear({ year: 2026, month: 9 }, 2031), { year: 2031, month: 9 });
  assert.deepEqual(changeCalendarYear({ year: 2026, month: 2 }, 2021), { year: 2021, month: 2 });
  assert.deepEqual(changeCalendarYear({ year: 2026, month: 12 }, '2027'), { year: 2027, month: 12 });
});

test('năm không hợp lệ bị bỏ qua (giữ nguyên view cũ)', async () => {
  const { changeCalendarYear } = await load();
  const view = { year: 2026, month: 9 };
  assert.deepEqual(changeCalendarYear(view, ''), view);
  assert.deepEqual(changeCalendarYear(view, 'abc'), view);
  assert.deepEqual(changeCalendarYear(view, null), view);
  assert.deepEqual(changeCalendarYear(view, 0), view);
  assert.deepEqual(changeCalendarYear(view, 1.5), view);
});

test('đổi năm không mutate view truyền vào', async () => {
  const { changeCalendarYear } = await load();
  const view = { year: 2026, month: 9 };
  const next = changeCalendarYear(view, 2030);
  assert.notEqual(next, view);
  assert.deepEqual(view, { year: 2026, month: 9 });
});

test('đổi năm qua lại không làm thay đổi ngày đã chọn', async () => {
  const { changeCalendarYear, serializeSelectedDates, buildMonthGrid } = await load();
  const selected = ['2026-09-18', '2026-09-19', '2027-01-01'];
  const before = serializeSelectedDates(selected, { referenceYear: REF });

  let view = { year: 2026, month: 9 };
  for (const year of [2031, 2019, 2026, 2027]) view = changeCalendarYear(view, year);

  // Lựa chọn là dữ liệu độc lập với view; đổi năm chỉ dựng lại lưới tháng.
  assert.deepEqual(serializeSelectedDates(selected, { referenceYear: REF }), before);
  assert.deepEqual(buildMonthGrid(view.year, view.month).flat().filter(c => selected.includes(c.iso)).map(c => c.iso), []);
  assert.deepEqual(buildMonthGrid(2026, 9).flat().filter(c => selected.includes(c.iso)).map(c => c.iso), ['2026-09-18', '2026-09-19']);
});

test('lưới tháng dựng đúng cho năm xa (qua bộ chọn năm)', async () => {
  const { buildMonthGrid } = await load();
  const weeks = buildMonthGrid(2035, 2);
  assert.equal(weeks.flat().some(c => c.iso === '2035-02-01' && c.inMonth), true);
  for (const week of weeks) assert.equal(week.length, 7);
});

// ── Serialize/parse xuyên năm vẫn đúng khi chọn năm xa ──

test('ngày ở năm xa vẫn serialize kèm năm và round-trip đúng', async () => {
  const { serializeSelectedDates, parseAllowedDateRanges } = await load();
  const dates = ['2026-09-18', '2035-02-01', '2035-02-02'];
  const text = serializeSelectedDates(dates, { referenceYear: REF });
  assert.ok(text.includes('2035'), `phải ghi kèm năm cho ngày 2035: ${text}`);
  assert.deepEqual(parseAllowedDateRanges(text, { referenceYear: REF }), dates);
});

test('khoảng vắt qua ranh giới năm liệt kê từng ngày kèm năm (không mơ hồ)', async () => {
  const { serializeSelectedDates, parseAllowedDateRanges } = await load();
  const dates = ['2026-12-31', '2027-01-01', '2027-01-02'];
  const text = serializeSelectedDates(dates, { referenceYear: REF });
  assert.deepEqual(parseAllowedDateRanges(text, { referenceYear: REF }), dates);
});

// ── Hợp đồng UI của lịch ──

test('AllowedDateCalendar có bộ chọn năm, giữ nút tháng trước/sau và không đụng lựa chọn khi đổi năm', () => {
  const source = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'AllowedDateCalendar.jsx'), 'utf8');
  assert.match(source, /buildYearOptions\(\{ referenceYear: refYear, selectedDates: value, displayedYear: view\.year \}\)/);
  assert.match(source, /value=\{view\.year\}/);
  assert.match(source, /aria-label="Tháng trước"/);
  assert.match(source, /aria-label="Tháng sau"/);

  const start = source.indexOf('const goYear');
  assert.notEqual(start, -1, 'phải có handler đổi năm');
  const handler = source.slice(start, source.indexOf('\n', start));
  assert.match(handler, /changeCalendarYear/);
  assert.doesNotMatch(handler, /onChange/, 'đổi năm không được đụng tới ngày đã chọn');
  assert.doesNotMatch(handler, /toggleDateSelection|paintDateSelection/);
});
