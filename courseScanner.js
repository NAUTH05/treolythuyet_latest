// ============================================================
//  COURSE SCANNER & DOM TIMER ENGINE
//  Tự động quét khóa học, đọc DOM Timer, kiểm tra Lịch Ngày Học
// ============================================================

function parseVNShortDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.trim().split('/');
  if (parts.length < 2) return null;
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const year = parts.length >= 3 ? parseInt(parts[2], 10) : new Date().getFullYear();
  return new Date(year, month, day, 0, 0, 0, 0);
}

// Kiểm tra xem ngày (Date object) có thuộc Lịch Ngày Học Được Phép hay không
function isAllowedStudyDate(date = new Date(), allowedRanges = []) {
  if (!allowedRanges || allowedRanges.length === 0) return true; // Trống = cho phép tất cả các ngày

  const checkDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const checkTime = checkDate.getTime();

  for (const item of allowedRanges) {
    if (!item) continue;
    const str = String(item).trim();

    if (str.includes('-')) {
      // Dải ngày: "25/07-28/07" hoặc "25/07/2026-28/07/2026"
      const [startStr, endStr] = str.split('-').map(s => s.trim());
      const startDate = parseVNShortDate(startStr);
      const endDate = parseVNShortDate(endStr);
      if (startDate && endDate) {
        endDate.setHours(23, 59, 59, 999);
        if (checkTime >= startDate.getTime() && checkTime <= endDate.getTime()) {
          return true;
        }
      }
    } else {
      // Ngày đơn: "30/07" hoặc "30/07/2026"
      const singleDate = parseVNShortDate(str);
      if (singleDate && singleDate.getTime() === checkTime) {
        return true;
      }
    }
  }

  return false;
}

// Tìm ngày học hợp lệ tiếp theo (trả về Date object theo newDayStartTime, ví dụ 06:00 AM)
function getNextAllowedStudyDate(fromDate = new Date(), allowedRanges = [], newDayStartTime = '06:00') {
  const current = new Date(fromDate);
  current.setDate(current.getDate() + 1);

  let startH = 6;
  let startM = 0;
  if (newDayStartTime && typeof newDayStartTime === 'string') {
    const parts = newDayStartTime.split(':').map(Number);
    if (!isNaN(parts[0])) startH = parts[0];
    if (!isNaN(parts[1])) startM = parts[1];
  }
  current.setHours(startH, startM, 0, 0);

  // Tìm trong 60 ngày tiếp theo
  for (let i = 0; i < 60; i++) {
    if (isAllowedStudyDate(current, allowedRanges)) {
      return current;
    }
    current.setDate(current.getDate() + 1);
  }

  // Fallback ngày mai theo newDayStartTime nếu không khớp
  const fallback = new Date(fromDate);
  fallback.setDate(fallback.getDate() + 1);
  fallback.setHours(startH, startM, 0, 0);
  return fallback;
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
    await page.waitForTimeout(3000);

    const timer = await page.evaluate(async () => {
      const makeTimer = (h, m, s, source) => {
        const safeH = isNaN(h) ? 0 : Math.max(0, parseInt(h, 10) || 0);
        const safeM = isNaN(m) ? 0 : Math.max(0, parseInt(m, 10) || 0);
        const safeS = isNaN(s) ? 0 : Math.max(0, parseInt(s, 10) || 0);
        if (safeH > 0 || safeM > 0 || safeS > 0) {
          return { hours: safeH, minutes: safeM, seconds: safeS, totalMinutes: safeH * 60 + safeM + (safeS > 0 ? 1 : 0), source };
        }
        return null;
      };

      // 1. Gọi trực tiếp Odoo RPC Route /slide/countdown-start/ từ trong trang
      try {
        const slideIdMatch = location.href.match(/-(\d+)\b/);
        if (slideIdMatch) {
          const slideId = parseInt(slideIdMatch[1], 10);
          const response = await fetch('/slide/countdown-start/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { slide_id: slideId } }),
          });
          const json = await response.json();
          const payload = json.result || json;
          if (payload && payload.end_time) {
            const endTimeSec = parseInt(payload.end_time, 10);
            const nowSec = Math.floor(Date.now() / 1000);
            const remainingSec = endTimeSec - nowSec;
            if (remainingSec > 0) {
              const h = Math.floor(remainingSec / 3600);
              const m = Math.floor((remainingSec % 3600) / 60);
              const s = remainingSec % 60;
              return makeTimer(h, m, s, 'odoo_rpc_fetch');
            }
          }
        }
      } catch { /* ignore */ }

      // 2. Đọc thuộc tính endTime trực tiếp từ Odoo PublicWidget instance trên DOM
      try {
        const ectEl = document.querySelector('.ect_countdown, section[data-snippet="ect_countdown"]');
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
              }
            }
          }
        }
      } catch { /* ignore */ }

      // 3. Quét duy nhất trong khung chứa bộ đếm .ect_countdown_canvas_wrapper
      const ectSection = document.querySelector('.ect_countdown_canvas_wrapper, .ect_countdown, section[data-snippet="ect_countdown"]');
      if (ectSection) {
        const text = ectSection.innerText || ectSection.textContent || '';
        const hMatch = text.match(/(\d+)[\s\n\r]*(?:Giờ|h)/i);
        const mMatch = text.match(/(\d+)[\s\n\r]*(?:Phút|m)/i);
        const sMatch = text.match(/(\d+)[\s\n\r]*(?:Giây|s)/i);

        const h = hMatch ? parseInt(hMatch[1], 10) : 0;
        const m = mMatch ? parseInt(mMatch[1], 10) : 0;
        const s = sMatch ? parseInt(sMatch[1], 10) : 0;

        const res = makeTimer(h, m, s, 'ect_section_text');
        if (res) return res;
      }

      return null;
    });

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
};
