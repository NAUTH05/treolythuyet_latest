// ============================================================
//  AUTO-SCAN CALENDAR (pure helpers, dùng chung cho UI + test)
// ============================================================
// - Dữ liệu nội bộ: chuỗi ngày canonical "YYYY-MM-DD" (KHÔNG dùng Date parse
//   phụ thuộc locale).
// - Mọi phép tính lịch chạy trên UTC để tránh lệch 1 ngày do múi giờ.
// - Serialize ra ĐÚNG định dạng backend đang dùng: "18/09-20/09, 23/09".
//   Ngày ngoài "năm tham chiếu" được ghi kèm năm ("05/01/2027") để parser cũ vẫn
//   đọc đúng, không phá preset hiện có.

const VN_TIME_ZONE = 'Asia/Ho_Chi_Minh';

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Năm hiện tại theo giờ Việt Nam (dùng làm mốc cho định dạng không năm).
export function referenceYearVN(now = new Date()) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone: VN_TIME_ZONE, year: 'numeric' })
      .format(now));
  } catch {
    return new Date().getUTCFullYear();
  }
}

export function toISODate(year, month /* 1-12 */, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

// "2026-09-18" → { year, month(1-12), day } | null
export function parseISODate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

export function isValidISODate(iso) {
  const parts = parseISODate(iso);
  if (!parts) return false;
  const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return check.getUTCFullYear() === parts.year
    && check.getUTCMonth() === parts.month - 1
    && check.getUTCDate() === parts.day;
}

function isoToUTC(iso) {
  const parts = parseISODate(iso);
  if (!parts) return NaN;
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

export function compareISO(a, b) {
  return isoToUTC(a) - isoToUTC(b);
}

function utcToISO(ms) {
  const d = new Date(ms);
  return toISODate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function addDaysISO(iso, delta) {
  const parts = parseISODate(iso);
  if (!parts) return null;
  return utcToISO(Date.UTC(parts.year, parts.month - 1, parts.day + delta));
}

// "2026-09-18" → "18/09" (kèm năm nếu khác năm tham chiếu)
export function formatShortVN(iso, referenceYear = null) {
  const parts = parseISODate(iso);
  if (!parts) return '';
  const short = `${pad2(parts.day)}/${pad2(parts.month)}`;
  if (referenceYear != null && parts.year !== referenceYear) {
    return `${short}/${parts.year}`;
  }
  return short;
}

// ── Parse ──
// "25/07" | "25/07/2026" → ISO
export function parseShortVN(token, referenceYear) {
  const text = String(token || '').trim();
  if (!text) return null;
  const parts = text.split('/');
  if (parts.length < 2) return null;
  const day = Number(parts[0]);
  const month = Number(parts[1]);
  const year = parts.length >= 3 ? Number(parts[2]) : Number(referenceYear);
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return null;
  const iso = toISODate(year, month, day);
  return isValidISODate(iso) ? iso : null;
}

// Parse chuỗi allowedDateRanges → mảng ISO tăng dần, KHÔNG trùng.
// Token hỏng bị bỏ qua; token hợp lệ vẫn được giữ.
export function parseAllowedDateRanges(text, { referenceYear = referenceYearVN() } = {}) {
  const out = new Set();
  const tokens = String(text || '').split(',').map(t => t.trim()).filter(Boolean);
  for (const token of tokens) {
    if (token.includes('-')) {
      const [startStr, endStr] = token.split('-').map(s => s.trim());
      const startIso = parseShortVN(startStr, referenceYear);
      const endIso = parseShortVN(endStr, referenceYear);
      if (!startIso || !endIso) continue;
      let cursor = startIso;
      let guard = 0;
      while (compareISO(cursor, endIso) <= 0 && guard < 400) {
        out.add(cursor);
        cursor = addDaysISO(cursor, 1);
        guard++;
      }
    } else {
      const iso = parseShortVN(token, referenceYear);
      if (iso) out.add(iso);
    }
  }
  return [...out].sort(compareISO);
}

// Kiểm tra chuỗi manual có hợp lệ không (mọi token phải parse được và start<=end).
export function validateAllowedDateText(text, { referenceYear = referenceYearVN() } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { valid: true, dates: [], error: null };
  const tokens = raw.split(',').map(t => t.trim()).filter(Boolean);
  const dates = new Set();
  for (const token of tokens) {
    if (token.includes('-')) {
      const [startStr, endStr] = token.split('-').map(s => s.trim());
      const startIso = parseShortVN(startStr, referenceYear);
      const endIso = parseShortVN(endStr, referenceYear);
      if (!startIso || !endIso) {
        return { valid: false, dates: [], error: `Khoảng ngày không hợp lệ: "${token}"` };
      }
      if (compareISO(startIso, endIso) > 0) {
        return { valid: false, dates: [], error: `Ngày bắt đầu sau ngày kết thúc: "${token}"` };
      }
      let cursor = startIso;
      let guard = 0;
      while (compareISO(cursor, endIso) <= 0 && guard < 400) {
        dates.add(cursor);
        cursor = addDaysISO(cursor, 1);
        guard++;
      }
    } else {
      const iso = parseShortVN(token, referenceYear);
      if (!iso) return { valid: false, dates: [], error: `Ngày không hợp lệ: "${token}"` };
      dates.add(iso);
    }
  }
  return { valid: true, dates: [...dates].sort(compareISO), error: null };
}

// ── Serialize ──
// Danh sách ISO rời rạc → "18/09-20/09, 23/09, 25/09-27/09".
// Nén các ngày liên tiếp; ngày khác năm tham chiếu ghi kèm năm.
export function serializeSelectedDates(isoDates, { referenceYear = referenceYearVN() } = {}) {
  const sorted = [...new Set((isoDates || []).filter(isValidISODate))].sort(compareISO);
  if (sorted.length === 0) return '';
  const runs = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const expected = addDaysISO(prev, 1);
    if (sorted[i] === expected) {
      prev = sorted[i];
      continue;
    }
    runs.push([start, prev]);
    start = sorted[i];
    prev = sorted[i];
  }
  runs.push([start, prev]);

  return runs.map(([runStart, runEnd]) => {
    if (runStart === runEnd) return formatShortVN(runStart, referenceYear);
    // Một khoảng chỉ nén được khi 2 đầu cùng năm (định dạng range không mang năm).
    const a = parseISODate(runStart);
    const b = parseISODate(runEnd);
    if (a.year === b.year) {
      return `${formatShortVN(runStart, referenceYear)}-${formatShortVN(runEnd, referenceYear)}`;
    }
    // Khác năm → liệt kê từng ngày kèm năm để không mơ hồ.
    const singles = [];
    let cursor = runStart;
    let guard = 0;
    while (compareISO(cursor, runEnd) <= 0 && guard < 400) {
      singles.push(formatShortVN(cursor, referenceYear));
      cursor = addDaysISO(cursor, 1);
      guard++;
    }
    return singles.join(', ');
  }).join(', ');
}

export const compressDateSelection = serializeSelectedDates;

// ── Chọn / tô ngày ──
export function toggleDateSelection(isoDates, iso) {
  const set = new Set(isoDates || []);
  if (!isValidISODate(iso)) return [...set].sort(compareISO);
  if (set.has(iso)) set.delete(iso);
  else set.add(iso);
  return [...set].sort(compareISO);
}

// Tô một dải ngày [fromIso..toIso] theo mode: 'select' | 'deselect'.
export function paintDateSelection(isoDates, fromIso, toIso, mode = 'select') {
  const set = new Set(isoDates || []);
  if (!isValidISODate(fromIso) || !isValidISODate(toIso)) return [...set].sort(compareISO);
  const [lo, hi] = compareISO(fromIso, toIso) <= 0 ? [fromIso, toIso] : [toIso, fromIso];
  let cursor = lo;
  let guard = 0;
  while (compareISO(cursor, hi) <= 0 && guard < 400) {
    if (mode === 'deselect') set.delete(cursor);
    else set.add(cursor);
    cursor = addDaysISO(cursor, 1);
    guard++;
  }
  return [...set].sort(compareISO);
}

// ── Lưới tháng (Thứ 2 → Chủ nhật) ──
export function buildMonthGrid(year, month /* 1-12 */) {
  const firstMs = Date.UTC(year, month - 1, 1);
  const firstDow = new Date(firstMs).getUTCDay(); // 0=CN
  const leading = (firstDow + 6) % 7; // Thứ 2 = 0
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const cells = [];
  for (let i = 0; i < leading; i++) {
    const iso = utcToISO(firstMs - (leading - i) * 86400000);
    cells.push({ iso, day: parseISODate(iso).day, inMonth: false });
  }
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({ iso: toISODate(year, month, day), day, inMonth: true });
  }
  const totalCells = Math.ceil(cells.length / 7) * 7;
  while (cells.length < totalCells) {
    const offset = cells.length - (leading + daysInMonth); // 0-based day vào tháng sau
    const iso = utcToISO(Date.UTC(year, month - 1, daysInMonth + offset + 1));
    cells.push({ iso, day: parseISODate(iso).day, inMonth: false });
  }

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function addMonths(year, month /* 1-12 */, delta) {
  const total = (year * 12) + (month - 1) + delta;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

export function monthLabel(year, month) {
  return `Tháng ${month}/${year}`;
}

// ── Chọn năm trực tiếp ──
// Khoảng năm gợi ý quanh năm hiện tại (giờ VN): hiện tại − 5 … hiện tại + 10.
export const YEAR_RANGE_BACK = 5;
export const YEAR_RANGE_FORWARD = 10;

// Chuẩn hoá một năm: null/undefined/'' và mọi giá trị không phải số nguyên dương
// đều trả về null. (Number(null) === 0 nên không thể chỉ dựa vào Number.isInteger.)
function toValidYear(value) {
  if (value === null || value === undefined || value === '') return null;
  const year = Number(value);
  return Number.isInteger(year) && year >= 1 && year <= 9999 ? year : null;
}

// Danh sách năm cho <select>: khoảng mặc định quanh năm tham chiếu, cộng mọi năm
// đang có trong ngày đã chọn (để preset ngoài khoảng vẫn chọn được) và năm đang
// hiển thị. Luôn tăng dần và không trùng.
export function buildYearOptions({
  referenceYear = referenceYearVN(),
  selectedDates = [],
  displayedYear = null,
} = {}) {
  const years = new Set();
  const ref = toValidYear(referenceYear);
  if (ref !== null) {
    for (let year = ref - YEAR_RANGE_BACK; year <= ref + YEAR_RANGE_FORWARD; year++) years.add(year);
  }
  for (const iso of selectedDates || []) {
    const parts = parseISODate(iso);
    if (parts) years.add(parts.year);
  }
  const shown = toValidYear(displayedYear);
  if (shown !== null) years.add(shown);
  return [...years].sort((a, b) => a - b);
}

// Đổi năm đang hiển thị nhưng GIỮ NGUYÊN tháng đang xem. Năm không hợp lệ bị bỏ
// qua (trả về view cũ). Hàm thuần nên không đụng tới danh sách ngày đã chọn —
// người dùng đổi năm qua lại không làm mất lựa chọn hiện có.
export function changeCalendarYear(view, year) {
  const current = view && Number.isInteger(view.year) && Number.isInteger(view.month)
    ? { year: view.year, month: view.month }
    : null;
  if (!current) return view;
  const next = toValidYear(year);
  if (next === null) return current;
  return { year: next, month: current.month };
}

export function todayISO(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: VN_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
    return parts;
  } catch {
    return utcToISO(now.getTime());
  }
}
