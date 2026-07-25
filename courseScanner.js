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

// Tìm ngày học hợp lệ tiếp theo (trả về Date object lúc 06:00 AM)
function getNextAllowedStudyDate(fromDate = new Date(), allowedRanges = []) {
  const current = new Date(fromDate);
  current.setDate(current.getDate() + 1);
  current.setHours(6, 0, 0, 0);

  // Tìm trong 60 ngày tiếp theo
  for (let i = 0; i < 60; i++) {
    if (isAllowedStudyDate(current, allowedRanges)) {
      return current;
    }
    current.setDate(current.getDate() + 1);
  }

  // Fallback ngày mai lúc 06:00 AM nếu không khớp
  const fallback = new Date(fromDate);
  fallback.setDate(fallback.getDate() + 1);
  fallback.setHours(6, 0, 0, 0);
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

      // Extract all lesson items
      const lessonItems = [];
      const links = Array.from(document.querySelectorAll('a[href*="/slides/slide/"]'));

      links.forEach(a => {
        const href = a.getAttribute('href');
        const fullUrl = href.startsWith('http') ? href : `${window.location.origin}${href}`;
        const title = a.textContent.trim();

        // Tìm container chứa bài học này (li, tr, list-group-item hoặc d-flex)
        let container = a.closest('li') || a.closest('tr') || a.closest('.list-group-item') || a.closest('.o_wslides_slide_list_record');
        if (!container) {
          // Fallback: leo ngược 2 cấp cha
          container = a.parentElement ? a.parentElement.parentElement : a.parentElement;
        }

        let progressPercent = 0;
        if (container) {
          // Tìm badge chứa phần trăm
          const badgeEl = container.querySelector('.badge, [class*="badge"]');
          const containerText = container.innerText || container.textContent || '';
          
          const matchBadge = badgeEl ? badgeEl.textContent.match(/(\d+)%/) : null;
          const matchText = containerText.match(/(\d+)%/);
          
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

// Đọc bộ đếm ngược DOM Timer (ECT Countdown: Vòng tròn đếm ngược 3 Giờ | 59 Phút | 58 Giây)
async function readDomTimer(page) {
  if (!page) return null;
  try {
    // Chờ ECT Countdown JS khởi tạo và render xong
    await page.waitForTimeout(3000);

    const timer = await page.evaluate(() => {
      // 1. Kiểm tra phần tử .ect_countdown hoặc section[data-snippet="ect_countdown"]
      const ectSection = document.querySelector('.ect_countdown, section[data-snippet="ect_countdown"], [data-name="ECT Countdown"]');
      if (ectSection) {
        // Tìm tất cả text chứa trong ectSection
        const text = ectSection.innerText || ectSection.textContent || '';
        
        // Pattern A: "3 Giờ 59 Phút 58 Giây" hoặc "3 Giờ 59 Phút"
        const matchHMS = text.match(/(\d+)\s*(?:Giờ|h)\s*(\d+)\s*(?:Phút|m)\s*(\d+)?\s*(?:Giây|s)?/i);
        if (matchHMS) {
          const h = parseInt(matchHMS[1], 10) || 0;
          const m = parseInt(matchHMS[2], 10) || 0;
          const s = parseInt(matchHMS[3], 10) || 0;
          if (h > 0 || m > 0) {
            return { hours: h, minutes: m, seconds: s, totalMinutes: h * 60 + m + (s > 0 ? 1 : 0) };
          }
        }

        // Pattern B: Đọc từ các flex items bên trong ect_countdown_canvas_wrapper
        const flexItems = Array.from(ectSection.querySelectorAll('.ect_countdown_canvas_flex, .ect_countdown_flex, div'));
        const numbers = [];
        flexItems.forEach(el => {
          const txt = el.innerText.trim();
          const numMatch = txt.match(/^(\d+)$/);
          if (numMatch) {
            numbers.push(parseInt(numMatch[1], 10));
          }
        });

        if (numbers.length >= 2) {
          const h = numbers.length === 3 ? numbers[0] : 0;
          const m = numbers.length === 3 ? numbers[1] : numbers[0];
          const s = numbers.length === 3 ? numbers[2] : numbers[1];
          return { hours: h, minutes: m, seconds: s, totalMinutes: h * 60 + m + (s > 0 ? 1 : 0) };
        }
      }

      // 2. Scan toàn bộ body text
      const bodyText = document.body.innerText;
      
      const match1 = bodyText.match(/(\d+)\s*Giờ\s*(\d+)\s*Phút\s*(\d+)?\s*Giây?/i);
      if (match1) {
        const h = parseInt(match1[1], 10) || 0;
        const m = parseInt(match1[2], 10) || 0;
        const s = parseInt(match1[3], 10) || 0;
        return { hours: h, minutes: m, seconds: s, totalMinutes: h * 60 + m + (s > 0 ? 1 : 0) };
      }

      const match2 = bodyText.match(/(\d+)\s*Phút\s*(\d+)?\s*Giây?/i);
      if (match2) {
        const m = parseInt(match2[1], 10) || 0;
        const s = parseInt(match2[2], 10) || 0;
        return { hours: 0, minutes: m, seconds: s, totalMinutes: m + (s > 0 ? 1 : 0) };
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
