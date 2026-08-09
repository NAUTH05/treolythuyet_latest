// ============================================================
//  COURSE SCANNER & DOM TIMER ENGINE
//  Tự động quét khóa học, đọc DOM Timer, kiểm tra Lịch Ngày Học
// ============================================================

// ── Chuẩn hóa múi giờ Việt Nam (Asia/Ho_Chi_Minh, UTC+7 cố định, không DST) ──
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

// URL slide thường chứa nhiều cụm số trong slug (VD: /5-2-...-50987).
// ID thật luôn là cụm số cuối pathname; không được lấy match số đầu tiên.
function extractSlideIdFromUrl(url) {
  try {
    const pathname = new URL(url, 'https://placeholder.local').pathname.replace(/\/+$/, '');
    const lastSegment = pathname.split('/').filter(Boolean).pop() || '';
    const match = lastSegment.match(/-(\d+)$/);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

// Lấy {year, month(0-11), day} theo lịch Việt Nam của một thời điểm bất kỳ
// (không phụ thuộc múi giờ server — VPS chạy UTC vẫn ra đúng ngày VN)
function vnDateParts(date = new Date()) {
  const shifted = new Date(date.getTime() + VN_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

// Khóa so sánh dạng số yyyymmdd cho một ngày lịch
function dateKey(year, month, day) {
  return year * 10000 + (month + 1) * 100 + day;
}

// Parse "25/07" hoặc "25/07/2026" → {year, month(0-11), day} (năm mặc định = năm hiện tại theo giờ VN)
function parseVNShortDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.trim().split('/');
  if (parts.length < 2) return null;
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const year = parts.length >= 3 ? parseInt(parts[2], 10) : vnDateParts().year;
  if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
  return { year, month, day };
}

// Kiểm tra xem thời điểm `date` (theo lịch VN) có thuộc Lịch Ngày Học Được Phép hay không
function isAllowedStudyDate(date = new Date(), allowedRanges = []) {
  if (!allowedRanges || allowedRanges.length === 0) return true; // Trống = cho phép tất cả các ngày

  const p = vnDateParts(date);
  const checkKey = dateKey(p.year, p.month, p.day);

  for (const item of allowedRanges) {
    if (!item) continue;
    const str = String(item).trim();

    if (str.includes('-')) {
      // Dải ngày: "25/07-28/07" hoặc "25/07/2026-28/07/2026"
      const [startStr, endStr] = str.split('-').map(s => s.trim());
      const start = parseVNShortDate(startStr);
      const end = parseVNShortDate(endStr);
      if (start && end) {
        const startKey = dateKey(start.year, start.month, start.day);
        const endKey = dateKey(end.year, end.month, end.day);
        if (checkKey >= startKey && checkKey <= endKey) {
          return true;
        }
      }
    } else {
      // Ngày đơn: "30/07" hoặc "30/07/2026"
      const single = parseVNShortDate(str);
      if (single && dateKey(single.year, single.month, single.day) === checkKey) {
        return true;
      }
    }
  }

  return false;
}

// Tìm ngày học hợp lệ tiếp theo — trả về Date (thời điểm UTC thực) ứng với
// newDayStartTime GIỜ VIỆT NAM của ngày đó (VD 07:00 VN, không phải 07:00 giờ server)
function getNextAllowedStudyDate(fromDate = new Date(), allowedRanges = [], newDayStartTime = '06:00') {
  let startH = 6;
  let startM = 0;
  if (newDayStartTime && typeof newDayStartTime === 'string') {
    const parts = newDayStartTime.split(':').map(Number);
    if (!isNaN(parts[0])) startH = parts[0];
    if (!isNaN(parts[1])) startM = parts[1];
  }

  // Thời điểm UTC thực của startH:startM giờ VN vào ngày (y, m, d)
  const vnMoment = (y, m, d) => new Date(Date.UTC(y, m, d, startH, startM, 0, 0) - VN_OFFSET_MS);

  // Bắt đầu từ ngày mai theo lịch VN, tìm trong 60 ngày tiếp theo
  const from = vnDateParts(fromDate);
  for (let i = 1; i <= 60; i++) {
    const candidate = vnMoment(from.year, from.month, from.day + i); // Date.UTC tự xử lý tràn ngày/tháng
    if (isAllowedStudyDate(candidate, allowedRanges)) {
      return candidate;
    }
  }

  // Fallback: ngày mai (giờ VN) theo newDayStartTime nếu không khớp lịch nào
  return vnMoment(from.year, from.month, from.day + 1);
}

// ── XỬ LÝ KHUNG GIỜ HỌC THEO CA (TIME SHIFTS) ──

// Parse chuỗi ca học dạng "07:00-11:30, 14:00-23:00" → mảng các shift
function parseShifts(shiftsStr) {
  if (!shiftsStr) return [];
  const res = [];
  const parts = String(shiftsStr).split(',').map(s => s.trim()).filter(Boolean);
  for (const p of parts) {
    const range = p.split('-').map(s => s.trim());
    if (range.length === 2) {
      const [sh, sm] = range[0].split(':').map(Number);
      const [eh, em] = range[1].split(':').map(Number);
      if (!isNaN(sh) && !isNaN(eh)) {
        const startMins = sh * 60 + (isNaN(sm) ? 0 : sm);
        const endMins = eh * 60 + (isNaN(em) ? 0 : em);
        res.push({
          start: range[0],
          end: range[1],
          startMins,
          endMins,
        });
      }
    }
  }
  return res;
}

// Tìm danh sách Ca học áp dụng cho ngày `date` dựa trên `customTimeRules`
function getShiftsForDate(date = new Date(), customTimeRules = []) {
  if (!customTimeRules || customTimeRules.length === 0) return [];

  // Tìm quy tắc có `dates` khớp với ngày `date`
  for (const rule of customTimeRules) {
    if (!rule || !rule.shifts) continue;
    const ruleDates = rule.dates ? [rule.dates] : [];
    // Nếu rule.dates rỗng → quy tắc mặc định cho tất cả các ngày
    if (ruleDates.length === 0 || isAllowedStudyDate(date, ruleDates)) {
      const parsed = Array.isArray(rule.shifts) ? rule.shifts : parseShifts(rule.shifts);
      if (parsed.length > 0) return parsed;
    }
  }

  return [];
}

// Kiểm tra thời điểm `date` (VN time) có nằm trong Ca học nào không & tính ms còn lại của ca hiện tại
function calcMsRemainingInShift(date = new Date(), shifts = []) {
  if (!shifts || shifts.length === 0) {
    return { inShift: true, remainingMs: Infinity, currentShift: null, nextShiftToday: null };
  }

  const p = vnDateParts(date);
  // Lấy giờ, phút, giây VN của `date`
  const vnDateObj = new Date(date.getTime() + VN_OFFSET_MS);
  const nowMins = vnDateObj.getUTCHours() * 60 + vnDateObj.getUTCMinutes();
  const nowSecs = vnDateObj.getUTCSeconds();

  // Kiểm tra ca hiện tại
  for (const s of shifts) {
    if (nowMins >= s.startMins && nowMins < s.endMins) {
      const remMins = s.endMins - nowMins;
      const ms = remMins * 60000 - nowSecs * 1000;
      return { inShift: true, remainingMs: Math.max(0, ms), currentShift: s, nextShiftToday: null };
    }
  }

  // Nếu không nằm trong ca nào, tìm ca tiếp theo TRONG NGÀY HÔM NAY (nếu có)
  const futureShiftsToday = shifts.filter(s => s.startMins > nowMins).sort((a, b) => a.startMins - b.startMins);
  const nextShiftToday = futureShiftsToday.length > 0 ? futureShiftsToday[0] : null;

  return { inShift: false, remainingMs: 0, currentShift: null, nextShiftToday };
}

// Tìm thời điểm bắt đầu Ca học tiếp theo (hôm nay hoặc ngày học tiếp theo)
function getNextShiftStart(fromDate = new Date(), customTimeRules = [], allowedRanges = [], defaultNewDayStart = '06:00') {
  const shiftsToday = getShiftsForDate(fromDate, customTimeRules);
  const statusToday = calcMsRemainingInShift(fromDate, shiftsToday);

  // 1. Nếu hôm nay còn Ca học phía sau (chưa đến giờ):
  if (statusToday.nextShiftToday) {
    const s = statusToday.nextShiftToday;
    const startH = Math.floor(s.startMins / 60);
    const startM = s.startMins % 60;
    const p = vnDateParts(fromDate);
    // Trả về thời điểm UTC tương ứng với startH:startM giờ VN hôm nay
    return new Date(Date.UTC(p.year, p.month, p.day, startH, startM, 0, 0) - VN_OFFSET_MS);
  }

  // 2. Nếu hôm nay đã hết tất cả các Ca học: tìm trong các ngày tiếp theo
  const pFrom = vnDateParts(fromDate);
  for (let i = 1; i <= 60; i++) {
    const candidateDate = new Date(Date.UTC(pFrom.year, pFrom.month, pFrom.day + i, 0, 0, 0, 0) - VN_OFFSET_MS);
    if (isAllowedStudyDate(candidateDate, allowedRanges)) {
      const candidateShifts = getShiftsForDate(candidateDate, customTimeRules);
      const candP = vnDateParts(candidateDate);

      if (candidateShifts.length > 0) {
        // Lấy ca đầu tiên của ngày đó
        const firstShift = candidateShifts.sort((a, b) => a.startMins - b.startMins)[0];
        const startH = Math.floor(firstShift.startMins / 60);
        const startM = firstShift.startMins % 60;
        return new Date(Date.UTC(candP.year, candP.month, candP.day, startH, startM, 0, 0) - VN_OFFSET_MS);
      } else {
        // Ngày đó không có quy tắc ca riêng → dùng defaultNewDayStart
        return getNextAllowedStudyDate(fromDate, allowedRanges, defaultNewDayStart);
      }
    }
  }

  // Fallback
  return getNextAllowedStudyDate(fromDate, allowedRanges, defaultNewDayStart);
}

// Quét trang thông tin khóa học (slides/[course-slug]) bằng Playwright
async function scanCourseDetails(page, courseUrl) {
  if (!page) return null;
  try {
    await page.goto(courseUrl, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(3000); // Chờ JS render xong danh sách bài

    const data = await page.evaluate(() => {
      // Title
      const titleEl = document.querySelector('h1') || document.querySelector('.o_wslides_course_header h1');
      const courseTitle = titleEl ? titleEl.textContent.trim() : document.title;

      // Extract "Thời gian hoàn thành" từ card thông tin bên trái
      let actualStudiedMinutes = 0;
      let actualStudiedText = '';
      const sidebarText = document.body.innerText || document.body.textContent || '';
      const timeMatch = sidebarText.match(/Thời\s*gian\s*hoàn\s*thành[\s\n\r:]*(\d+)\s*(?:giờ|h)\s*(\d+)?\s*(?:phút|m)?/i);
      if (timeMatch) {
        const h = parseInt(timeMatch[1], 10) || 0;
        const m = parseInt(timeMatch[2], 10) || 0;
        actualStudiedMinutes = h * 60 + m;
        actualStudiedText = `${h} giờ ${m} phút`;
      }

      // Extract all lesson items
      const lessonItems = [];
      const links = Array.from(document.querySelectorAll('a[href*="/slides/slide/"]'));

      links.forEach(a => {
        const href = a.getAttribute('href');
        const fullUrl = href.startsWith('http') ? href : `${window.location.origin}${href}`;
        const title = a.textContent.trim();

        // Tìm container chứa bài học này (li, tr, list-group-item hoặc o_wslides_slides_list_slide)
        let container = a.closest('li') || a.closest('tr') || a.closest('.list-group-item') || a.closest('.o_wslides_slides_list_slide') || a.closest('.o_wslides_slide_list_record');
        if (!container) {
          container = a.parentElement ? a.parentElement.parentElement : a.parentElement;
        }

        let progressPercent = 0;
        if (container) {
          // Tìm badge chứa phần trăm (hỗ trợ cả "100 %", "100%", "15 %")
          const badgeEl = container.querySelector('.badge, [class*="badge"]');
          const containerText = container.innerText || container.textContent || '';
          
          // Pattern mở rộng: match cả khoảng trắng giữa số và dấu % (/(\d+)\s*%/)
          const matchBadge = badgeEl ? badgeEl.textContent.match(/(\d+)\s*%/) : null;
          const matchText = containerText.match(/(\d+)\s*%/);
          
          if (matchBadge) {
            progressPercent = parseInt(matchBadge[1], 10);
          } else if (matchText) {
            progressPercent = parseInt(matchText[1], 10);
          }
        }

        const isCompleted = progressPercent >= 100;

        if (!lessonItems.some(item => item.url === fullUrl)) {
          lessonItems.push({
            title,
            url: fullUrl,
            progressPercent,
            isCompleted,
          });
        }
      });

      return {
        courseTitle,
        actualStudiedMinutes,
        actualStudiedText,
        totalLessons: lessonItems.length,
        uncompletedLessons: lessonItems.filter(l => !l.isCompleted),
        allLessons: lessonItems,
      };
    });

    return data;
  } catch (err) {
    console.error(`[COURSE SCANNER] Lỗi quét khóa học ${courseUrl}:`, err.message);
    return null;
  }
}

// Đọc bộ đếm ngược DOM Timer (Gọi RPC Odoo /slide/countdown-start/ & Odoo Widget instance)
async function readDomTimer(page) {
  if (!page) return null;
  try {
    await page.waitForTimeout(7000); // Chờ 7 giây cho Odoo JS & API /slide/countdown-start/ render xong hoàn toàn

    const expectedSlideId = extractSlideIdFromUrl(page.url());

    const timer = await page.evaluate(async (slideIdFromUrl) => {
      const makeTimer = (h, m, s, source) => {
        const safeH = isNaN(h) ? 0 : Math.max(0, parseInt(h, 10) || 0);
        const safeM = isNaN(m) ? 0 : Math.max(0, parseInt(m, 10) || 0);
        const safeS = isNaN(s) ? 0 : Math.max(0, parseInt(s, 10) || 0);
        return { hours: safeH, minutes: safeM, seconds: safeS, totalMinutes: safeH * 60 + safeM + (safeS > 0 ? 1 : 0), source };
      };

      // 1. Gọi trực tiếp Odoo RPC Route /slide/countdown-start/ từ trong trang
      try {
        const lastSegment = location.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
        const fallbackMatch = lastSegment.match(/-(\d+)$/);
        const slideId = slideIdFromUrl || (fallbackMatch ? parseInt(fallbackMatch[1], 10) : null);
        if (slideId) {
          const response = await fetch('/slide/countdown-start/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { slide_id: slideId } }),
          });
          const json = await response.json();
          const payload = json.result || json;
          if (payload && payload.end_time !== undefined && payload.end_time !== null) {
            const endTimeSec = parseInt(payload.end_time, 10);
            if (!isNaN(endTimeSec)) {
              const nowSec = Math.floor(Date.now() / 1000);
              const remainingSec = endTimeSec - nowSec;
              if (remainingSec > 0) {
                const h = Math.floor(remainingSec / 3600);
                const m = Math.floor((remainingSec % 3600) / 60);
                const s = remainingSec % 60;
                return makeTimer(h, m, s, 'odoo_rpc_fetch');
              } else {
                return makeTimer(0, 0, 0, 'odoo_rpc_fetch');
              }
            }
          }
        }
      } catch { /* ignore */ }

      // 2. Đọc thuộc tính endTime trực tiếp từ Odoo PublicWidget instance trên DOM
      try {
        const ectEl = document.querySelector('.ect_countdown, section[data-snippet="ect_countdown"], [class*="countdown"]');
        if (ectEl && window.jQuery) {
          const widget = window.jQuery(ectEl).data('publicWidget') || window.jQuery(ectEl).data('ect_employees.ect_countdown');
          if (widget) {
            if (widget.diff && Array.isArray(widget.diff)) {
              let h = 0, m = 0, s = 0;
              widget.diff.forEach(item => {
                if (item.label && item.label.toLowerCase().includes('hour')) h = item.nb || 0;
                if (item.label && item.label.toLowerCase().includes('minute')) m = item.nb || 0;
                if (item.label && item.label.toLowerCase().includes('second')) s = item.nb || 0;
              });
              const resDiff = makeTimer(h, m, s, 'odoo_widget_diff');
              if (resDiff) return resDiff;
            }

            if (widget.endTime) {
              const nowSec = Math.floor(Date.now() / 1000);
              const remainingSec = widget.endTime - nowSec;
              if (remainingSec > 0) {
                const h = Math.floor(remainingSec / 3600);
                const m = Math.floor((remainingSec % 3600) / 60);
                const s = remainingSec % 60;
                return makeTimer(h, m, s, 'odoo_widget_endtime');
              } else {
                return makeTimer(0, 0, 0, 'odoo_widget_endtime');
              }
            }
          }
        }
      } catch { /* ignore */ }

      // 3. Quét duy nhất trong khung chứa bộ đếm .ect_countdown_canvas_wrapper hoặc các thẻ chứa timer
      const ectSection = document.querySelector('.ect_countdown_canvas_wrapper, .ect_countdown, section[data-snippet="ect_countdown"], [class*="countdown"], .o_wslides_lesson_content');
      if (ectSection) {
        const text = ectSection.innerText || ectSection.textContent || '';

        // Match HH:MM:SS or MM:SS
        const timeMatch = text.match(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/);
        if (timeMatch) {
          const h = timeMatch[1] ? parseInt(timeMatch[1], 10) : 0;
          const m = parseInt(timeMatch[2], 10);
          const s = parseInt(timeMatch[3], 10);
          return makeTimer(h, m, s, 'ect_section_hhmmss');
        }

        const hMatch = text.match(/(\d+)[\s\n\r]*(?:Giờ|h)/i);
        const mMatch = text.match(/(\d+)[\s\n\r]*(?:Phút|m)/i);
        const sMatch = text.match(/(\d+)[\s\n\r]*(?:Giây|s)/i);

        if (hMatch || mMatch || sMatch) {
          const h = hMatch ? parseInt(hMatch[1], 10) : 0;
          const m = mMatch ? parseInt(mMatch[1], 10) : 0;
          const s = sMatch ? parseInt(sMatch[1], 10) : 0;
          return makeTimer(h, m, s, 'ect_section_text');
        }
      }

      return null;
    }, expectedSlideId);

    return timer;
  } catch (err) {
    return null;
  }
}

module.exports = {
  isAllowedStudyDate,
  getNextAllowedStudyDate,
  scanCourseDetails,
  readDomTimer,
  parseVNShortDate,
  parseShifts,
  getShiftsForDate,
  calcMsRemainingInShift,
  getNextShiftStart,
  extractSlideIdFromUrl,
};
