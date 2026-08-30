const { chromium } = require('playwright');
const EventEmitter = require('events');
const { isAllowedStudyDate, getNextAllowedStudyDate, scanCourseDetails, readDomTimer, getShiftsForDate, calcMsRemainingInShift, getNextShiftStart } = require('./courseScanner');

const BASE_URL = 'https://hoclythuyetlaixe.eco-tek.com.vn';
const LOGIN_URL = `${BASE_URL}/web/login`;
const SESSION_LOG_SEPARATOR = '---------------------------------------------------------';
const POST_TARGET_GRACE_MINUTES = 5;

const COURSE_FINALIZATION_STATES = Object.freeze({
  NORMAL_STUDY: 'normal-study',
  TARGET_REACHED: 'target-reached',
  CHECKPOINT: 'checkpoint',
  COMPLETED: 'completed',
  VERIFICATION_PENDING: 'verification-pending',
});

// Danh sách CHÍNH THỨC mọi trạng thái một phiên Auto-Scan có thể mang.
// Dashboard phải hiểu được toàn bộ danh sách này (xem test frontendStatusContract).
const AUTO_COURSE_STATUSES = [
  'idle', 'logging-in', 'scanning', 'studying', 'paused',
  'date-limit', 'daily-limit', 'time-window', 'next-day',
  'completed', 'stopped', 'error',
];

// Trạng thái phiên đã kết thúc — không bao giờ được quay lại chạy tiếp.
const TERMINAL_STATUSES = new Set(['completed', 'stopped', 'error']);

// Trạng thái server sẽ tự hẹn giờ chạy lại.
const SCHEDULED_STATUSES = new Set(['date-limit', 'daily-limit', 'time-window', 'next-day']);

// Giai đoạn vòng đời của đối tượng phiên (khác với `status` hiển thị):
//   new      → chưa từng gọi start(), chưa chiếm tài khoản Odoo
//   running  → start() đang chạy, đang/sắp giữ browser
//   finished → đã dọn dẹp xong, KHÔNG được chạy lại (phải tạo phiên mới)
const PHASE_NEW = 'new';
const PHASE_RUNNING = 'running';
const PHASE_FINISHED = 'finished';

function courseReachedTarget(targetMinutes, studiedMinutes, allLessonsCompleted = false) {
  const target = Math.max(0, Number(targetMinutes) || 0);
  const studied = Math.max(0, Number(studiedMinutes) || 0);
  return target > 0 ? studied >= target : allLessonsCompleted;
}

function createCourseFinalizationPlan(existingPlan, lessonRemainingMs, elapsedMs = 0) {
  if (existingPlan) return existingPlan;

  const remainingMs = Math.max(0, Number(lessonRemainingMs) || 0);
  const graceMs = POST_TARGET_GRACE_MINUTES * 60 * 1000;
  const allowanceMs = Math.min(remainingMs, graceMs);

  return Object.freeze({
    state: COURSE_FINALIZATION_STATES.TARGET_REACHED,
    mode: remainingMs <= graceMs ? 'finish-current-lesson' : 'grace-period',
    lessonRemainingMsAtTarget: remainingMs,
    allowanceMs,
    deadlineElapsedMs: Math.max(0, Number(elapsedMs) || 0) + allowanceMs,
  });
}

function getCourseTargetRemainingMs(targetMinutes, trackedStudyMs) {
  const targetMs = Math.max(0, Number(targetMinutes) || 0) * 60 * 1000;
  return Math.max(0, targetMs - Math.max(0, Number(trackedStudyMs) || 0));
}

function isAutoCourseAccountBlockingStatus(status) {
  return ['idle', 'logging-in', 'scanning', 'studying', 'paused'].includes(status);
}

