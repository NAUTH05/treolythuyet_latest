const { chromium } = require('playwright');
const EventEmitter = require('events');
const { isAllowedStudyDate, getNextAllowedStudyDate, scanCourseDetails, readDomTimer } = require('./courseScanner');

const BASE_URL = 'https://hoclythuyetlaixe.eco-tek.com.vn';
const LOGIN_URL = `${BASE_URL}/web/login`;

class AutoCourseSession extends EventEmitter {
  constructor(id, account, coursesConfig = [], options = {}) {
    super();
    this.id = id;
    this.account = account;
    this.coursesConfig = coursesConfig; // [{ courseUrl, targetHours, targetMinutes }]
    this.options = {
      headless: true,
      dailyMaxMinutes: 480, // Tối đa 8 tiếng/ngày
      allowedDateRanges: [], // ["25/07-28/07", "30/07", ...]
      timeWindows: [{ start: '06:00', end: '23:00' }],
      ...options,
    };

    this.status = 'idle'; // idle | logging-in | scanning | studying | paused | completed | limit-reached | error
    this.browser = null;
    this.context = null;
    this.page = null;
    this.currentCourseIndex = 0;
    this.currentLessonIndex = 0;
    this.dailyStudiedMinutes = 0;
    this.courseProgress = {}; // courseUrl -> { studiedMinutes, targetMinutes, completed }
    this._stopped = false;
  }

  log(msg, level = 'info') {
    const timestamp = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const entry = { timestamp, account: this.account.name, msg, level, sessionId: this.id };
    this.emit('log', entry);
    console.log(`[${timestamp}] [AUTO-COURSE: ${this.account.name}] ${msg}`);
  }

  getStatus() {
    return {
      id: this.id,
      account: this.account.name,
      status: this.status,
      currentCourseIndex: this.currentCourseIndex,
      totalCourses: this.coursesConfig.length,
      dailyStudiedMinutes: this.dailyStudiedMinutes,
      courseProgress: this.courseProgress,
    };
  }

