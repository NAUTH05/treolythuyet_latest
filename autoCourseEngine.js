const { chromium } = require('playwright');
const EventEmitter = require('events');
const { isAllowedStudyDate, getNextAllowedStudyDate, scanCourseDetails, readDomTimer, getShiftsForDate, calcMsRemainingInShift, getNextShiftStart } = require('./courseScanner');

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
      newDayStartTime: '06:00', // Giờ bắt đầu ngày mới (VD: "06:00", "07:30")
      refreshInterval: 15, // Thời gian F5 reload trang (phút)
      customTimeRules: [], // [{ dates: "25/07", shifts: "07:00-11:30, 14:00-23:00" }, ...]
      stealth: false, // Bật/tắt anti-detection + giả lập thao tác người dùng (mặc định TẮT cho AutoCourse)
      stealthInterval: 30, // Giây giữa các hành động stealth giả lập (giống Queue thủ công)
      timeWindows: [], // [{start:'HH:MM', end:'HH:MM'}] — giới hạn khung giờ học (rỗng = không giới hạn)
      ...options,
    };

    this.status = 'idle'; // idle | logging-in | scanning | studying | paused | date-limit | daily-limit | completed | stopped | error
    this.pausedFromStatus = null;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.currentCourseIndex = 0;
    this.currentLessonIndex = 0;
    this.dailyStudiedMinutes = 0;
    this.dailyDate = this._vnDateStr(); // Ngày VN của bộ đếm giờ học trong ngày
    this.courseProgress = {}; // courseUrl -> { studiedMinutes, targetMinutes, completed }
    this._stopped = false;
    this._stealthTimer = null;
  }

  _randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // =================== STEALTH (port từ Queue thủ công - bot.js) ===================

  async _fakeMouseMove() {
    const x = this._randomBetween(100, 1200);
    const y = this._randomBetween(100, 700);
    await this.page.mouse.move(x, y, { steps: this._randomBetween(3, 10) });
  }

  async _fakeScroll() {
    const scrollY = this._randomBetween(-100, 200);
    await this.page.evaluate((dy) => window.scrollBy(0, dy), scrollY);
  }

  async _fakeVisibilityAPI() {
    if (!this.options.stealth) return;
    try {
      await this.page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { value: false, writable: false });
        Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: false });
      });
    } catch { /* ignore */ }
  }

  async _fakeActivity() {
    const action = this._randomBetween(0, 1);
    try {
      if (action === 0) await this._fakeMouseMove();
      else await this._fakeScroll();
    } catch (err) {
      this.log(`Stealth lỗi nhẹ: ${err.message}`, 'warn');
    }
  }

  // Vòng lặp stealth chạy nền trong lúc treo học (giống _setupTimers của bot.js)
  _startStealthLoop() {
    if (!this.options.stealth) return;
    this._clearStealthLoop();
    const intervalMs = Math.max(5, parseInt(this.options.stealthInterval, 10) || 30) * 1000;
    this._stealthTimer = setInterval(async () => {
      if (this.status !== 'studying' || this._stopped || !this.page) return;
      try {
        await this._fakeActivity();
        await this._fakeVisibilityAPI();
      } catch { /* ignore */ }
    }, intervalMs);
  }

  _clearStealthLoop() {
    if (this._stealthTimer) {
      clearInterval(this._stealthTimer);
      this._stealthTimer = null;
    }
  }

  // =================== KHUNG GIỜ HỌC (port từ Queue thủ công) ===================

  // Ms còn lại trong khung giờ hiện tại (-1 = không giới hạn, -2 = ngoài tất cả các khung)
  _msRemainingInWindow() {
    const timeWindows = this.options.timeWindows || [];
    if (!timeWindows.length) return -1;
    const vnNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
    const nowMins = vnNow.getHours() * 60 + vnNow.getMinutes();
    const nowSecs = vnNow.getSeconds();
    for (const w of timeWindows) {
      const [sh, sm] = String(w.start || '').split(':').map(Number);
      const [eh, em] = String(w.end || '').split(':').map(Number);
      if ([sh, sm, eh, em].some(n => isNaN(n))) continue;
      const startMins = sh * 60 + sm;
      const endMins = eh * 60 + em;
      if (nowMins >= startMins && nowMins < endMins) {
        return Math.max(0, (endMins - nowMins) * 60000 - nowSecs * 1000);
      }
    }
    return -2;
  }

  // Nếu ngoài khung giờ học → chuyển trạng thái 'time-window' để server hẹn giờ chạy lại.
  // Trả về true nếu đã kích hoạt time-window (caller phải return/thoát).
  _hitTimeWindowLimit() {
    if (this._msRemainingInWindow() !== -2) return false;
    this.status = 'time-window';
    this.log(`⏰ Ngoài khung giờ học cho phép — tạm nghỉ, hẹn giờ tự chạy lại vào khung giờ tiếp theo`, 'warn');
    this.emit('status', this.getStatus());
    return true;
  }

  _formatMinutes(mins) {
    const m = Math.max(0, Math.round(mins || 0));
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return h > 0 ? `${h}h ${remM}m` : `${m}m`;
  }

  // Ngày hiện tại theo giờ Việt Nam (yyyy-mm-dd) — dùng để reset giới hạn học mỗi ngày
  _vnDateStr(date = new Date()) {
    return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  }

  // Sang ngày mới (giờ VN) thì reset bộ đếm giờ học trong ngày
  _rolloverDailyCounter() {
    const today = this._vnDateStr();
    if (today !== this.dailyDate) {
      this.dailyDate = today;
      this.dailyStudiedMinutes = 0;
      this.log('🌅 Sang ngày mới — reset bộ đếm giờ học trong ngày', 'info');
    }
  }

  // Chờ nếu phiên đang ở trạng thái Tạm dừng (paused)
  async _checkPaused() {
    while (this.status === 'paused' && !this._stopped) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Tạm dừng phiên
  pause() {
    if (this._stopped || this.status === 'stopped' || this.status === 'completed' || this.status === 'error' || this.status === 'paused') {
      return false;
    }
    this.pausedFromStatus = this.status;
    this.status = 'paused';
    this.log(`⏸ Tạm dừng phiên Auto-Scan cho ${this.account.name}`, 'info');
    this.emit('status', this.getStatus());
    return true;
  }

  // Tiếp tục phiên
  resume() {
    if (this.status !== 'paused') return false;
    const prev = this.pausedFromStatus || 'studying';
    this.pausedFromStatus = null;
    this.status = prev;
    this.log(`▶️ Tiếp tục phiên Auto-Scan cho ${this.account.name}`, 'info');
    this.emit('status', this.getStatus());
    return true;
  }

  // Lỗi mạng tạm thời → được phép tự thử lại (giống Queue thủ công)
  _isNetworkError(err) {
    const msg = String((err && err.message) || '');
    return msg.includes('net::ERR')
      || msg.includes('ERR_ADDRESS_UNREACHABLE')
      || msg.includes('ERR_CONNECTION_REFUSED')
      || msg.includes('ERR_NAME_NOT_RESOLVED')
      || msg.includes('ERR_NETWORK_CHANGED')
      || msg.includes('ERR_INTERNET_DISCONNECTED')
      || msg.includes('ECONNREFUSED')
      || msg.includes('ENOTFOUND')
      || msg.toLowerCase().includes('timeout');
  }

  // Kiểm tra trang hiện tại có đúng URL mong muốn không (so sánh pathname)
  _isOnUrl(expectedUrl) {
    try {
      const current = new URL(this.page.url());
      const expected = new URL(expectedUrl);
      return current.pathname === expected.pathname;
    } catch {
      return false;
    }
  }

  // Chờ đến khi vào đúng URL — retry vô hạn nếu bị redirect hoặc văng đăng nhập
  async _waitUntilOnUrl(expectedUrl) {
    let attempt = 0;
    while (!this._stopped) {
      await this._checkPaused();
      if (this._stopped) return false;

      // Phát hiện bị văng phiên đăng nhập (trang /web/login) → tự đăng nhập lại
      if (this.page && this.page.url().includes('/web/login')) {
        this.log('⚠️ Bị văng phiên đăng nhập (redirect về trang login) → Tự động đăng nhập lại...', 'warn');
        try {
          await this.login();
        } catch (err) {
          this.log(`⚠️ Lỗi đăng nhập lại: ${err.message} → Thử lại sau 30s`, 'warn');
          await this.page.waitForTimeout(30000);
          continue;
        }
      }

      if (this._isOnUrl(expectedUrl)) return true;
      attempt++;
      this.log(`⚠️ Đang chờ hệ thống cho phép vào đúng URL (lần ${attempt}): ${this.page ? this.page.url() : ''} → Thử lại sau 30 giây...`, 'warn');
      this.emit('status', this.getStatus());
      await this.page.waitForTimeout(30000);
      if (this._stopped) return false;
      try {
        await this.page.goto(expectedUrl, { waitUntil: 'load', timeout: 60000 });
        await this._fakeVisibilityAPI();
        await this.page.waitForTimeout(2000);
      } catch (err) {
        this.log(`⚠️ Lỗi truy cập lại: ${String(err.message).split('\n')[0]}`, 'warn');
      }
    }
    return false;
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
      pausedFromStatus: this.pausedFromStatus,
      currentCourseIndex: this.currentCourseIndex,
      totalCourses: this.coursesConfig.length,
      dailyStudiedMinutes: this.dailyStudiedMinutes,
      dailyMaxMinutes: this.options.dailyMaxMinutes,
      newDayStartTime: this.options.newDayStartTime || '06:00',
      refreshInterval: this.options.refreshInterval || 15,
      dailyDate: this.dailyDate,
      courseProgress: this.courseProgress,
    };
  }

  async login() {
    this.status = 'logging-in';
    this.emit('status', this.getStatus());

    // Retry vô hạn khi mạng chưa sẵn sàng (giống Queue thủ công)
    let attempt = 0;
    while (!this._stopped) {
      await this._checkPaused();
      try {
        this.log('🔑 Đang mở trang login...', 'info');
        await this.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        break; // Thành công → thoát vòng lặp
      } catch (err) {
        attempt++;
        if (!this._isNetworkError(err)) throw err; // Lỗi khác → re-throw
        this.log(`⚠️ Mạng chưa sẵn sàng (lần ${attempt}): ${String(err.message).split('\n')[0]} → Thử lại sau 60 giây...`, 'warn');
        this.emit('status', this.getStatus());
        await this.page.waitForTimeout(60000);
        if (this._stopped) return;
        try {
          await this.page.close();
          this.page = await this.context.newPage();
        } catch { /* ignore */ }
      }
    }
    if (this._stopped) return;

    await this.page.waitForSelector('input[name="login"]', { timeout: 15000 });
    await this.page.fill('input[name="login"]', this.account.email);
    await this.page.fill('input[name="password"]', this.account.password);

    // Delay ngẫu nhiên như người thật trước khi bấm đăng nhập (chỉ khi bật Stealth)
    if (this.options.stealth) {
      await this.page.waitForTimeout(this._randomBetween(500, 1500));
    }

    await Promise.all([
      this.page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }),
      this.page.click('button[type="submit"]'),
    ]);

    // Phát hiện login thất bại (sai mật khẩu) — vẫn ở trang /web/login kèm thông báo lỗi
    if (this.page.url().includes('/web/login')) {
      const errorEl = await this.page.$('.alert-danger');
      if (errorEl) {
        const errorText = (await errorEl.textContent()) || '';
        throw new Error(`Login thất bại: ${errorText.trim()}`);
      }
    }

    this.log('✅ Login thành công!', 'success');
  }

  // Kiểm tra Ca học theo quy tắc Ngày cụ thể (customTimeRules)
  _checkCustomShifts() {
    const customRules = this.options.customTimeRules || [];
    if (!customRules || customRules.length === 0) {
      return { inShift: true, remainingMs: Infinity, currentShift: null, nextShiftToday: null };
    }
    const now = new Date();
    const shiftsToday = getShiftsForDate(now, customRules);
    if (!shiftsToday || shiftsToday.length === 0) {
      return { inShift: true, remainingMs: Infinity, currentShift: null, nextShiftToday: null };
    }
    return calcMsRemainingInShift(now, shiftsToday);
  }

  _hitTimeShiftLimit() {
    const customRules = this.options.customTimeRules || [];
    if (!customRules || customRules.length === 0) return false;

    const now = new Date();
    const shiftsToday = getShiftsForDate(now, customRules);
    if (!shiftsToday || shiftsToday.length === 0) return false;

    const shiftStatus = calcMsRemainingInShift(now, shiftsToday);

    if (!shiftStatus.inShift) {
      const nextRun = getNextShiftStart(now, customRules, this.options.allowedDateRanges || [], this.options.newDayStartTime || '06:00');
      this.status = 'date-limit';
      const vnTimeStr = now.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      const vnNextStr = nextRun.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

      let msg = `⏰ Hiện tại (${vnTimeStr}) nằm ngoài Ca học cho phép`;
      if (shiftStatus.nextShiftToday) {
        msg += ` (Ca kế tiếp hôm nay: ${shiftStatus.nextShiftToday.start}-${shiftStatus.nextShiftToday.end}) → Hẹn tự động chạy lại lúc ${vnNextStr}`;
      } else {
        msg += ` → Hẹn tự động chạy lại Ca học tiếp theo lúc ${vnNextStr}`;
      }

      this.log(msg, 'warn');
      this.emit('status', this.getStatus());
      return true;
    }

    return false;
  }

  async start() {
    this.log(`🤖 Khởi động Auto-Scan khóa học cho ${this.account.name}`, 'info');

    // 1. Kiểm tra Lịch Ngày Học Được Phép
    const now = new Date();
    if (!isAllowedStudyDate(now, this.options.allowedDateRanges)) {
      const nextDate = getNextAllowedStudyDate(now, this.options.allowedDateRanges, this.options.newDayStartTime);
      this.status = 'date-limit';
      this.log(`⏰ Hôm nay (${now.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}) là ngày nghỉ — Hẹn lịch tiếp tục lúc ${this.options.newDayStartTime || '06:00'} ngày ${nextDate.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`, 'warn');
      this.emit('status', this.getStatus());
      return;
    }

    // 2. Kiểm tra Khung Giờ Ca Học (nếu có quy tắc riêng)
    if (this._hitTimeShiftLimit()) return;

    // 3. Kiểm tra Khung Giờ Học Tổng Quát (nếu được cấu hình) trước khi mở browser
    if (this._hitTimeWindowLimit()) return;

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

      // Anti-detection init script (chỉ khi bật Stealth)
      if (this.options.stealth) {
        await this.context.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
          Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
          Object.defineProperty(navigator, 'languages', { get: () => ['vi-VN', 'vi', 'en-US', 'en'] });
        });
      }

      this.page = await this.context.newPage();
      this._startStealthLoop();
      await this.login();

      // Vòng lặp qua các khóa học được cấu hình
      for (let cIdx = 0; cIdx < this.coursesConfig.length; cIdx++) {
        if (this._stopped) break;
        await this._checkPaused();

        const cConfig = this.coursesConfig[cIdx];
        this.currentCourseIndex = cIdx;

        const targetMinutes = (cConfig.targetHours || 0) * 60 + (cConfig.targetMinutes || 0);
        this.status = 'scanning';
        this.emit('status', this.getStatus());
        this.log(`🔍 Bắt đầu quét Khóa học ${cIdx + 1}/${this.coursesConfig.length}: ${cConfig.courseUrl} (Mục tiêu: ${cConfig.targetHours || 0}h ${cConfig.targetMinutes || 0}m)`, 'info');

        // Quét thông tin khóa học & các bài chưa hoàn thành (<100%)
        let scanResult = null;
        let scanAttempt = 0;
        while (!this._stopped) {
          await this._checkPaused();
          scanResult = await scanCourseDetails(this.page, cConfig.courseUrl);
          const onCoursePage = this._isOnUrl(cConfig.courseUrl);
          if (scanResult && onCoursePage) break;
          scanAttempt++;
          const reason = !scanResult ? 'lỗi quét/mạng' : `bị redirect: ${this.page.url()}`;
          this.log(`⚠️ Quét khóa học thất bại (${reason}) (lần ${scanAttempt}) → Thử lại sau 30 giây...`, 'warn');
          this.emit('status', this.getStatus());
          await this.page.waitForTimeout(30000);
        }
        if (this._stopped) break;

        if (!scanResult || scanResult.totalLessons === 0) {
          this.log(`⚠️ Không tìm thấy bài học nào trong khóa ${cConfig.courseUrl} — bỏ qua khóa này (không đánh dấu hoàn thành)`, 'warn');
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

        let courseStudiedMins = scanResult.actualStudiedMinutes || 0;
        this.courseProgress[cConfig.courseUrl] = {
          title: scanResult.courseTitle,
          targetMinutes,
          studiedMinutes: courseStudiedMins,
          completed: false,
        };

        if (scanResult.actualStudiedText) {
          this.log(`⏱️ Thời gian đã hoàn thành tích lũy trên web: ${scanResult.actualStudiedText} (${courseStudiedMins} phút)`, 'info');
        }

        if (targetMinutes > 0 && courseStudiedMins >= targetMinutes) {
          this.log(`🎉 Khóa học [${scanResult.courseTitle}] trên web đã đạt ${scanResult.actualStudiedText || (courseStudiedMins + ' phút')} (Đã đạt/vượt mục tiêu ${cConfig.targetHours}h ${cConfig.targetMinutes}m)! Bỏ qua khóa này.`, 'success');
          this.courseProgress[cConfig.courseUrl].completed = true;
          continue;
        }

        // Vòng lặp qua các bài chưa hoàn thành trong khóa
        for (let lIdx = 0; lIdx < scanResult.uncompletedLessons.length; lIdx++) {
          if (this._stopped) break;
          await this._checkPaused();

          this._rolloverDailyCounter();
          const remainingDailyMins = Math.max(0, this.options.dailyMaxMinutes - this.dailyStudiedMinutes);
          if (this.dailyStudiedMinutes >= this.options.dailyMaxMinutes) {
            this.status = 'daily-limit';
            this.log(`🛑 Đã đạt giới hạn học tối đa trong ngày (${this._formatMinutes(this.options.dailyMaxMinutes)}) → Hẹn ${this.options.newDayStartTime || '06:00'} sáng ngày mai tiếp tục!`, 'warn');
            this.emit('status', this.getStatus());
            return;
          }

          this.log(`⏳ Thời gian học trong ngày còn lại: ${this._formatMinutes(remainingDailyMins)} (${remainingDailyMins} phút / tối đa ${this._formatMinutes(this.options.dailyMaxMinutes)})`, 'info');

          if (targetMinutes > 0 && courseStudiedMins >= targetMinutes) {
            this.log(`🎉 Khóa học [${scanResult.courseTitle}] đã đạt đủ mục tiêu ${targetMinutes} phút yêu cầu!`, 'success');
            this.courseProgress[cConfig.courseUrl].completed = true;
            break;
          }

          const lesson = scanResult.uncompletedLessons[lIdx];
          this.log(`📖 Mở bài ${lIdx + 1}/${scanResult.uncompletedLessons.length}: ${lesson.title} (${lesson.url})`, 'info');

          let apiTimerSec = null;
          const responseHandler = async (res) => {
            if (res.url().includes('countdown-start')) {
              try {
                const data = await res.json();
                const payload = data.result || data;
                if (payload && payload.end_time) {
                  const endSec = parseInt(payload.end_time, 10);
                  const nowSec = Math.floor(Date.now() / 1000);
                  if (endSec > nowSec) {
                    apiTimerSec = endSec - nowSec;
                  }
                }
              } catch { /* ignore */ }
            }
          };

          this.page.on('response', responseHandler);

          let navAttempt = 0;
          while (!this._stopped) {
            await this._checkPaused();
            try {
              await this.page.goto(lesson.url, { waitUntil: 'load', timeout: 60000 });
            } catch (err) {
              if (!this._isNetworkError(err)) {
                this.page.removeListener('response', responseHandler);
                throw err;
              }
              navAttempt++;
              this.log(`⚠️ Lỗi mở bài học (lần ${navAttempt}): ${String(err.message).split('\n')[0]} → Thử lại sau 30 giây...`, 'warn');
              this.emit('status', this.getStatus());
              await this.page.waitForTimeout(30000);
              continue;
            }
            await this._fakeVisibilityAPI();
            await this.page.waitForTimeout(3500);
            if (this._isOnUrl(lesson.url)) break;
            navAttempt++;
            this.log(`⚠️ Bài học chưa mở được, bị redirect (lần ${navAttempt}): ${this.page.url()} → Thử lại sau 30 giây...`, 'warn');
            this.emit('status', this.getStatus());
            await this.page.waitForTimeout(30000);
          }

          this.page.removeListener('response', responseHandler);
          if (this._stopped) break;
          if (navAttempt > 0) {
            this.log(`✅ Đã vào được bài học sau khi chờ hệ thống cho phép`, 'success');
          }

          let lessonMinutes = 240; // mặc định 4 tiếng nếu không bắt được
          if (apiTimerSec && !isNaN(apiTimerSec) && apiTimerSec > 0) {
            const h = Math.floor(apiTimerSec / 3600);
            const m = Math.floor((apiTimerSec % 3600) / 60);
            const s = apiTimerSec % 60;
            lessonMinutes = Math.ceil(apiTimerSec / 60);
            this.log(`⏱️ Bắt trực tiếp từ API /slide/countdown-start/: ${h}h ${m}m ${s}s (${lessonMinutes} phút cần treo)`, 'success');
          } else {
            const domTimer = await readDomTimer(this.page);
            if (domTimer && domTimer.totalMinutes > 0 && !isNaN(domTimer.totalMinutes)) {
              lessonMinutes = domTimer.totalMinutes;
              this.log(`⏱️ Đã phát hiện bộ đếm DOM Timer: ${domTimer.hours}h ${domTimer.minutes}m ${domTimer.seconds}s (${domTimer.totalMinutes} phút cần treo)`, 'success');
            } else if (domTimer && (domTimer.hours === 0 && domTimer.minutes === 0 && domTimer.seconds === 0)) {
              this.log(`⚠️ Bộ đếm DOM Timer trả về 0h 0m 0s — Bài có thể đã hoàn thành hoặc hết thời gian cho phép trong ngày`, 'warn');
            } else {
              this.log(`ℹ️ Không đọc được DOM Timer hợp lệ, sử dụng thời gian mặc định 240 phút`, 'info');
            }
          }

          if (this._stopped) break;

          this.status = 'studying';
          this.emit('status', this.getStatus());

          const durationMs = lessonMinutes * 60 * 1000;
          let elapsedMs = 0;

          while (elapsedMs < durationMs && !this._stopped) {
            await this._checkPaused();

            // Hết khung giờ học → F5 lưu checkpoint rồi tạm nghỉ (server tự hẹn giờ chạy lại)
            if (this._msRemainingInWindow() === -2) {
              this.log('⏰ Hết giờ khung học — F5 lưu checkpoint và tạm nghỉ...', 'warn');
              try {
                await this.page.reload({ waitUntil: 'load', timeout: 60000 });
              } catch { /* ignore */ }
              this._hitTimeWindowLimit();
              return;
            }

            try {
              const popupBtn = await this.page.$('#resume-activity-button');
              if (popupBtn) {
                await popupBtn.click();
                this.log('👆 Đã tự động bấm "Tiếp tục ghi nhận giờ học" (Khôi phục Inactivity)', 'info');
              }
            } catch { /* ignore */ }

            // F5 interval kèm jitter ±30% như Queue thủ công
            const refreshIntervalMs = Math.max(1, parseInt(this.options.refreshInterval, 10) || 15) * 60 * 1000;
            const jitter = refreshIntervalMs * 0.3;
            const jitteredMs = Math.round(refreshIntervalMs + (Math.random() * 2 - 1) * jitter);
            let waitStep = Math.min(Math.max(60000, jitteredMs), durationMs - elapsedMs);

            // Không chờ vượt quá thời điểm kết thúc Ca học hiện tại
            const shiftCheck = this._checkCustomShifts();
            if (shiftCheck.currentShift && shiftCheck.remainingMs < waitStep) {
              waitStep = Math.max(5000, shiftCheck.remainingMs);
            }

            // Không chờ vượt quá thời điểm kết thúc khung giờ hiện tại
            const windowRemainingMs = this._msRemainingInWindow();
            if (windowRemainingMs >= 0) {
              waitStep = Math.min(waitStep, Math.max(5000, windowRemainingMs));
            }

            await this.page.waitForTimeout(waitStep);

            // Re-check pause & shift limit after waitStep
            await this._checkPaused();
            if (this._stopped) break;
            if (this._hitTimeShiftLimit()) return;

            elapsedMs += waitStep;

            this._rolloverDailyCounter();
            const addMins = Math.round(waitStep / 60000);
            this.dailyStudiedMinutes += addMins;
            courseStudiedMins += addMins;
            this.courseProgress[cConfig.courseUrl].studiedMinutes = courseStudiedMins;

            const remainingDailyMins = Math.max(0, this.options.dailyMaxMinutes - this.dailyStudiedMinutes);
            this.log(`📊 Đang treo bài [${lesson.title}]: Đã treo ${Math.round(elapsedMs / 60000)}/${lessonMinutes} phút | Hôm nay: ${this._formatMinutes(this.dailyStudiedMinutes)} / ${this._formatMinutes(this.options.dailyMaxMinutes)} (Còn lại: ${this._formatMinutes(remainingDailyMins)})`, 'info');
            this.emit('status', this.getStatus());

            if (elapsedMs < durationMs && !this._stopped) {
              try {
                await this.page.reload({ waitUntil: 'load', timeout: 60000 });
                await this._fakeVisibilityAPI();
                await this.page.waitForTimeout(2000);
              } catch (err) {
                if (!this._isNetworkError(err)) throw err;
                this.log(`⚠️ F5 lỗi mạng: ${String(err.message).split('\n')[0]} → sẽ thử lại ở chu kỳ sau`, 'warn');
              }
              if (!this._stopped && !this._isOnUrl(lesson.url)) {
                this.log(`⚠️ F5 bị redirect: ${this.page.url()} → Đang chờ hệ thống cho phép vào lại...`, 'warn');
                const reentered = await this._waitUntilOnUrl(lesson.url);
                if (reentered) this.log(`✅ Đã vào lại bài học sau khi F5 bị redirect`, 'success');
              }

              // Heartbeat Check: Đọc lại bộ đếm web sau F5 xem bài học có hoàn thành sớm hoặc hết giờ không
              if (!this._stopped && this._isOnUrl(lesson.url)) {
                const checkTimer = await readDomTimer(this.page);
                if (checkTimer && checkTimer.hours === 0 && checkTimer.minutes === 0 && checkTimer.seconds === 0) {
                  this.log('🎉 Bộ đếm DOM Timer trên web đã về 0h 0m 0s (Đã đạt 100% / Hoàn thành bài trên web) ➔ Hoàn thành bài học sớm!', 'success');
                  break;
                } else if (checkTimer && checkTimer.totalMinutes > 0 && !isNaN(checkTimer.totalMinutes)) {
                  const remainingWebMs = checkTimer.totalMinutes * 60 * 1000;
                  if (remainingWebMs < (durationMs - elapsedMs)) {
                    this.log(`⏱️ Thời gian đếm ngược trên web đã giảm còn ${checkTimer.hours}h ${checkTimer.minutes}m (${checkTimer.totalMinutes} phút) ➔ Tự động cập nhật rút ngắn thời gian treo!`, 'info');
                    durationMs = elapsedMs + remainingWebMs;
                  }
                }
              }
            }
          }

          if (!this._stopped && this.status !== 'paused') {
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
      }

      if (this._stopped) {
        this.status = 'stopped';
        this.emit('status', this.getStatus());
      } else if (this.status !== 'paused') {
        this.status = 'completed';
        this.log(`🎉 Tất cả các khóa học đã được quét và treo xong!`, 'success');
        this.emit('status', this.getStatus());
      }
    } catch (err) {
      if (this._stopped) {
        this.status = 'stopped';
        this.emit('status', this.getStatus());
      } else {
        this.status = 'error';
        this.log(`❌ Lỗi Auto-Scan: ${err.message}`, 'error');
        this.emit('status', this.getStatus());
      }
    } finally {
      await this.stop();
    }
  }

  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    this._clearStealthLoop();
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
    }
  }
}

module.exports = {
  AutoCourseSession,
};
