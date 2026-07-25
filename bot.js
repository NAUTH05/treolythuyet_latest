const { chromium } = require('playwright');
const EventEmitter = require('events');

// ============================================================
//  BOT ENGINE - Core automation logic
//  Tách riêng để dùng cho cả CLI và Web interface
// ============================================================

const BASE_URL = 'https://hoclythuyetlaixe.eco-tek.com.vn';
const LOGIN_URL = `${BASE_URL}/web/login`;

class BotSession extends EventEmitter {
  constructor(id, account, lessonUrls, options = {}) {
    super();
    this.id = id;
    this.account = account;
    this.lessonUrls = Array.isArray(lessonUrls) ? lessonUrls : [lessonUrls];
    this.currentLessonIndex = options.startLessonIndex || 0;
    this.options = {
      headless: true,
      durationMinutes: 240,
      stealthInterval: 30,
      refreshInterval: 30, // F5 mỗi 30 phút
      perUrlTimes: null,  // Mảng thời gian (phút) riêng cho từng URL, null = dùng durationMinutes
      startLessonIndex: 0,
      timeWindows: [],    // [{start:'HH:MM', end:'HH:MM'}] — giới hạn khung giờ học
      ...options,
    };

    // State
    this.status = 'idle'; // idle | logging-in | running | paused | completed | error
    this.startTime = null;
    this.endTime = null;
    this.progress = 0;
    this.browser = null;
    this.page = null;
    this.context = null;
    this.intervals = [];
    this.errorMsg = null;
    this.refreshCount = 0;
    this._stopped = false;
  }

  // ======================== HELPERS ===========================

  log(msg, level = 'info') {
    const timestamp = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const entry = { timestamp, account: this.account.name, msg, level, sessionId: this.id };
    this.emit('log', entry);
    console.log(`[${timestamp}] [${this.account.name}] ${msg}`);
  }

  formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${h}h ${m}m ${s}s`;
  }

  randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  clearTimers() {
    for (const timer of this.intervals) clearInterval(timer);
    this.intervals = [];
  }

  // Tính ms còn lại đến cuối khung giờ hiện tại (VN timezone)
  // Trả về -1 nếu không nằm trong khung giờ nào
  _calcMsUntilWindowEnd(timeWindows) {
    if (!timeWindows || !timeWindows.length) return -1;
    const now = new Date();
    const vnNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
    const nowMins = vnNow.getHours() * 60 + vnNow.getMinutes();
    const nowSecs = vnNow.getSeconds();
    for (const w of timeWindows) {
      const [sh, sm] = w.start.split(':').map(Number);
      const [eh, em] = w.end.split(':').map(Number);
      const startMins = sh * 60 + sm;
      const endMins = eh * 60 + em;
      if (nowMins >= startMins && nowMins < endMins) {
        const ms = (endMins - nowMins) * 60000 - nowSecs * 1000;
        return Math.max(0, ms);
      }
    }
    return -1; // Không nằm trong khung giờ nào
  }

  getStatus() {
    // Khi pause: dùng giá trị đã lưu, không tính theo thời gian thực
    const isPaused = this.status === 'paused' && this._pausedElapsedMs != null;
    const elapsed = isPaused ? this._pausedElapsedMs : (this.startTime ? Date.now() - this.startTime : 0);
    const perUrlTime = this.options.perUrlTimes?.[this.currentLessonIndex];
    const urlDuration = perUrlTime || this.options.durationMinutes;
    const durationMs = urlDuration * 60 * 1000;
    const remaining = isPaused ? this._pausedRemainingMs : Math.max(0, durationMs - elapsed);

    // Tính tổng thời gian còn lại của toàn bộ box (link hiện tại + các link sau)
    let totalRemainingMs = remaining;
    for (let i = this.currentLessonIndex + 1; i < this.lessonUrls.length; i++) {
      const t = this.options.perUrlTimes?.[i] || this.options.durationMinutes;
      totalRemainingMs += t * 60 * 1000;
    }
    const estimatedEndTime = new Date(Date.now() + totalRemainingMs).toISOString();

    return {
      id: this.id,
      account: this.account.name,
      lessonUrls: this.lessonUrls,
      currentLessonIndex: this.currentLessonIndex,
      currentUrl: this.lessonUrls[this.currentLessonIndex],
      totalLessons: this.lessonUrls.length,
      status: this.status,
      progress: this.status === 'completed' ? 100 : (durationMs > 0 ? Math.min(100, ((elapsed / durationMs) * 100)) : 0),
      elapsed: this.formatTime(elapsed),
      remaining: this.formatTime(remaining),
      elapsedMs: elapsed,
      remainingMs: remaining,
      totalRemainingMs,
      estimatedEndTime,
      durationMinutes: urlDuration,
      refreshCount: this.refreshCount,
      error: this.errorMsg,
    };
  }

  // =================== STEALTH FUNCTIONS =====================

  async fakeMouseMove() {
    const x = this.randomBetween(100, 1200);
    const y = this.randomBetween(100, 700);
    await this.page.mouse.move(x, y, { steps: this.randomBetween(3, 10) });
  }

  async fakeScroll() {
    const scrollY = this.randomBetween(-100, 200);
    await this.page.evaluate((dy) => window.scrollBy(0, dy), scrollY);
  }

  async fakeVisibilityAPI() {
    await this.page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: false, writable: false });
      Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: false });
    });
  }

  async fakeActivity() {
    const actions = ['mouse', 'scroll'];
    const action = actions[this.randomBetween(0, actions.length - 1)];
    try {
      if (action === 'mouse') await this.fakeMouseMove();
      else await this.fakeScroll();
    } catch (err) {
      this.log(`Stealth lỗi nhẹ: ${err.message}`, 'warn');
    }
  }

  // =================== URL VERIFICATION =====================

  // Kiểm tra xem trang hiện tại có khớp với URL bài học không
  _isOnLessonUrl(expectedUrl) {
    try {
      const current = new URL(this.page.url());
      const expected = new URL(expectedUrl);
      return current.pathname === expected.pathname;
    } catch {
      return false;
    }
  }

  // Chờ đến khi vào đúng URL bài học (heartbeat retry vô hạn nếu bị redirect về Home)
  async _waitUntilOnLessonUrl(expectedUrl) {
    let attempt = 0;
    while (!this._stopped) {
      if (this._isOnLessonUrl(expectedUrl)) return;
      attempt++;
      const currentUrl = this.page.url();
      this.log(`⚠️ Bị redirect về trang chủ (lần ${attempt}): ${currentUrl} → Thử lại sau 30 giây...`, 'warn');
      this.emit('status', this.getStatus());
      await this.page.waitForTimeout(30000);
      if (this._stopped) return;
      try {
        await this.page.goto(expectedUrl, { waitUntil: 'load', timeout: 60000 });
        await this.fakeVisibilityAPI();
        await this.page.waitForTimeout(2000);
      } catch (err) {
        this.log(`⚠️ Lỗi truy cập lại: ${err.message}`, 'warn');
      }
    }
  }

  // =================== AUTO REFRESH (F5) =====================

  async autoRefresh() {
    try {
      this.refreshCount++;
      this.log(`🔄 F5 Refresh #${this.refreshCount} - Đang reload trang...`, 'info');

      const expectedUrl = this.lessonUrls[this.currentLessonIndex];
      await this.page.reload({ waitUntil: 'load', timeout: 60000 });

      // Re-apply stealth sau mỗi lần refresh
      await this.fakeVisibilityAPI();
      await this.page.waitForTimeout(2000);

      // Kiểm tra URL sau F5 - nếu bị redirect về Home thì quay lại bài học
      if (!this._isOnLessonUrl(expectedUrl)) {
        const redirectedUrl = this.page.url();
        this.log(`⚠️ F5 bị redirect: ${redirectedUrl} → Đang chờ hệ thống cho phép vào lại...`, 'warn');
        await this._waitUntilOnLessonUrl(expectedUrl);
        if (this._stopped) return;
        this.log(`✅ Đã vào lại bài học sau khi F5 bị redirect`, 'success');
      }

