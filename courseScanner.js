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
    await page.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

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

        // Check completion badge (0%, 25%, 100%)
        const parentRow = a.closest('li') || a.closest('tr') || a.closest('div');
        let progressPercent = 0;
        if (parentRow) {
          const badgeEl = parentRow.querySelector('.badge') || parentRow.querySelector('[class*="badge"]');
          if (badgeEl) {
            const badgeText = badgeEl.textContent.trim();
            const match = badgeText.match(/(\d+)%/);
            if (match) progressPercent = parseInt(match[1], 10);
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

// Đọc bộ đếm ngược DOM Timer (Vòng tròn đếm ngược 3 Giờ | 59 Phút | 58 Giây)
async function readDomTimer(page) {
  if (!page) return null;
  try {
    const timer = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      
      // Pattern 1: "3 Giờ 59 Phút 58 Giây"
      const match1 = bodyText.match(/(\d+)\s*Giờ\s*(\d+)\s*Phút\s*(\d+)\s*Giây/i);
      if (match1) {
        const h = parseInt(match1[1], 10);
        const m = parseInt(match1[2], 10);
        const s = parseInt(match1[3], 10);
        return { hours: h, minutes: m, seconds: s, totalMinutes: h * 60 + m + (s > 0 ? 1 : 0) };
      }

      // Pattern 2: "59 Phút 58 Giây"
      const match2 = bodyText.match(/(\d+)\s*Phút\s*(\d+)\s*Giây/i);
      if (match2) {
        const m = parseInt(match2[1], 10);
        const s = parseInt(match2[2], 10);
        return { hours: 0, minutes: m, seconds: s, totalMinutes: m + (s > 0 ? 1 : 0) };
      }

      // Pattern 3: Circular SVG or badges with numbers
      const badges = Array.from(document.querySelectorAll('.badge, [class*="timer"], [class*="circle"]'));
      let h = 0, m = 0, s = 0, found = false;
      badges.forEach(b => {
        const txt = b.textContent.trim();
        if (/^\d+\s*Giờ$/i.test(txt)) { h = parseInt(txt, 10); found = true; }
        if (/^\d+\s*Phút$/i.test(txt)) { m = parseInt(txt, 10); found = true; }
        if (/^\d+\s*Giây$/i.test(txt)) { s = parseInt(txt, 10); found = true; }
      });

      if (found) {
        return { hours: h, minutes: m, seconds: s, totalMinutes: h * 60 + m + (s > 0 ? 1 : 0) };
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