function getPersistentAutoCourseOptions(options = {}) {
  return {
    dailyMaxMinutes: options.dailyMaxMinutes ?? 480,
    allowedDateRanges: options.allowedDateRanges || [],
    newDayStartTime: options.newDayStartTime || '06:00',
    refreshInterval: options.refreshInterval || 15,
    stealthInterval: options.stealthInterval || 30,
    stealth: options.stealth === true,
    timeWindows: options.timeWindows || [],
    customTimeRules: options.customTimeRules || [],
    initialDailyMinutesToggle: options.initialDailyMinutesToggle === true,
    initialDailyMinutes: options.initialDailyMinutes || 0,
    initialDailyDate: options.initialDailyDate || null,
  };
}

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
      initialDailyMinutesToggle: false, // Bật/tắt đặt trước thời gian đã học hôm nay (chỉ 1 ngày)
      initialDailyMinutes: 0, // Số phút đặt trước
      initialDailyDate: null, // Ngày áp dụng (YYYY-MM-DD VN)
      ...options,
    };

    this.status = 'idle'; // idle | logging-in | scanning | studying | paused | date-limit | daily-limit | time-window | next-day | completed | stopped | error
    this.pausedFromStatus = null;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.currentCourseIndex = 0;
    this.currentLessonIndex = 0;
    this.dailyDate = this._vnDateStr(); // Ngày VN của bộ đếm giờ học trong ngày
    this.dailyStudiedMinutes = 0;

    // Gán thời gian đã học khởi tạo nếu bật Toggle và ngày áp dụng khớp với hôm nay (giờ VN)
    if (this.options.initialDailyMinutesToggle) {
      const targetDate = this.options.initialDailyDate || this.dailyDate;
      if (targetDate === this.dailyDate) {
        this.dailyStudiedMinutes = Math.max(0, parseInt(this.options.initialDailyMinutes, 10) || 0);
      }
    }

    this.courseProgress = {}; // courseUrl -> { studiedMinutes, targetMinutes, completed }
    this._stopped = false;
    this._phase = PHASE_NEW;
    this._stealthTimer = null;
    this._pauseStartedAt = null;
    this._totalPausedMs = 0;
    this._sessionSeparatorLogged = false;
    this._courseRunGeneration = 0;
    this._activeCourseRunId = null;
  }

  // Đối tượng phiên này đã chạy (hoặc đang chạy) chưa?
  isRunning() {
    return this._phase === PHASE_RUNNING;
  }

  isFinished() {
    return this._phase === PHASE_FINISHED;
  }

  // Chốt vòng đời đối tượng phiên mà KHÔNG coi là bị người dùng hủy (`_stopped`
  // giữ nguyên false). Dùng cho các nhánh thoát sớm trước khi mở browser (ngày
  // nghỉ / ngoài ca / ngoài khung giờ): đối tượng này sẽ không chạy tiếp nữa —
  // đến giờ hẹn server tạo phiên MỚI cùng ID để chạy lại.
  _finishPhase() {
    this._phase = PHASE_FINISHED;
    this._clearStealthLoop();
  }

  // Phiên có đang thực sự chiếm phiên đăng nhập Odoo của tài khoản không?
  // Phiên vừa tạo mà chưa start() thì KHÔNG chiếm gì cả — nếu coi là chiếm,
  // hai phiên cùng chờ khởi động sẽ chặn lẫn nhau vĩnh viễn.
  ownsAccountSession() {
    return this._phase === PHASE_RUNNING || this.status === 'paused';
  }

  // Chuyển trạng thái làm việc (logging-in / scanning / studying).
  // Không được ghi đè 'paused': người dùng đã bấm Tạm dừng thì phiên phải ở
  // 'paused' cho tới khi resume(), chỉ cập nhật trạng thái sẽ quay về sau đó.
  _setStatus(next) {
    if (this.status === 'paused') {
      this.pausedFromStatus = next;
      return false;
    }
    if (TERMINAL_STATUSES.has(this.status)) return false;
    this.status = next;
    return true;
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
    this._setStatus('time-window');
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

  _hitDailyLimit() {
    this._rolloverDailyCounter();
    if (this.dailyStudiedMinutes < this.options.dailyMaxMinutes) return false;
    this._setStatus('daily-limit');
    this.log(`🛑 Đã đạt giới hạn học tối đa trong ngày (${this._formatMinutes(this.options.dailyMaxMinutes)}) → Hẹn ${this.options.newDayStartTime || '06:00'} sáng ngày học tiếp theo tiếp tục!`, 'warn');
    this.emit('status', this.getStatus());
    return true;
  }

  _hitSchedulingLimit() {
    return this._hitDailyLimit() || this._hitTimeShiftLimit() || this._hitTimeWindowLimit();
  }

  _allConfiguredCoursesCompleted() {
    return this.coursesConfig.length > 0
      && this.coursesConfig.every(course => this.courseProgress[course.courseUrl]?.completed === true);
  }

  // Chỉ dùng marker hoàn thành thuộc chính slide hiện tại. Selector `.badge` hoặc
  // `.fa-check` toàn trang có thể trúng badge 100%/icon của menu, quiz hay header.
  async _isCurrentLessonCompleted() {
    if (!this.page) return false;
    try {
      return await this.page.evaluate(() => {
        const doneContainer = document.querySelector('.o_wslides_sidebar_done_button[data-completed]');
        if (doneContainer) {
          return String(doneContainer.getAttribute('data-completed')).toLowerCase() === 'true';
        }
        return Boolean(document.querySelector(
          '.o_wslides_sidebar_done_button .o_wslides_slide_completed:not(.d-none), ' +
          '.o_wslides_sidebar_done_button .o_wslides_undone_button, ' +
          'a.o_wslides_undone_button, button.o_wslides_undone_button'
        ));
      });
    } catch {
      return false;
    }
  }

  // Xác minh chéo tiến độ ngay trên trang khóa học bằng một tab dùng chung
  // phiên đăng nhập. Chỉ progress 100% của đúng URL bài mới được coi là xong.
  async _verifyLessonProgressFromCourse(courseUrl, lessonUrl) {
    if (!this.context) return { completed: false, progressPercent: null };
    let verifyPage = null;
    try {
      verifyPage = await this.context.newPage();
      const result = await scanCourseDetails(verifyPage, courseUrl);
      if (!result || !Array.isArray(result.allLessons)) {
        return { completed: false, progressPercent: null };
      }
      const expectedPath = new URL(lessonUrl).pathname;
      const matchedLesson = result.allLessons.find(item => {
        try { return new URL(item.url).pathname === expectedPath; } catch { return false; }
      });
      return {
        completed: matchedLesson?.progressPercent >= 100,
        progressPercent: matchedLesson?.progressPercent ?? null,
      };
    } catch (err) {
      this.log(`⚠️ Không thể xác minh tiến độ bài từ trang khóa học: ${String(err.message).split('\n')[0]}`, 'warn');
      return { completed: false, progressPercent: null };
    } finally {
      if (verifyPage) {
        try { await verifyPage.close(); } catch { /* ignore */ }
      }
    }
  }

  _isCurrentCourseRun(courseRunId) {
    return !this._stopped && this._activeCourseRunId === courseRunId;
  }

  _setCourseFinalizationState(courseUrl, state) {
    if (!this.courseProgress[courseUrl]) return;
    this.courseProgress[courseUrl].finalizationState = state;
    this.emit('status', this.getStatus());
  }

  async _scanCourseDetailsForCheckpoint(courseUrl, preserveCurrentPage = false) {
    if (!preserveCurrentPage || !this.context) return scanCourseDetails(this.page, courseUrl);

    let checkpointPage = null;
    try {
      checkpointPage = await this.context.newPage();
      return await scanCourseDetails(checkpointPage, courseUrl);
    } finally {
      if (checkpointPage) {
        try { await checkpointPage.close(); } catch { /* ignore */ }
      }
    }
  }

  async _verifyCourseProgressAfterCheckpoint({
    courseUrl,
    targetMinutes,
    courseTitle,
    courseRunId,
    preserveCurrentPage = false,
    continueStudying = false,
  }) {
    this.log('🔍 Re-checking course progress after checkpoint', 'info');
    let verifiedScan = null;
    for (let attempt = 1; attempt <= 2 && this._isCurrentCourseRun(courseRunId); attempt++) {
      verifiedScan = await this._scanCourseDetailsForCheckpoint(courseUrl, preserveCurrentPage);
      if (verifiedScan && verifiedScan.totalLessons > 0) break;
      if (attempt < 2) {
        this.log(`⚠️ Course checkpoint scan failed (attempt ${attempt}/2) — retrying once`, 'warn');
        await this.page.waitForTimeout(5000);
      }
    }

    if (!this._isCurrentCourseRun(courseRunId)) return { confirmed: false, stale: true, scanResult: verifiedScan };

    if (!verifiedScan || verifiedScan.totalLessons === 0) {
      this._setCourseFinalizationState(
        courseUrl,
        continueStudying
          ? COURSE_FINALIZATION_STATES.NORMAL_STUDY
          : COURSE_FINALIZATION_STATES.VERIFICATION_PENDING
      );
      this.log(
        continueStudying
          ? `⚠️ Unable to verify refreshed Web Odoo progress for [${courseTitle}] — continuing the current lesson within its existing limit`
          : `⚠️ Unable to verify refreshed Web Odoo progress for [${courseTitle}] — this course will not resume in the current run`,
        'warn'
      );
      return { confirmed: false, stale: false, scanResult: verifiedScan };
    }

    const verifiedMinutes = Math.max(0, Number(verifiedScan.actualStudiedMinutes) || 0);
    const allLessonsCompleted = verifiedScan.uncompletedLessons.length === 0;
    const confirmed = courseReachedTarget(targetMinutes, verifiedMinutes, allLessonsCompleted);
    this.courseProgress[courseUrl] = {
      ...this.courseProgress[courseUrl],
      title: verifiedScan.courseTitle || courseTitle,
      targetMinutes,
      studiedMinutes: verifiedMinutes,
      completed: confirmed,
      finalizationState: confirmed
        ? COURSE_FINALIZATION_STATES.COMPLETED
        : continueStudying
          ? COURSE_FINALIZATION_STATES.NORMAL_STUDY
          : COURSE_FINALIZATION_STATES.VERIFICATION_PENDING,
    };
    this.emit('status', this.getStatus());

    if (confirmed) {
      this.log(`✅ Course confirmed complete: ${verifiedMinutes}/${targetMinutes} minutes`, 'success');
    } else {
      this.log(
        continueStudying
          ? `⏱️ Checkpoint reports ${verifiedMinutes}/${targetMinutes} minutes — continuing the current lesson`
          : `⚠️ Checkpoint reports ${verifiedMinutes}/${targetMinutes} minutes for [${verifiedScan.courseTitle || courseTitle}] — not marking complete and not resuming this course in the current run`,
        continueStudying ? 'info' : 'warn'
      );
    }

    return { confirmed, stale: false, scanResult: verifiedScan };
  }

  async _checkpointAndVerifyCourse({
    courseUrl,
    targetMinutes,
    courseTitle,
    courseRunId,
    preserveCurrentPage = false,
    continueStudying = false,
  }) {
    if (!this._isCurrentCourseRun(courseRunId)) return { confirmed: false, stale: true, scanResult: null };

    this._setCourseFinalizationState(courseUrl, COURSE_FINALIZATION_STATES.CHECKPOINT);
    this.log('🔄 Refreshing page for checkpoint verification', 'info');

    try {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await this._fakeVisibilityAPI();
      await this.page.waitForTimeout(7000);
    } catch (err) {
      this.log(`⚠️ Checkpoint refresh failed: ${String(err.message).split('\n')[0]} — continuing with bounded course re-scan`, 'warn');
    }

    if (!this._isCurrentCourseRun(courseRunId)) return { confirmed: false, stale: true, scanResult: null };

    return this._verifyCourseProgressAfterCheckpoint({
      courseUrl,
      targetMinutes,
      courseTitle,
      courseRunId,
      preserveCurrentPage,
      continueStudying,
    });
  }

  // Chờ nếu phiên đang ở trạng thái Tạm dừng (paused)
  async _checkPaused() {
    while (this.status === 'paused' && !this._stopped) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  _getTotalPausedMs(now = Date.now()) {
    const currentPauseMs = this._pauseStartedAt == null ? 0 : Math.max(0, now - this._pauseStartedAt);
    return this._totalPausedMs + currentPauseMs;
  }

  // Wait for active study time only. Paused wall-clock time must never advance progress.
  async _waitForActiveStudyTime(targetMs) {
    const target = Math.max(0, Number(targetMs) || 0);
    let activeElapsedMs = 0;

    while (activeElapsedMs < target && !this._stopped) {
      await this._checkPaused();
      if (this._stopped) break;
      if (this._msRemainingInWindow() === -2 || !this._checkCustomShifts().inShift) break;

      const stepMs = Math.min(1000, target - activeElapsedMs);
      const startedAt = Date.now();
      const pausedBefore = this._getTotalPausedMs(startedAt);
      await new Promise(resolve => setTimeout(resolve, stepMs));
      const endedAt = Date.now();
      const pausedAfter = this._getTotalPausedMs(endedAt);
      const activeStepMs = Math.max(0, (endedAt - startedAt) - (pausedAfter - pausedBefore));
      activeElapsedMs += Math.min(stepMs, activeStepMs);
    }

    return activeElapsedMs;
  }

  // Tạm dừng phiên
  pause() {
    if (this._stopped || this.status === 'stopped' || this.status === 'completed' || this.status === 'error' || this.status === 'paused') {
      return false;
    }
    this.pausedFromStatus = this.status;
    this._pauseStartedAt = Date.now();
    this.status = 'paused';
    this.log(`⏸ Tạm dừng phiên Auto-Scan cho ${this.account.name}`, 'info');
    this.emit('status', this.getStatus());
    return true;
  }

  // Tiếp tục phiên
  resume() {
    if (this.status !== 'paused') return false;
    const prev = this.pausedFromStatus || 'studying';
    if (this._pauseStartedAt != null) {
      this._totalPausedMs += Math.max(0, Date.now() - this._pauseStartedAt);
      this._pauseStartedAt = null;
    }
    this.pausedFromStatus = null;
    this.status = prev;
    this.log(`▶️ Tiếp tục phiên Auto-Scan cho ${this.account.name}`, 'info');
    this.emit('status', this.getStatus());
    return true;
  }

  // Cập nhật lại số phút đã học hôm nay (điều chỉnh thủ công trên Dashboard)
  setDailyStudiedMinutes(minutes) {
    const m = Math.max(0, parseInt(minutes, 10) || 0);
    this.dailyStudiedMinutes = m;
    this.log(`✏️ Đã cập nhật lại thời gian đã học hôm nay thành ${this._formatMinutes(m)}`, 'info');
    this.emit('status', this.getStatus());
    return m;
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

  _logSessionSeparator() {
    if (this._sessionSeparatorLogged) return;
    this._sessionSeparatorLogged = true;
    this.log(SESSION_LOG_SEPARATOR, 'separator');
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
    this._setStatus('logging-in');
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
      this._setStatus('date-limit');
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
    // Một đối tượng phiên chỉ được chạy ĐÚNG MỘT LẦN. Gọi start() lần thứ hai
    // (double-click, hai tab, timer trùng, restore chồng lệnh) sẽ mở browser thứ
    // hai cho cùng tài khoản Odoo và làm phiên trước bị văng đăng nhập.
    // Muốn chạy lại thì phải tạo phiên mới — server làm việc đó ở restartAutoScanSession().
    if (this._phase !== PHASE_NEW) {
      this.log(`⚠️ Bỏ qua yêu cầu khởi động trùng lặp (phiên đã ở giai đoạn "${this._phase}")`, 'warn');
      return;
    }
    this._phase = PHASE_RUNNING;

    this._logSessionSeparator();
    this.log(`🤖 Khởi động Auto-Scan khóa học cho ${this.account.name}`, 'info');

    // 1. Kiểm tra Lịch Ngày Học Được Phép
    const now = new Date();
    if (!isAllowedStudyDate(now, this.options.allowedDateRanges)) {
      const nextDate = getNextAllowedStudyDate(now, this.options.allowedDateRanges, this.options.newDayStartTime);
      this._setStatus('date-limit');
      this.log(`⏰ Hôm nay (${now.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}) là ngày nghỉ — Hẹn lịch tiếp tục lúc ${this.options.newDayStartTime || '06:00'} ngày ${nextDate.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`, 'warn');
      this.emit('status', this.getStatus());
      this._finishPhase();
      return;
    }

    // 2. Kiểm tra Khung Giờ Ca Học (nếu có quy tắc riêng)
    if (this._hitTimeShiftLimit()) { this._finishPhase(); return; }

    // 3. Kiểm tra Khung Giờ Học Tổng Quát (nếu được cấu hình) trước khi mở browser
    if (this._hitTimeWindowLimit()) { this._finishPhase(); return; }

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
        if (this._hitSchedulingLimit()) return;

        const cConfig = this.coursesConfig[cIdx];
        this.currentCourseIndex = cIdx;
        const courseRunId = ++this._courseRunGeneration;
        this._activeCourseRunId = courseRunId;

        const targetMinutes = (Number(cConfig.targetHours) || 0) * 60 + (Number(cConfig.targetMinutes) || 0);
        this._setStatus('scanning');
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

        let courseStudiedMins = scanResult.actualStudiedMinutes || 0;
        this.courseProgress[cConfig.courseUrl] = {
          title: scanResult.courseTitle,
          targetMinutes,
          studiedMinutes: courseStudiedMins,
          completed: false,
          finalizationState: COURSE_FINALIZATION_STATES.NORMAL_STUDY,
        };

        if (scanResult.actualStudiedText) {
          this.log(`⏱️ Thời gian đã hoàn thành tích lũy trên web: ${scanResult.actualStudiedText} (${courseStudiedMins} phút)`, 'info');
        }

        if (targetMinutes > 0 && courseStudiedMins >= targetMinutes) {
          this.log(`🎯 Course already reached target: ${courseStudiedMins}/${targetMinutes} minutes`, 'success');
          this.log('⏭️ No additional study required', 'info');
          this.log('🔄 Performing checkpoint verification', 'info');
          await this._checkpointAndVerifyCourse({
            courseUrl: cConfig.courseUrl,
            targetMinutes,
            courseTitle: scanResult.courseTitle,
            courseRunId,
          });
          if (cIdx + 1 < this.coursesConfig.length) this.log('➡️ Switching to next course', 'success');
          continue;
        }

        if (scanResult.uncompletedLessons.length === 0) {
          const reachedTarget = courseReachedTarget(targetMinutes, courseStudiedMins, true);
          this.courseProgress[cConfig.courseUrl].completed = reachedTarget;
          if (reachedTarget) {
            this.log(`🎉 Tất cả ${scanResult.totalLessons} bài học trong Khóa [${scanResult.courseTitle}] đều đã hoàn thành${targetMinutes > 0 ? ' và khóa đã đạt mục tiêu thời gian' : ' 100%'}!`, 'success');
          } else {
            this.log(`⚠️ Các bài trong Khóa [${scanResult.courseTitle}] đang hiển thị 100% nhưng thời gian tích lũy mới ${this._formatMinutes(courseStudiedMins)}/${this._formatMinutes(targetMinutes)} — chưa đánh dấu hoàn thành, sẽ quét lại vào ngày học tiếp theo.`, 'warn');
          }
          continue;
        }

        const courseBaseStudiedMs = courseStudiedMins * 60 * 1000;
        let courseSessionStudiedMs = 0;
        let courseFinalizedThisRun = false;

        // Vòng lặp qua các bài chưa hoàn thành trong khóa
        for (let lIdx = 0; lIdx < scanResult.uncompletedLessons.length; lIdx++) {
          if (this._stopped) break;
          await this._checkPaused();
          if (this._hitSchedulingLimit()) return;

          this._rolloverDailyCounter();
          const remainingDailyMins = Math.max(0, this.options.dailyMaxMinutes - this.dailyStudiedMinutes);

          this.log(`⏳ Thời gian học trong ngày còn lại: ${this._formatMinutes(remainingDailyMins)} (${remainingDailyMins} phút / tối đa ${this._formatMinutes(this.options.dailyMaxMinutes)})`, 'info');

          if (targetMinutes > 0 && courseStudiedMins >= targetMinutes) {
            this.log(`🎯 Course target reached before opening another lesson: ${courseStudiedMins}/${targetMinutes} minutes`, 'success');
            this.log('⏭️ No additional study required', 'info');
            await this._checkpointAndVerifyCourse({
              courseUrl: cConfig.courseUrl,
              targetMinutes,
              courseTitle: scanResult.courseTitle,
              courseRunId,
            });
            courseFinalizedThisRun = true;
            if (cIdx + 1 < this.coursesConfig.length) this.log('➡️ Switching to next course', 'success');
            break;
          }

          const lesson = scanResult.uncompletedLessons[lIdx];
          this.log(`📖 Mở bài ${lIdx + 1}/${scanResult.uncompletedLessons.length}: ${lesson.title} (${lesson.url})`, 'info');

          let apiTimerSec = null;
          const responseHandler = async (res) => {
            if (!this._isCurrentCourseRun(courseRunId)) return;
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
            const parsedMins = Math.ceil(apiTimerSec / 60);
            lessonMinutes = Math.max(5, parsedMins);
            this.log(`⏱️ Bắt trực tiếp từ API /slide/countdown-start/: ${h}h ${m}m ${s}s (Treo ${lessonMinutes} phút — tối thiểu 5p để Odoo lưu checkpoint)`, 'success');
          } else {
            // Thử đọc DOM Timer với cơ chế RETRY (tối đa 5 lần)
            let domTimer = null;
            const maxDomRetries = 5;
            for (let retry = 1; retry <= maxDomRetries; retry++) {
              if (this._stopped) break;

              // Kiểm tra nếu apiTimerSec được ghi nhận bất đồng bộ từ network response handler
              if (apiTimerSec && !isNaN(apiTimerSec) && apiTimerSec > 0) {
                const h = Math.floor(apiTimerSec / 3600);
                const m = Math.floor((apiTimerSec % 3600) / 60);
                const s = apiTimerSec % 60;
                const parsedMins = Math.ceil(apiTimerSec / 60);
                lessonMinutes = Math.max(5, parsedMins);
                this.log(`⏱️ Bắt trực tiếp từ API /slide/countdown-start/ (lần thử ${retry}): ${h}h ${m}m ${s}s (Treo ${lessonMinutes} phút — tối thiểu 5p để Odoo lưu checkpoint)`, 'success');
                domTimer = { hours: h, minutes: m, seconds: s, totalMinutes: lessonMinutes, source: 'api' };
                break;
              }

              domTimer = await readDomTimer(this.page);
              if (domTimer) {
                if (domTimer.totalMinutes > 0 && !isNaN(domTimer.totalMinutes)) {
                  // Đảm bảo thời gian treo tối thiểu 5 phút liên tục để Odoo chốt checkpoint
                  lessonMinutes = Math.max(5, domTimer.totalMinutes);
                  this.log(`⏱️ Đã phát hiện bộ đếm DOM Timer (lần thử ${retry}/${maxDomRetries}): ${domTimer.hours}h ${domTimer.minutes}m ${domTimer.seconds}s (Treo ${lessonMinutes} phút — tối thiểu 5p để Odoo lưu checkpoint)`, 'success');
                  break;
                } else if (domTimer.hours === 0 && domTimer.minutes === 0 && domTimer.seconds === 0) {
                  const isTrulyCompleted = await this._isCurrentLessonCompleted();

                  if (isTrulyCompleted) {
                    lessonMinutes = 0;
                    this.log(`🎉 Giao diện web xác nhận bài học đã hoàn thành 100% ➔ Bỏ qua bài này!`, 'success');
                    break;
                  } else {
                    this.log(`⚠️ DOM Timer tạm trả về 0h 0m 0s nhưng bài chưa đạt 100% trên web (lần thử ${retry}/${maxDomRetries}) ➔ Tiếp tục tải lại...`, 'warn');
                  }
                }
              }

              if (retry < maxDomRetries) {
                this.log(`🔄 Chưa đọc được DOM Timer (Lần ${retry}/${maxDomRetries}) — Đang thử lại...`, 'warn');
                this.emit('status', this.getStatus());

                // Nếu thử 2 lần chưa được, F5 lại trang để khôi phục JS script/widget của Odoo
                if (retry === 2) {
                  this.log(`🔄 Thử F5 làm mới trang để nạp lại bộ đếm DOM Timer...`, 'info');
                  try {
                    await this.page.reload({ waitUntil: 'load', timeout: 60000 });
                    await this._fakeVisibilityAPI();
                    await this.page.waitForTimeout(3000);
                  } catch (rErr) {
                    this.log(`⚠️ F5 khi retry DOM timer bị lỗi: ${String(rErr.message).split('\n')[0]}`, 'warn');
                  }
                } else {
                  await this.page.waitForTimeout(4000);
                }
              }
            }

            if (!domTimer || (domTimer.totalMinutes === undefined && lessonMinutes === 240)) {
              this.log(`ℹ️ Không đọc được DOM Timer sau ${maxDomRetries} lần thử, sử dụng thời gian mặc định ${this.options.time || 240} phút (sẽ tự động đọc lại ở các chu kỳ F5)`, 'info');
              lessonMinutes = parseInt(this.options.time, 10) || 240;
            }
          }

          if (this._stopped) break;
          if (this._hitSchedulingLimit()) return;

          this._setStatus('studying');
          this.emit('status', this.getStatus());

          let durationMs = lessonMinutes * 60 * 1000;
          let elapsedMs = 0;
          let lessonConfirmedCompleted = lessonMinutes === 0;
          let extensionCount = 0; // Đếm số lần tự động gia hạn bài học này
          let courseFinalizationPlan = null;
          let courseCompletedAtCheckpoint = false;

          const enterCourseFinalization = () => {
            const lessonRemainingMs = Math.max(0, durationMs - elapsedMs);
            courseFinalizationPlan = createCourseFinalizationPlan(
              courseFinalizationPlan,
              lessonRemainingMs,
              elapsedMs
            );
            this._setCourseFinalizationState(cConfig.courseUrl, COURSE_FINALIZATION_STATES.TARGET_REACHED);
            this.log(`⏱️ Checkpoint has not yet confirmed the course target: ${courseStudiedMins}/${targetMinutes} local minutes`, 'warn');
            this.log('⏱️ Entering course finalization mode', 'warn');

            if (lessonRemainingMs <= 0) {
              this.log('✅ Course target was reached exactly as the current lesson ended', 'success');
            } else if (courseFinalizationPlan.mode === 'finish-current-lesson') {
              this.log('📖 Current lesson is still active', 'info');
              this.log('⏳ Current lesson is nearly complete — allowing it to finish', 'info');
            } else {
              this.log('📖 Current lesson is still active', 'info');
              this.log(`⏱️ Current lesson has ${Math.ceil(lessonRemainingMs / 60000)} minutes remaining`, 'info');
              this.log('🛑 Applying maximum 5-minute post-target grace period', 'warn');
            }
          };

          const verifyCurrentCheckpoint = async (refreshPage) => {
            const verifyArgs = {
              courseUrl: cConfig.courseUrl,
              targetMinutes,
              courseTitle: scanResult.courseTitle,
              courseRunId,
              preserveCurrentPage: true,
              continueStudying: true,
            };
            if (!refreshPage) {
              this._setCourseFinalizationState(cConfig.courseUrl, COURSE_FINALIZATION_STATES.CHECKPOINT);
            }
            const result = refreshPage
              ? await this._checkpointAndVerifyCourse(verifyArgs)
              : await this._verifyCourseProgressAfterCheckpoint(verifyArgs);
            if (result.confirmed) {
              courseCompletedAtCheckpoint = true;
              courseFinalizedThisRun = true;
            }
            return result;
          };

          while (elapsedMs < durationMs && !this._stopped) {
            await this._checkPaused();

            // Hết khung giờ học → F5 lưu checkpoint rồi tạm nghỉ (server tự hẹn giờ chạy lại)
            if (this._msRemainingInWindow() === -2) {
              if (courseFinalizationPlan) {
                this.log('⏰ Study window ended during course finalization — stopping the lesson for checkpoint', 'warn');
                break;
              }
              this.log('⏰ Hết giờ khung học — F5 lưu checkpoint và tạm nghỉ...', 'warn');
              try {
                await this.page.reload({ waitUntil: 'load', timeout: 60000 });
                await verifyCurrentCheckpoint(false);
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

            // Stop exactly at the course target first. Only after that transition may the
            // one-shot finalization allowance be consumed.
            if (!courseFinalizationPlan && targetMinutes > 0) {
              const courseTargetRemainingMs = getCourseTargetRemainingMs(
                targetMinutes,
                courseBaseStudiedMs + courseSessionStudiedMs
              );
              if (courseTargetRemainingMs <= 0) {
                this.log('🔄 Local course timer reached its target — checkpointing before any additional study', 'info');
                const checkpointResult = await verifyCurrentCheckpoint(true);
                if (checkpointResult.stale || checkpointResult.confirmed) break;
                enterCourseFinalization();
                if (courseFinalizationPlan.allowanceMs > 0) continue;
                break;
              }
              waitStep = Math.min(waitStep, courseTargetRemainingMs);
            } else if (courseFinalizationPlan) {
              const finalizationRemainingMs = Math.max(0, courseFinalizationPlan.deadlineElapsedMs - elapsedMs);
              if (finalizationRemainingMs <= 0) {
                if (courseFinalizationPlan.mode === 'grace-period') {
                  this.log('🛑 5-minute post-target grace period reached', 'warn');
                  this.log('⏹️ Stopping current lesson', 'warn');
                }
                break;
              }
              waitStep = Math.min(waitStep, finalizationRemainingMs);
            }

            // Không học vượt ngân sách phút còn lại trong ngày.
            const dailyRemainingMs = Math.max(0, this.options.dailyMaxMinutes - this.dailyStudiedMinutes) * 60000;
            waitStep = Math.min(waitStep, dailyRemainingMs);
            if (waitStep <= 0) {
              if (courseFinalizationPlan) {
                this.log('🛑 Daily study limit reached during course finalization — stopping for checkpoint', 'warn');
                break;
              }
              this._hitDailyLimit();
              return;
            }

            // Không chờ vượt quá thời điểm kết thúc Ca học hiện tại
            const shiftCheck = this._checkCustomShifts();
            if (shiftCheck.currentShift && shiftCheck.remainingMs < waitStep) {
              waitStep = Math.min(waitStep, Math.max(5000, shiftCheck.remainingMs));
            }

            // Không chờ vượt quá thời điểm kết thúc khung giờ hiện tại
            const windowRemainingMs = this._msRemainingInWindow();
            if (windowRemainingMs >= 0) {
              waitStep = Math.min(waitStep, Math.max(5000, windowRemainingMs));
            }

            const activeWaitMs = await this._waitForActiveStudyTime(waitStep);
            if (this._stopped) break;

            elapsedMs += activeWaitMs;
            courseSessionStudiedMs += activeWaitMs;

            this._rolloverDailyCounter();
            const addMins = Math.round(activeWaitMs / 60000);
            this.dailyStudiedMinutes += addMins;
            courseStudiedMins = Math.floor((courseBaseStudiedMs + courseSessionStudiedMs) / 60000);
            this.courseProgress[cConfig.courseUrl].studiedMinutes = courseStudiedMins;

            const remainingDailyMins = Math.max(0, this.options.dailyMaxMinutes - this.dailyStudiedMinutes);
            this.log(`📊 Đang treo bài [${lesson.title}]: Đã treo ${Math.round(elapsedMs / 60000)}/${lessonMinutes} phút | Hôm nay: ${this._formatMinutes(this.dailyStudiedMinutes)} / ${this._formatMinutes(this.options.dailyMaxMinutes)} (Còn lại: ${this._formatMinutes(remainingDailyMins)})`, 'info');
            this.emit('status', this.getStatus());

            if (!courseFinalizationPlan
              && targetMinutes > 0
              && courseBaseStudiedMs + courseSessionStudiedMs >= targetMinutes * 60 * 1000) {
              this.log('🔄 Local course timer reached its target — checkpointing before any additional study', 'info');
              const checkpointResult = await verifyCurrentCheckpoint(true);
              if (checkpointResult.stale || checkpointResult.confirmed) break;
              enterCourseFinalization();
              if (elapsedMs < durationMs && courseFinalizationPlan.allowanceMs > 0) {
                continue;
              }
            }

            if (courseFinalizationPlan
              && courseFinalizationPlan.mode === 'grace-period'
              && elapsedMs >= courseFinalizationPlan.deadlineElapsedMs
              && elapsedMs < durationMs) {
              this.log('🛑 5-minute post-target grace period reached', 'warn');
              this.log('⏹️ Stopping current lesson', 'warn');
              break;
            }

            if (activeWaitMs < waitStep && !this._allConfiguredCoursesCompleted() && this._hitSchedulingLimit()) {
              if (courseFinalizationPlan) break;
              try {
                await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                await verifyCurrentCheckpoint(false);
              } catch { /* ignore */ }
              return;
            }

            // Ghi nhận phần vừa học trước, sau đó mới hẹn tiếp ca/ngày kế tiếp.
            if (!this._allConfiguredCoursesCompleted() && this._hitSchedulingLimit()) {
              if (courseFinalizationPlan) break;
              try {
                await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                await verifyCurrentCheckpoint(false);
              } catch { /* ignore */ }
              return;
            }

            if (elapsedMs < durationMs && !this._stopped) {
              let reloadOk = false;
              try {
                await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                await this._fakeVisibilityAPI();
                await this.page.waitForTimeout(7000); // Chờ 7s cho Odoo JS render & chốt checkpoint lên server
                reloadOk = true;
              } catch (err) {
                if (!this._isNetworkError(err)) throw err;
                this.log(`⚠️ F5 lỗi mạng: ${String(err.message).split('\n')[0]} → Đang chờ hệ thống cho phép vào lại...`, 'warn');
                reloadOk = await this._waitUntilOnUrl(lesson.url);
              }

              if (!this._stopped && !this._isOnUrl(lesson.url)) {
                this.log(`⚠️ F5 bị redirect: ${this.page.url()} → Đang chờ hệ thống cho phép vào lại...`, 'warn');
                const reentered = await this._waitUntilOnUrl(lesson.url);
                if (reentered) this.log(`✅ Đã vào lại bài học sau khi F5 bị redirect`, 'success');
              }

              if (!this._stopped) {
                const checkpointResult = await verifyCurrentCheckpoint(false);
                if (checkpointResult.stale || checkpointResult.confirmed) break;
              }

              // Heartbeat Check: Đọc lại bộ đếm web sau F5 nếu tìm thấy thời gian đếm ngược hợp lệ (>0 phút)
              if (!this._stopped && this._isOnUrl(lesson.url)) {
                const checkTimer = await readDomTimer(this.page);
                if (checkTimer) {
                  if (checkTimer.totalMinutes > 0 && !isNaN(checkTimer.totalMinutes)) {
                    const remainingWebMs = checkTimer.totalMinutes * 60 * 1000;
                    if (lessonMinutes === 240 || Math.abs(durationMs - (elapsedMs + remainingWebMs)) > 60000) {
                      lessonMinutes = Math.round((elapsedMs + remainingWebMs) / 60000);
                      durationMs = elapsedMs + remainingWebMs;
                      this.log(`⏱️ Thời gian đếm ngược trên web cập nhật còn lại: ${checkTimer.hours}h ${checkTimer.minutes}m (${checkTimer.totalMinutes} phút)`, 'info');
                    }
                  } else if (checkTimer.hours === 0 && checkTimer.minutes === 0 && checkTimer.seconds === 0) {
                    let completedOnSlide = await this._isCurrentLessonCompleted();
                    if (!completedOnSlide) {
                      const courseVerification = await this._verifyLessonProgressFromCourse(cConfig.courseUrl, lesson.url);
                      if (courseVerification.completed) completedOnSlide = true;
                    }
                    if (completedOnSlide) {
                      lessonConfirmedCompleted = true;
                      durationMs = elapsedMs;
                      this.log(`✅ Web Odoo xác nhận bài đã hoàn thành sau heartbeat`, 'success');
                    } else {
                      this.log(`⚠️ Timer heartbeat trả về 0:00 nhưng bài chưa được Web Odoo xác nhận — giữ nguyên thời lượng ${lessonMinutes} phút, không kết thúc sớm.`, 'warn');
                    }
                  }
                }
              }
            }

            // Kiểm tra xác minh lượt cuối khi elapsedMs chuẩn bị chạm hoặc đã bằng durationMs
            if (elapsedMs >= durationMs && !this._stopped) {
              this.log(`🔍 Đang xác minh lại trạng thái bài học trên Web Odoo...`, 'info');
              
              if (this._isOnUrl(lesson.url)) {
                try {
                  await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                  await this._fakeVisibilityAPI();
                  await this.page.waitForTimeout(5000);
                } catch {
                  await this._waitUntilOnUrl(lesson.url);
                }

                if (!this._stopped) {
                  const checkpointResult = await verifyCurrentCheckpoint(false);
                  if (checkpointResult.stale || checkpointResult.confirmed) break;
                }

                if (this._isOnUrl(lesson.url)) {
                  // 1. Kiểm tra badge hoàn thành trên slide player
                  let isCompleted = await this._isCurrentLessonCompleted();
                  let courseVerification = { completed: false, progressPercent: null };

                  // 2. ƯU TIÊN HÀNG ĐẦU: Nếu slide player chưa hiện badge, ALWAYS xác minh chéo từ trang khóa học
                  if (!isCompleted) {
                    courseVerification = await this._verifyLessonProgressFromCourse(cConfig.courseUrl, lesson.url);
                    if (courseVerification.completed) {
                      isCompleted = true;
                      this.log(`✅ Trang khóa học xác nhận bài [${lesson.title}] đã đạt 100%`, 'success');
                    } else if (courseVerification.progressPercent != null) {
                      this.log(`ℹ️ Trang khóa học báo tiến độ bài [${lesson.title}]: ${courseVerification.progressPercent}%`, 'info');
                    }
                  } else {
                    this.log(`✅ Web Odoo xác nhận bài [${lesson.title}] đã có badge hoàn thành trên slide player`, 'success');
                  }

                  if (isCompleted) {
                    lessonConfirmedCompleted = true;
                  } else if (courseFinalizationPlan) {
                    this.log(`ℹ️ Course finalization is active — lesson [${lesson.title}] will not be extended`, 'info');
                  } else {
                    // 3. Nếu CẢ HAI nguồn (slide player & trang khóa học) đều báo BÀI CHƯA ĐẠT 100%:
                    // Tiến hành kiểm tra timer hoặc gia hạn, nhưng CÓ GIỚI HẠN (max 3 lần gia hạn) để chống kẹt vô hạn.
                    extensionCount++;
                    const maxAllowedExtensions = 3;

                    if (extensionCount > maxAllowedExtensions) {
                      this.log(`⚠️ Bài học [${lesson.title}] đã gia hạn ${extensionCount - 1} lần (đã treo ${Math.round(elapsedMs / 60000)} phút) nhưng Web Odoo chưa chuyển 100% ➔ Tự động hoàn tất bài để tránh kẹt vô hạn!`, 'warn');
                      lessonConfirmedCompleted = true;
                    } else {
                      const finalTimer = await readDomTimer(this.page);
                      if (finalTimer && finalTimer.totalMinutes > 0 && !isNaN(finalTimer.totalMinutes)) {
                        // Odoo cần ít nhất 5 phút học liên tục để chốt checkpoint lên database.
                        // Nếu Web Odoo báo còn < 5 phút (ví dụ 3 phút), vẫn phải treo đủ ít nhất 5 phút rồi F5 mới chốt được.
                        const extMinutes = Math.max(5, finalTimer.totalMinutes);
                        this.log(`⚠️ Đồng hồ local đã đếm hết nhưng Web Odoo chưa đạt 100% (còn ${finalTimer.hours}h ${finalTimer.minutes}m ${finalTimer.seconds}s) ➔ Gia hạn treo ${extMinutes} phút (tối thiểu 5p để Odoo lưu checkpoint) lần ${extensionCount}/${maxAllowedExtensions}!`, 'warn');
                        durationMs = elapsedMs + extMinutes * 60 * 1000;
                        lessonMinutes = Math.ceil(durationMs / 60000);
                      } else {
                        const retryMinutes = Math.max(5, parseInt(this.options.refreshInterval, 10) || 15);
                        durationMs = elapsedMs + retryMinutes * 60 * 1000;
                        lessonMinutes = Math.ceil(durationMs / 60000);
                        const progressText = courseVerification.progressPercent == null
                          ? 'chưa đọc được tiến độ'
                          : `mới ${courseVerification.progressPercent}%`;
                        this.log(`⚠️ Timer đã về 0:00 nhưng trang khóa học ${progressText} ➔ Gia hạn lần ${extensionCount}/${maxAllowedExtensions} thêm ${retryMinutes} phút và tiếp tục treo.`, 'warn');
                      }
                    }
                  }
                }
              }
            }
          }

          if (!this._stopped && courseCompletedAtCheckpoint) {
            if (cIdx + 1 < this.coursesConfig.length) this.log('➡️ Switching to next course', 'success');
            break;
          }

          if (!this._stopped && this.status !== 'paused' && lessonConfirmedCompleted) {
            this.log(`✅ Hoàn thành treo bài [${lesson.title}] (${lessonMinutes} phút)!`, 'success');
            this.emit('progress-saved', {
              account: this.account.name,
              courseTitle: scanResult.courseTitle,
              lessonTitle: lesson.title,
              studiedMinutes: lessonMinutes,
              courseRemainingMinutes: Math.max(0, targetMinutes - courseStudiedMins),
            });
          } else if (!this._stopped && this.status !== 'paused') {
            this.log(`⚠️ Bài [${lesson.title}] chưa được Web Odoo xác nhận hoàn thành — không ghi nhận là đã xong.`, 'warn');
          }

          if (!this._stopped && courseFinalizationPlan) {
            if (courseFinalizationPlan.mode === 'finish-current-lesson' && lessonConfirmedCompleted) {
              this.log('✅ Current lesson finished during course finalization', 'success');
            }
            await this._checkpointAndVerifyCourse({
              courseUrl: cConfig.courseUrl,
              targetMinutes,
              courseTitle: scanResult.courseTitle,
              courseRunId,
            });
            courseFinalizedThisRun = true;
            if (cIdx + 1 < this.coursesConfig.length) this.log('➡️ Switching to next course', 'success');
            break;
          }
        }

        if (!courseFinalizedThisRun && targetMinutes === 0 && courseReachedTarget(targetMinutes, courseStudiedMins, true)) {
          this.courseProgress[cConfig.courseUrl].completed = true;
        }
      }

      if (this._stopped) {
        this.status = 'stopped';
        this.emit('status', this.getStatus());
      } else if (SCHEDULED_STATUSES.has(this.status) || this.status === 'paused') {
        // Giữ nguyên trạng thái giới hạn / tạm dừng — không ghi đè thành completed!
        this.emit('status', this.getStatus());
      } else {
        const incompleteCourses = this.coursesConfig.filter(c => !this.courseProgress[c.courseUrl]?.completed);
        if (incompleteCourses.length > 0) {
          // Bắt lại đúng loại lịch hẹn nếu ca/khung/ngân sách ngày vừa kết thúc
          // trong lúc xử lý bài cuối cùng của lượt quét.
          if (this._hitSchedulingLimit()) return;
          this._setStatus('next-day');
          this.log(`⏭️ Đã quét hết lượt hôm nay nhưng còn ${incompleteCourses.length}/${this.coursesConfig.length} khóa chưa đạt mục tiêu thời gian → Hẹn ${this.options.newDayStartTime || '06:00'} ngày học tiếp theo quét và treo tiếp!`, 'warn');
        } else {
          this._setStatus('completed');
          this.log(`🎉 Tất cả các khóa học đã đạt mục tiêu và treo xong!`, 'success');
        }
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

  // Người dùng bấm Dừng trên Dashboard: hủy hẳn phiên.
  // Đây là chuyển trạng thái kết thúc DUY NHẤT do người dùng chủ động — sau khi
  // gọi, phiên ở 'stopped' + giai đoạn finished nên mọi emit muộn của vòng lặp
  // start() (đang chạy dở) sẽ bị _setStatus() từ chối, không thể "sống lại".
  async cancel() {
    await this.stop();
    this.status = 'stopped';
    this.pausedFromStatus = null;
    return this;
  }

  async stop() {
    // Dù chỉ được dọn dẹp một lần, giai đoạn vẫn phải chốt lại: một phiên đã gọi
    // stop() (do người dùng bấm Dừng hoặc do khối finally của start()) là phiên
    // đã chết — không bao giờ được start() lại.
    this._phase = PHASE_FINISHED;
    if (this._stopped) return;
    this._stopped = true;
    this._activeCourseRunId = null;
    this._courseRunGeneration++;
    this._clearStealthLoop();
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
    }
  }
}

module.exports = {
  AutoCourseSession,
  courseReachedTarget,
  createCourseFinalizationPlan,
  getCourseTargetRemainingMs,
  POST_TARGET_GRACE_MINUTES,
  COURSE_FINALIZATION_STATES,
  isAutoCourseAccountBlockingStatus,
  getPersistentAutoCourseOptions,
  AUTO_COURSE_STATUSES,
  TERMINAL_STATUSES,
  SCHEDULED_STATUSES,
  PHASE_NEW,
  PHASE_RUNNING,
  PHASE_FINISHED,
};
