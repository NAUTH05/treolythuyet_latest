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

// Đọc bộ đếm ngược DOM Timer (Hỗ trợ đọc 3 vòng tròn đếm ngược: 1 Giờ | 36 Phút | 36 Giây)
async function readDomTimer(page) {
  if (!page) return null;
  try {
    // Chờ 3.5 giây để JS và API /slide/countdown-start/ hoàn tất
    await page.waitForTimeout(3500);

    const timer = await page.evaluate(() => {
      const bodyText = document.body.innerText || document.body.textContent || '';

      // Pattern 1: Tìm độc lập từng thành phần "X Giờ", "Y Phút", "Z Giây" (hỗ trợ xuống dòng \n giữa số và chữ)
      const hMatch = bodyText.match(/(\d+)[\s\n\r]*(?:Giờ|h)/i);
      const mMatch = bodyText.match(/(\d+)[\s\n\r]*(?:Phút|m)/i);
      const sMatch = bodyText.match(/(\d+)[\s\n\r]*(?:Giây|s)/i);

      const h = hMatch ? parseInt(hMatch[1], 10) : 0;
      const m = mMatch ? parseInt(mMatch[1], 10) : 0;
      const s = sMatch ? parseInt(sMatch[1], 10) : 0;

      if (h > 0 || m > 0 || s > 0) {
        return {
          hours: h,
          minutes: m,
          seconds: s,
          totalMinutes: h * 60 + m + (s > 0 ? 1 : 0),
          source: 'multiline-regex',
        };
      }

      // Pattern 2: Đọc các số nguyên trong các container chứa canvas/vòng tròn
      const flexItems = Array.from(document.querySelectorAll('.ect_countdown_canvas_flex, .ect_countdown_flex, [class*="circle"], [class*="countdown"]'));
      const numbers = [];
      flexItems.forEach(el => {
        const txt = (el.innerText || el.textContent || '').trim();
        const matches = txt.match(/\d+/g);
        if (matches) {
          matches.forEach(num => numbers.push(parseInt(num, 10)));
        }
      });

      if (numbers.length >= 2) {
        const hours = numbers.length === 3 ? numbers[0] : 0;
        const minutes = numbers.length === 3 ? numbers[1] : numbers[0];
        const seconds = numbers.length === 3 ? numbers[2] : numbers[1];
        return {
          hours,
          minutes,
          seconds,
          totalMinutes: hours * 60 + minutes + (seconds > 0 ? 1 : 0),
          source: 'circle-numbers',
        };
      }

      // Pattern 3: Đọc data-end-time nếu có và nằm ở tương lai
      const ectSection = document.querySelector('.ect_countdown, section[data-snippet="ect_countdown"], [data-name="ECT Countdown"]');
      if (ectSection) {
        const endTimeAttr = ectSection.getAttribute('data-end-time');
        if (endTimeAttr) {
          const endTimeSec = parseFloat(endTimeAttr);
          const nowSec = Date.now() / 1000;
          if (endTimeSec > nowSec) {
            const diffSec = Math.round(endTimeSec - nowSec);
            const hours = Math.floor(diffSec / 3600);
            const minutes = Math.floor((diffSec % 3600) / 60);
            const seconds = diffSec % 60;
            return {
              hours,
              minutes,
              seconds,
              totalMinutes: hours * 60 + minutes + (seconds > 0 ? 1 : 0),
              source: 'data-end-time',
            };
          }
        }
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