      const title = await this.page.title();
      this.log(`🔄 Refresh xong - Trang: ${title}`, 'info');
      this.emit('refresh', { sessionId: this.id, count: this.refreshCount });
    } catch (err) {
      this.log(`⚠️ Refresh lỗi: ${err.message}`, 'warn');
    }
  }

  // ===================== TIMER SETUP ========================

  _setupTimers() {
    // Progress report mỗi 5 phút
    const progressTimer = setInterval(() => {
      if (this.status !== 'running') return;
      const status = this.getStatus();
      this.log(`📊 Bài ${this.currentLessonIndex + 1}: ${status.progress.toFixed(1)}% | Đã treo: ${status.elapsed} | Còn: ${status.remaining} | Refresh: ${this.refreshCount}`, 'info');
      this.emit('status', status);
    }, 5 * 60 * 1000);
    this.intervals.push(progressTimer);

    // Stealth loop
    const stealthTimer = setInterval(async () => {
      if (this.status !== 'running') return;
      try {
        await this.fakeActivity();
        await this.fakeVisibilityAPI();
      } catch { /* ignore */ }
    }, this.options.stealthInterval * 1000);
    this.intervals.push(stealthTimer);

    // Auto F5 refresh với random jitter ±30%
    this._scheduleRefresh();
  }

  _scheduleRefresh() {
    const baseMs = this.options.refreshInterval * 60 * 1000;
    const jitter = baseMs * 0.3;
    const actualMs = Math.round(baseMs + (Math.random() * 2 - 1) * jitter);
    const actualMin = (actualMs / 60000).toFixed(1);
    this.log(`⏳ F5 tiếp theo sau ${actualMin} phút (jitter ±30%)`, 'info');
    const t = setTimeout(async () => {
      if (this.status !== 'running') return;
      await this.autoRefresh();
      if (this.status === 'running') this._scheduleRefresh();
    }, actualMs);
    this.intervals.push(t);
  }

  // ===================== PAUSE / RESUME ======================

  pause() {
    if (this.status !== 'running') return false;
    this._pausedElapsedMs = Date.now() - this.startTime;
    this._pausedRemainingMs = Math.max(0, this.endTime - Date.now());
    this.status = 'paused';
    // Push endTime far into future so the main loop's checkTimer doesn't resolve
    this.endTime = Date.now() + 365 * 24 * 60 * 60 * 1000;
    this.clearTimers();
    this.log('⏸ Tạm dừng phiên', 'info');
    this.emit('status', this.getStatus());
    return true;
  }

  resume() {
    if (this.status !== 'paused') return false;
    this.startTime = Date.now() - this._pausedElapsedMs;
    this.endTime = Date.now() + this._pausedRemainingMs;
    this.status = 'running';
    // Re-setup all timers + main loop check
    this._setupTimers();
    // Re-create the main loop checkTimer to resolve the holdLesson promise
    const checkTimer = setInterval(() => {
      if (this.status === 'error' || this.status === 'idle') {
        clearInterval(checkTimer);
        if (this._holdResolve) { this._holdResolve(); this._holdResolve = null; }
        return;
      }
      if (Date.now() >= this.endTime) {
        clearInterval(checkTimer);
        if (this._holdResolve) { this._holdResolve(); this._holdResolve = null; }
      }
    }, 5000);
    this.intervals.push(checkTimer);
    // Status update mỗi 30 giây
    const statusTimer = setInterval(() => {
      if (this.status !== 'running') return;
      this.emit('status', this.getStatus());
    }, 30 * 1000);
    this.intervals.push(statusTimer);
    this.log('▶️ Tiếp tục phiên', 'info');
    this.emit('status', this.getStatus());
    return true;
  }

  // ===================== CORE LOGIC ==========================

  async login() {
    this.status = 'logging-in';
    this.emit('status', this.getStatus());

    // Retry vô hạn khi mạng chưa sẵn sàng (ERR_ADDRESS_UNREACHABLE, ECONNREFUSED, timeout...)
    let attempt = 0;
    while (!this._stopped) {
      try {
        this.log('🔑 Đang mở trang login...', 'info');
        await this.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        break; // Thành công → thoát vòng lặp
      } catch (err) {
        attempt++;
        const isNetworkError = err.message.includes('ERR_ADDRESS_UNREACHABLE')
          || err.message.includes('ERR_CONNECTION_REFUSED')
          || err.message.includes('ERR_NAME_NOT_RESOLVED')
          || err.message.includes('ERR_NETWORK_CHANGED')
          || err.message.includes('ERR_INTERNET_DISCONNECTED')
          || err.message.includes('net::ERR')
          || err.message.includes('ECONNREFUSED')
          || err.message.includes('ENOTFOUND')
          || err.message.toLowerCase().includes('timeout');
        if (!isNetworkError) throw err; // Lỗi khác (vd: login sai pass) → re-throw
        this.log(`⚠️ Mạng chưa sẵn sàng (lần ${attempt}): ${err.message.split('\n')[0]} → Thử lại sau 60 giây...`, 'warn');
        this.emit('status', this.getStatus());
        await this.page.waitForTimeout(60000);
        if (this._stopped) return;
        // Tạo page mới vì page cũ có thể đã corrupt sau lỗi mạng
        try {
          await this.page.close();
          this.page = await this.context.newPage();
        } catch { /* ignore */ }
      }
    }
    if (this._stopped) return;

    await this.page.waitForSelector('input[name="login"]', { timeout: 15000 });

    this.log('📝 Đang điền form login...', 'info');
    await this.page.fill('input[name="login"]', this.account.email);
    await this.page.fill('input[name="password"]', this.account.password);

    await this.page.waitForTimeout(this.randomBetween(500, 1500));

    await Promise.all([
      this.page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }),
      this.page.click('button[type="submit"]'),
    ]);

    const currentUrl = this.page.url();
    if (currentUrl.includes('/web/login')) {
      const errorEl = await this.page.$('.alert-danger');
      if (errorEl) {
        const errorText = await errorEl.textContent();
        throw new Error(`Login thất bại: ${errorText.trim()}`);
      }
    }

    this.log('✅ Login thành công!', 'success');
  }

  async navigateToLesson() {
    const url = this.lessonUrls[this.currentLessonIndex];
    this.log(`📖 Đang mở bài ${this.currentLessonIndex + 1}/${this.lessonUrls.length}: ${url}`, 'info');
    await this.page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await this.fakeVisibilityAPI();
    await this.page.waitForTimeout(2000);

    // Kiểm tra URL sau khi điều hướng - hệ thống có thể delay và redirect về Home
    if (!this._isOnLessonUrl(url)) {
      const currentUrl = this.page.url();
      this.log(`⚠️ Bài học chưa mở được (redirect: ${currentUrl}) - hệ thống có thể đang delay...`, 'warn');
      await this._waitUntilOnLessonUrl(url);
      if (this._stopped) return;
      this.log(`✅ Đã vào được bài học sau khi chờ hệ thống cho phép`, 'success');
    }

    const title = await this.page.title();
    this.log(`📖 Đang ở bài: ${title}`, 'success');
  }

  async holdLesson() {
    // Thời gian riêng cho URL hiện tại (nếu có)
    const perUrlTime = this.options.perUrlTimes?.[this.currentLessonIndex];
    const urlDuration = perUrlTime || this.options.durationMinutes;
    const durationMs = urlDuration * 60 * 1000;
    this.startTime = Date.now();
    this.endTime = this.startTime + durationMs;
    this.status = 'running';
    this.emit('status', this.getStatus());

    this.log(`⏱️ Treo bài ${this.currentLessonIndex + 1}/${this.lessonUrls.length} - ${urlDuration} phút (${(urlDuration / 60).toFixed(1)}h)${perUrlTime ? ' (đã tuỳ chỉnh)' : ''}`, 'info');
    this.log(`🔄 Auto refresh mỗi ${this.options.refreshInterval} phút`, 'info');

    this._setupTimers();

    // Kiểm tra giới hạn khung giờ học
    const timeWindows = this.options.timeWindows || [];
    if (timeWindows.length > 0) {
      const windowEndMs = this._calcMsUntilWindowEnd(timeWindows);
      if (windowEndMs > 0 && windowEndMs < durationMs) {
        this.log(`⏰ Khung giờ hiện tại kết thúc sau ${Math.round(windowEndMs / 60000)} phút — sẽ F5 lưu checkpoint và tạm dừng`, 'info');
        const windowTimer = setTimeout(async () => {
          if (this.status !== 'running') return;
          this.log(`⏰ Hết giờ khung học — F5 lưu checkpoint và tạm dừng...`, 'warn');
          try { await this.autoRefresh(); } catch { /* ignore */ }
          this._timeLimitHit = true;
          this._timeLimitData = {
            currentLessonIndex: this.currentLessonIndex,
            remainingMs: Math.max(0, this.endTime - Date.now()),
          };
          this.status = 'time-limit'; // Ngăn F5 cuối bài chạy lại
          if (this._holdResolve) { this._holdResolve(); this._holdResolve = null; }
        }, windowEndMs);
        this.intervals.push(windowTimer);
      }
    }

    // Status update mỗi 30 giây (cho web UI)
    const statusTimer = setInterval(() => {
      if (this.status !== 'running') return;
      this.emit('status', this.getStatus());
    }, 30 * 1000);
    this.intervals.push(statusTimer);

    // Đợi hết thời gian (lưu resolve để pause/resume có thể tái tạo)
    await new Promise((resolve) => {
      this._holdResolve = resolve;
      const checkTimer = setInterval(() => {
        if (this.status === 'error' || this.status === 'idle') {
          clearInterval(checkTimer);
          this._holdResolve = null;
          resolve();
          return;
        }
        if (this.status !== 'paused' && Date.now() >= this.endTime) {
          clearInterval(checkTimer);
          this._holdResolve = null;
          resolve();
        }
      }, 5000);
      this.intervals.push(checkTimer);
    });

    this.clearTimers();

    if (this.status === 'running') {
      // F5 lần cuối trước khi chuyển bài
      this.log(`🔄 F5 lần cuối trước khi kết thúc bài ${this.currentLessonIndex + 1}...`, 'info');
      await this.autoRefresh();

      this.log(`🎉 Hoàn thành bài ${this.currentLessonIndex + 1}/${this.lessonUrls.length}! Refresh: ${this.refreshCount} lần.`, 'success');
      this.emit('status', this.getStatus());
    }
  }

  // ===================== PUBLIC API ==========================

  async start() {
    this.log(`🚀 Khởi động bot cho ${this.account.name} - ${this.lessonUrls.length} bài`, 'info');

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

      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['vi-VN', 'vi', 'en-US', 'en'] });
      });

      this.page = await this.context.newPage();

      await this.login();

      const startIdx = this.options.startLessonIndex || 0;
      for (let i = startIdx; i < this.lessonUrls.length; i++) {
        if (this.status === 'error' || this.status === 'idle') break;

        this.currentLessonIndex = i;
        this.refreshCount = 0;

        if (i > startIdx) {
          this.log(`📋 Chuyển sang bài ${i + 1}/${this.lessonUrls.length}...`, 'info');
        }

        await this.navigateToLesson();
        await this.holdLesson();

        // Kiểm tra nếu hết giờ khung học
        if (this._timeLimitHit) {
          this.emit('time-limit', this._timeLimitData);
          this._timeLimitHit = false;
          break;
        }

        if (this.status !== 'running') break;
      }

      if (this.status === 'running') {
        this.status = 'completed';
        this.progress = 100;
        this.log(`🎉 Hoàn thành cặp ${this.lessonUrls.length} bài!`, 'success');
        this.emit('status', this.getStatus());
      }
    } catch (err) {
      this.status = 'error';
      this.errorMsg = err.message;
      this.log(`❌ Lỗi khởi động Playwright: ${err.message}. (Gợi ý: Chạy 'npx playwright install chromium' trên VPS)`, 'error');
      this.emit('status', this.getStatus());
    } finally {
      await this.stop();
    }
  }

  async stop() {
    if (this._stopped) return;
    this._stopped = true;

    this._holdResolve = null;
    this.clearTimers();

    if (this.browser) {
      try {
        await this.browser.close();
      } catch { /* ignore */ }
      this.browser = null;
      this.page = null;
      this.context = null;
    }

    if (this.status === 'running' || this.status === 'logging-in' || this.status === 'paused') {
      this.status = 'idle';
    }

    this.log('🔒 Đã đóng trình duyệt.', 'info');
    this.emit('status', this.getStatus());
    this.emit('done', this.getStatus());
  }
}

module.exports = { BotSession };