  async login() {
    this.status = 'logging-in';
    this.emit('status', this.getStatus());
    this.log('🔑 Đang đăng nhập tài khoản...', 'info');

    await this.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.page.waitForSelector('input[name="login"]', { timeout: 15000 });
    await this.page.fill('input[name="login"]', this.account.email);
    await this.page.fill('input[name="password"]', this.account.password);

    await Promise.all([
      this.page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }),
      this.page.click('button[type="submit"]'),
    ]);

    this.log('✅ Login thành công!', 'success');
  }

  async start() {
    this.log(`🤖 Khởi động Auto-Scan khóa học cho ${this.account.name}`, 'info');

    // 1. Kiểm tra Lịch Ngày Học Được Phép
    const now = new Date();
    if (!isAllowedStudyDate(now, this.options.allowedDateRanges)) {
      const nextDate = getNextAllowedStudyDate(now, this.options.allowedDateRanges);
      this.status = 'date-limit';
      this.log(`⏰ Hôm nay (${now.toLocaleDateString('vi-VN')}) là ngày nghỉ — Hẹn lịch tiếp tục lúc 06:00 ngày ${nextDate.toLocaleDateString('vi-VN')}`, 'warn');
      this.emit('status', this.getStatus());
      return;
    }

    try {
      this.browser = await chromium.launch({
        headless: this.options.headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
        ],
      });

      this.context = await this.browser.newContext({
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'vi-VN',
        timezoneId: 'Asia/Ho_Chi_Minh',
      });

      this.page = await this.context.newPage();
      await this.login();

      // Vòng lặp qua các khóa học được cấu hình
      for (let cIdx = 0; cIdx < this.coursesConfig.length; cIdx++) {
        if (this._stopped) break;
        const cConfig = this.coursesConfig[cIdx];
        this.currentCourseIndex = cIdx;

        const targetMinutes = (cConfig.targetHours || 0) * 60 + (cConfig.targetMinutes || 0);
        this.log(`🔍 Bắt đầu quét Khóa học ${cIdx + 1}/${this.coursesConfig.length}: ${cConfig.courseUrl} (Mục tiêu: ${cConfig.targetHours || 0}h ${cConfig.targetMinutes || 0}m)`, 'info');

        // Quét thông tin khóa học & các bài chưa hoàn thành (<100%)
        const scanResult = await scanCourseDetails(this.page, cConfig.courseUrl);
        if (!scanResult) {
          this.log(`⚠️ Không thể quét thông tin khóa học ${cConfig.courseUrl}`, 'warn');
          continue;
        }

        this.log(`📚 Khóa [${scanResult.courseTitle}]: Tìm thấy ${scanResult.uncompletedLessons.length}/${scanResult.totalLessons} bài chưa xong (<100%)`, 'info');
        scanResult.allLessons.forEach((l, idx) => {
          this.log(`   └─ Bài ${idx + 1}: ${l.title} -> ${l.progressPercent}% (${l.isCompleted ? 'Đã hoàn thành' : 'CHƯA XONG'})`, l.isCompleted ? 'info' : 'warn');
        });

        if (scanResult.uncompletedLessons.length === 0) {
          this.log(`🎉 Tất cả ${scanResult.totalLessons} bài học trong Khóa [${scanResult.courseTitle}] đều đã hoàn thành 100%! Bỏ qua khóa này.`, 'success');
          this.courseProgress[cConfig.courseUrl] = {
            title: scanResult.courseTitle,
            targetMinutes,
            studiedMinutes: targetMinutes,
            completed: true,
          };
          continue;
        }

        let courseStudiedMins = 0;
        this.courseProgress[cConfig.courseUrl] = {
          title: scanResult.courseTitle,
          targetMinutes,
          studiedMinutes: 0,
          completed: false,
        };

        // Vòng lặp qua các bài chưa hoàn thành trong khóa
        for (let lIdx = 0; lIdx < scanResult.uncompletedLessons.length; lIdx++) {
          if (this._stopped) break;

          // Kiểm tra giới hạn 8 tiếng/ngày (480m)
          if (this.dailyStudiedMinutes >= this.options.dailyMaxMinutes) {
            this.status = 'daily-limit';
            this.log(`🛑 Đã đạt giới hạn tối đa 8 tiếng học trong ngày (480 phút) $\\rightarrow$ Hẹn 06:00 sáng ngày mai tiếp tục!`, 'warn');
            this.emit('status', this.getStatus());
            return;
          }

          // Kiểm tra xem khóa học đã đạt đủ mục tiêu số giờ yêu cầu chưa
          if (targetMinutes > 0 && courseStudiedMins >= targetMinutes) {
            this.log(`🎉 Khóa học [${scanResult.courseTitle}] đã đạt đủ mục tiêu ${targetMinutes} phút yêu cầu!`, 'success');
            this.courseProgress[cConfig.courseUrl].completed = true;
            break;
          }

          const lesson = scanResult.uncompletedLessons[lIdx];
          this.log(`📖 Mở bài ${lIdx + 1}/${scanResult.uncompletedLessons.length}: ${lesson.title} (${lesson.url})`, 'info');

          await this.page.goto(lesson.url, { waitUntil: 'load', timeout: 60000 });
          await this.page.waitForTimeout(2000);

          // Đọc bộ đếm ngược DOM Timer
          const domTimer = await readDomTimer(this.page);
          let lessonMinutes = 240; // mặc định 4 tiếng nếu không đọc được DOM Timer
          if (domTimer && domTimer.totalMinutes > 0) {
            lessonMinutes = domTimer.totalMinutes;
            this.log(`⏱️ Đã phát hiện bộ đếm DOM Timer: ${domTimer.hours}h ${domTimer.minutes}m ${domTimer.seconds}s (${domTimer.totalMinutes} phút cần treo)`, 'success');
          } else {
            this.log(`ℹ️ Không đọc được DOM Timer, sử dụng thời gian mặc định 240 phút`, 'info');
          }

          // Treo bài học này
          this.status = 'studying';
          this.emit('status', this.getStatus());

          const startTime = Date.now();
          const durationMs = lessonMinutes * 60 * 1000;

          // Chờ treo bài học (F5 mỗi 15 phút)
          let elapsedMs = 0;
          while (elapsedMs < durationMs && !this._stopped) {
            const waitStep = Math.min(15 * 60 * 1000, durationMs - elapsedMs);
            await this.page.waitForTimeout(waitStep);
            elapsedMs += waitStep;

            // Update studied minutes
            const addMins = Math.round(waitStep / 60000);
            this.dailyStudiedMinutes += addMins;
            courseStudiedMins += addMins;
            this.courseProgress[cConfig.courseUrl].studiedMinutes = courseStudiedMins;

            this.log(`📊 Đang treo bài [${lesson.title}]: Đã treo ${Math.round(elapsedMs / 60000)}/${lessonMinutes} phút | Tổng hôm nay: ${this.dailyStudiedMinutes}/480 phút`, 'info');
            this.emit('status', this.getStatus());

            if (elapsedMs < durationMs && !this._stopped) {
              await this.page.reload({ waitUntil: 'load', timeout: 60000 });
            }
          }

          this.log(`✅ Hoàn thành treo bài [${lesson.title}] (${lessonMinutes} phút)!`, 'success');
          this.emit('progress-saved', {
            account: this.account.name,
            courseTitle: scanResult.courseTitle,
            lessonTitle: lesson.title,
            studiedMinutes: lessonMinutes,
            courseRemainingMinutes: Math.max(0, targetMinutes - courseStudiedMins),
          });
        }
      }

      this.status = 'completed';
      this.log(`🎉 Tất cả các khóa học đã được quét và treo xong!`, 'success');
      this.emit('status', this.getStatus());
    } catch (err) {
      this.status = 'error';
      this.log(`❌ Lỗi Auto-Scan: ${err.message}`, 'error');
    } finally {
      await this.stop();
    }
  }

  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
    }
  }
}

module.exports = {
  AutoCourseSession,
};
