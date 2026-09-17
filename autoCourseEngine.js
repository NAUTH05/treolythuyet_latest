const { chromium } = require('playwright');
const EventEmitter = require('events');
const { isAllowedStudyDate, getNextAllowedStudyDate, scanCourseDetails, scanMyCoursesCompletion, readDomTimer, getShiftsForDate, calcMsRemainingInShift, getNextShiftStart } = require('./courseScanner');

const BASE_URL = 'https://hoclythuyetlaixe.eco-tek.com.vn';
const LOGIN_URL = `${BASE_URL}/web/login`;
const MY_COURSES_URL = `${BASE_URL}/slides/all?my=1`;
const SESSION_LOG_SEPARATOR = '---------------------------------------------------------';
const POST_TARGET_GRACE_MINUTES = 5;
const LOGIN_NAVIGATION_TIMEOUT_MS = 60000;
const LOGIN_FORM_TIMEOUT_MS = 15000;
const LOGIN_POST_SUBMIT_TIMEOUT_MS = 60000;
const LOGIN_POST_SUBMIT_GRACE_MS = 5000;
const LOGIN_RETRY_BASE_MS = 15000;
const LOGIN_RETRY_MAX_MS = 5 * 60 * 1000;
const MAX_CONCURRENT_LOGINS = 3;

// ── SURPLUS (học thừa) ──
// Mỗi khóa được cấp MỘT mục tiêu RNG riêng trong khoảng 15-60 phút. Khóa được
// xử lý TUẦN TỰ theo đúng thứ tự coursesConfig, không chọn ngẫu nhiên.
const SURPLUS_TARGET_MIN_MINUTES = 15;
const SURPLUS_TARGET_MAX_MINUTES = 60;
const SURPLUS_MIN_BLOCK_MINUTES = 5;
// Số lần tối đa một bài được thử mà website KHÔNG xác nhận trước khi bị đánh dấu
// không dùng được (chống lặp vô hạn).
const SURPLUS_MAX_UNCONFIRMED_ATTEMPTS = 2;

class LoginLimiter {
  constructor(max = MAX_CONCURRENT_LOGINS, { logger = () => {} } = {}) {
    this.max = Math.max(1, Number(max) || MAX_CONCURRENT_LOGINS);
    this.active = 0;
    this.queue = [];
    this.logger = logger;
  }

  acquire(owner = null) {
    if (owner && owner._stopped) return Promise.resolve(false);
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(true);
    }
    return new Promise(resolve => {
      this.queue.push({ owner, resolve });
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    while (this.queue.length > 0 && this.active < this.max) {
      const next = this.queue.shift();
      if (next.owner && next.owner._stopped) {
        next.resolve(false);
        continue;
      }
      this.active++;
      next.resolve(true);
    }
  }

  cancel(owner) {
    if (!owner) return;
    const keep = [];
    for (const item of this.queue) {
      if (item.owner === owner) item.resolve(false);
      else keep.push(item);
    }
    this.queue = keep;
  }

  get pending() { return this.queue.length; }
}

const globalLoginLimiter = new LoginLimiter();

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
  'surplus-study', 'date-limit', 'daily-limit', 'time-window', 'next-day',
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
    randomStartEnabled: options.randomStartEnabled === true,
    randomStartFrom: options.randomStartFrom || options.newDayStartTime || '06:00',
    randomStartTo: options.randomStartTo || options.newDayStartTime || '06:00',
    scheduledStartAt: options.scheduledStartAt || null,
    scheduledStartDate: options.scheduledStartDate || null,
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
      randomStartEnabled: false,
      randomStartFrom: '06:00',
      randomStartTo: '06:00',
      scheduledStartAt: null,
      scheduledStartDate: null,
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

    this.courseProgress = {}; // courseUrl -> { studiedMinutes, targetMinutes, completed, websiteCourseCompleted }
    this.surplusMode = Boolean(options.surplusMode);
    // Trạng thái surplus theo TỪNG KHÓA (nguồn chân lý mới). Xem _surplusStateFor().
    this.surplusCourseStates = AutoCourseSession._normalizeSurplusCourseStates(options.surplusCourseStates);
    this.surplusCurrentCourseIndex = Number.isInteger(options.surplusCurrentCourseIndex) && options.surplusCurrentCourseIndex >= 0
      ? options.surplusCurrentCourseIndex
      : 0;
    // Trường legacy (account-level) — chỉ giữ để tương thích Firestore cũ/hiển thị.
    this.surplusTargetMinutes = Number.isFinite(Number(options.surplusTargetMinutes))
      ? Math.max(SURPLUS_TARGET_MIN_MINUTES, Math.min(SURPLUS_TARGET_MAX_MINUTES, Number(options.surplusTargetMinutes)))
      : null;
    this.surplusStudiedMinutes = Math.max(0, Number(options.surplusStudiedMinutes) || 0);
    this.surplusEligibleCourses = Array.isArray(options.surplusEligibleCourses)
      ? [...new Set(options.surplusEligibleCourses)]
      : [];
    this.surplusExhausted = options.surplusExhausted === true;
    this._surplusLegacyMigrated = false;
    this._stopped = false;
    this._phase = PHASE_NEW;
    this._stealthTimer = null;
    this._pauseStartedAt = null;
    this._totalPausedMs = 0;
    this._sessionSeparatorLogged = false;
    this._courseRunGeneration = 0;
    this._activeCourseRunId = null;
    this.loginLimiter = this.options.loginLimiter || globalLoginLimiter;
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

  // Chốt "được phép tiếp tục" cho MỌI điểm nối async. Một callback đến muộn chỉ
  // được phép chạm state/khoá học nếu:
  //   - phiên chưa bị chốt kết thúc (_phase !== finished)
  //   - chưa bị người dùng/hệ thống dừng (_stopped)
  //   - CHƯA rơi vào bất kỳ trạng thái hẹn giờ nào (daily-limit / date-limit /
  //     time-window / next-day) — đây là bất biến của ff02e8c
  //   - không ở trạng thái kết thúc (completed / stopped / error)
  //   - đúng thế hệ khoá học/run đang chạy (chống callback của run cũ)
  // `courseRunId === undefined` dùng cho các tác vụ không gắn với một khóa cụ thể.
  _isRunActive(courseRunId = undefined) {
    if (this._phase !== PHASE_RUNNING) return false;
    if (this._stopped) return false;
    if (SCHEDULED_STATUSES.has(this.status)) return false;
    if (TERMINAL_STATUSES.has(this.status)) return false;
    if (courseRunId !== undefined && courseRunId !== null && this._activeCourseRunId !== courseRunId) {
      return false;
    }
    return true;
  }

  // Chuyển phiên sang trạng thái hẹn giờ một cách NGUYÊN TỬ: đặt status, chốt vòng
  // đời finished, vô hiệu thế hệ run hiện tại. Từ thời điểm này mọi callback async
  // còn treo sẽ bị _isRunActive() từ chối → không thể ghi đè status hay học tiếp.
  _enterScheduledStatus(status) {
    if (!SCHEDULED_STATUSES.has(status)) return false;
    if (!this._setStatus(status)) return false;
    this._activeCourseRunId = null;
    this._courseRunGeneration += 1;
    this._finishPhase();
    return true;
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

  // Phát hiện (thuần, không side effect) — ngoài khung giờ học tổng quát?
  _isOutsideTimeWindow() {
    if ((this.options.timeWindows || []).length === 0) return false;
    return this._msRemainingInWindow() === -2;
  }

  // Nếu ngoài khung giờ học → chuyển trạng thái 'time-window' để server hẹn giờ chạy lại.
  // Trả về true nếu đã kích hoạt time-window (caller phải return/thoát).
  _hitTimeWindowLimit() {
    if (!this._isOutsideTimeWindow()) return false;
    this._enterScheduledStatus('time-window');
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
    this._enterScheduledStatus('daily-limit');
    this.log(`🛑 Đã đạt giới hạn học tối đa trong ngày (${this._formatMinutes(this.options.dailyMaxMinutes)}) → Hẹn ${this.options.newDayStartTime || '06:00'} sáng ngày học tiếp theo tiếp tục!`, 'warn');
    this.emit('status', this.getStatus());
    return true;
  }

  _hitSchedulingLimit() {
    return this._hitDailyLimit() || this._hitTimeShiftLimit() || this._hitTimeWindowLimit();
  }

  // Xem trước giới hạn lịch mà KHÔNG đổi trạng thái. Dùng để caller kịp lưu tiến
  // độ (F5 để Odoo chốt checkpoint) TRƯỚC khi phiên chốt sang trạng thái hẹn giờ.
  _peekSchedulingLimit() {
    this._rolloverDailyCounter();
    if (this.dailyStudiedMinutes >= this.options.dailyMaxMinutes) return 'daily-limit';
    if (this._isOutsideTimeShift()) return 'date-limit';
    if (this._isOutsideTimeWindow()) return 'time-window';
    return null;
  }

  _allConfiguredCoursesCompleted() {
    return this.coursesConfig.length > 0
      && this.coursesConfig.every(course => this.courseProgress[course.courseUrl]?.completed === true);
  }

  _allConfiguredCoursesWebsiteCompleted() {
    return this.coursesConfig.length > 0
      && this.coursesConfig.every(course => this.courseProgress[course.courseUrl]?.websiteCourseCompleted === true);
  }

  static _targetMinutesFor(config) {
    return (Number(config.targetHours) || 0) * 60 + (Number(config.targetMinutes) || 0);
  }

  static _courseCompletionStateOf(scan) {
    if (!scan) return 'unknown';
    if (scan.courseCompletionState === 'completed'
      || scan.courseCompletionState === 'incomplete'
      || scan.courseCompletionState === 'unknown') {
      return scan.courseCompletionState;
    }
    // Tương thích kết quả scan cũ (chỉ có courseLevelCompleted boolean).
    return scan.courseLevelCompleted === true ? 'completed' : 'unknown';
  }

  static _normalizedTitle(value) {
    return String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd').replace(/Đ/g, 'D')
      .replace(/[^a-z0-9]+/gi, ' ')
      .trim()
      .toLowerCase();
  }

  // Chuẩn hoá surplusCourseStates từ Firestore (object) — chịu được document cũ
  // thiếu trường/định dạng lạ, không bao giờ ném lỗi.
  static _normalizeSurplusCourseStates(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const normalized = {};
    for (const [courseUrl, state] of Object.entries(raw)) {
      if (!courseUrl || !state || typeof state !== 'object') continue;
      // LƯU Ý: Number(null) === 0 → phải phân biệt null/rỗng với 0, nếu không mục
      // tiêu chưa sinh sẽ bị kẹp thành 15 mỗi lần normalize.
      const rawTarget = state.targetMinutes;
      const target = (rawTarget == null || rawTarget === '') ? NaN : Number(rawTarget);
      normalized[courseUrl] = {
        courseUrl,
        title: state.title || null,
        targetMinutes: Number.isFinite(target) && target > 0
          ? Math.max(SURPLUS_TARGET_MIN_MINUTES, Math.min(SURPLUS_TARGET_MAX_MINUTES, target))
          : null,
        confirmedMinutes: Math.max(0, Number(state.confirmedMinutes) || 0),
        localActiveMinutes: Math.max(0, Number(state.localActiveMinutes) || 0),
        verifiedMinutes: state.verifiedMinutes == null ? null : Math.max(0, Number(state.verifiedMinutes) || 0),
        completed: state.completed === true,
        exhausted: state.exhausted === true,
        unusableLessons: Array.isArray(state.unusableLessons) ? [...new Set(state.unusableLessons.filter(Boolean))] : [],
        studiedLessons: Array.isArray(state.studiedLessons) ? [...new Set(state.studiedLessons.filter(Boolean))] : [],
        lessonAttempts: (state.lessonAttempts && typeof state.lessonAttempts === 'object' && !Array.isArray(state.lessonAttempts))
          ? { ...state.lessonAttempts }
          : {},
      };
    }
    return normalized;
  }

  _titlesLikelyMatch(a, b) {
    const left = AutoCourseSession._normalizedTitle(a);
    const right = AutoCourseSession._normalizedTitle(b);
    if (!left || !right) return false;
    return left === right || left.includes(right) || right.includes(left);
  }

  // Quét + đánh giá MỘT khóa: gate thời gian (authoritative) + trạng thái cấp khóa.
  async _evaluateConfiguredCourse(config) {
    const targetMinutes = AutoCourseSession._targetMinutesFor(config);
    const inactive = () => {
      const existing = this.courseProgress[config.courseUrl] || {};
      return {
        courseUrl: config.courseUrl,
        title: existing.title || config.courseUrl,
        targetMinutes,
        actualStudiedMinutes: Math.max(0, Number(existing.studiedMinutes) || 0),
        state: 'unknown',
        percent: existing.websiteCourseProgressPercent ?? null,
        source: null,
        evidence: null,
        targetReached: false,
        scanFailed: true,
        stale: true,
        allLessons: [],
      };
    };

    if (!this._isRunActive()) return inactive();
    let result = null;
    try {
      result = await this._scanCourseDetailsForCheckpoint(config.courseUrl, true);
    } catch (err) {
      this.log(`⚠️ Không thể xác minh trạng thái cấp khóa [${config.courseUrl}]: ${String(err.message).split('\n')[0]}`, 'warn');
    }
    // I/O vừa xong có thể đã bị vượt qua bởi trạng thái hẹn giờ / dừng / đổi run
    // → KHÔNG được ghi courseProgress hay tiếp tục xác minh.
    if (!this._isRunActive()) return inactive();

    const existing = this.courseProgress[config.courseUrl] || {};
    if (!result) {
      return {
        courseUrl: config.courseUrl,
        title: existing.title || config.courseUrl,
        targetMinutes,
        actualStudiedMinutes: Math.max(0, Number(existing.studiedMinutes) || 0),
        state: 'unknown',
        percent: existing.websiteCourseProgressPercent ?? null,
        source: null,
        evidence: null,
        targetReached: false,
        scanFailed: true,
        allLessons: [],
      };
    }

    const actualStudiedMinutes = Math.max(0, Number(result.actualStudiedMinutes) || 0);
    const state = AutoCourseSession._courseCompletionStateOf(result);
    const percent = Number.isFinite(result.courseProgressPercent) ? result.courseProgressPercent : null;
    const targetReached = targetMinutes > 0 ? actualStudiedMinutes >= targetMinutes : true;

    this.courseProgress[config.courseUrl] = {
      ...existing,
      title: result.courseTitle || existing.title || config.courseUrl,
      targetMinutes,
      // Không để một lần parse lỗi (0 phút) xoá tiến độ đang hiển thị.
      studiedMinutes: actualStudiedMinutes > 0 ? actualStudiedMinutes : (existing.studiedMinutes ?? actualStudiedMinutes),
      websiteCourseCompleted: state === 'completed',
      websiteCourseCompletionState: state,
      websiteCourseProgressPercent: percent ?? existing.websiteCourseProgressPercent ?? null,
    };

    return {
      courseUrl: config.courseUrl,
      title: result.courseTitle || existing.title || config.courseUrl,
      targetMinutes,
      actualStudiedMinutes,
      state,
      percent,
      source: result.courseCompletionSource || result.courseCompletionEvidence?.resolutionSource || null,
      evidence: result.courseCompletionEvidence || null,
      targetReached,
      scanFailed: false,
      allLessons: Array.isArray(result.allLessons) ? result.allLessons : [],
    };
  }

  _logCourseVerificationFailure(evaluation, reason) {
    const label = reason === 'target-not-reached'
      ? '⚠️ Course time target not reached'
      : '⚠️ Course-level verification failed';
    this.log(label, 'warn');
    this.log(`   Course: ${evaluation.title}`, 'warn');
    this.log(`   Configured target: ${evaluation.targetMinutes} minutes`, 'warn');
    this.log(`   Actual studied: ${evaluation.actualStudiedMinutes} minutes`, 'warn');
    this.log(`   Course progress detected: ${evaluation.percent == null ? 'null' : `${evaluation.percent}%`}`, 'warn');
    this.log(`   Completion source: ${evaluation.source || 'none'}`, 'warn');
    this.log(`   Course-level completed: ${evaluation.state === 'completed'}`, 'warn');
  }

  // Một lần xác minh tươi bằng trang "My Courses" cho các khóa còn UNKNOWN.
  // Không đổi `incomplete` -> `completed`; chỉ nâng cấp khi có badge xác nhận.
  async _resolveUnknownCoursesViaMyCourses(unknownEvaluations) {
    if (!this.context || unknownEvaluations.length === 0) return;
    let verifyPage = null;
    try {
      verifyPage = await this.context.newPage();
      const myCourses = await scanMyCoursesCompletion(verifyPage, MY_COURSES_URL);
      if (!Array.isArray(myCourses) || myCourses.length === 0) return;

      for (const evaluation of unknownEvaluations) {
        const match = myCourses.find(course => this._titlesLikelyMatch(course.title, evaluation.title));
        if (!match) continue;
        if (match.completed) {
          evaluation.state = 'completed';
          evaluation.percent = 100;
          evaluation.source = match.source || 'my_courses_completed_badge';
          this.courseProgress[evaluation.courseUrl] = {
            ...(this.courseProgress[evaluation.courseUrl] || {}),
            websiteCourseCompleted: true,
            websiteCourseCompletionState: 'completed',
            websiteCourseProgressPercent: 100,
          };
        } else if (match.state === 'incomplete') {
          evaluation.state = 'incomplete';
          evaluation.source = match.source || 'my_courses_incomplete';
        }
      }
    } catch (err) {
      this.log(`⚠️ Không thể xác minh trang My Courses: ${String(err.message).split('\n')[0]}`, 'warn');
    } finally {
      if (verifyPage) {
        try { await verifyPage.close(); } catch { /* ignore */ }
      }
    }
  }

  // Cổng surplus: BẮT BUỘC mọi target thời gian đã đạt, rồi mới dùng bằng chứng
  // cấp khóa. `unknown` KHÔNG bị coi là `incomplete`; chỉ `incomplete` tường minh
  // mới chặn surplus. `unknown` được xác minh tươi một lần, nếu vẫn unknown thì
  // fallback về target thời gian (có cảnh báo) để tránh kẹt vô hạn.
  async _verifyAllConfiguredCoursesCompleted() {
    if (!this.context || this.coursesConfig.length === 0) return false;
    if (!this._isRunActive()) return false;

    const evaluations = [];
    for (const config of this.coursesConfig) {
      if (!this._isRunActive()) return false;
      evaluations.push(await this._evaluateConfiguredCourse(config));
      if (!this._isRunActive()) return false;
    }
    this._lastCourseEvaluations = evaluations;

    this.log('🔎 Verifying website course-level completion...', 'info');

    const failedTargets = evaluations.filter(e => !e.targetReached);
    if (failedTargets.length > 0) {
      for (const e of failedTargets) this._logCourseVerificationFailure(e, 'target-not-reached');
      this.log('⛔ Not all configured study-time targets are reached — surplus deferred', 'warn');
      return false;
    }
    this.log('✅ All configured course time targets reached', 'success');

    if (evaluations.every(e => e.state === 'completed')) {
      this.log(`✅ Website confirms all ${this.coursesConfig.length} configured courses are completed`, 'success');
      return true;
    }

    const explicitIncomplete = evaluations.filter(e => e.state === 'incomplete');
    if (explicitIncomplete.length > 0) {
      for (const e of explicitIncomplete) this._logCourseVerificationFailure(e, 'website-incomplete');
      this.log('❌ Website explicitly reports course incomplete — surplus deferred', 'warn');
      return false;
    }

    const unknown = evaluations.filter(e => e.state === 'unknown');
    for (const e of unknown) {
      this.log(`⚠️ Course-level progress unavailable: ${e.title}`, 'warn');
    }
    this.log('🔄 Performing one fresh course-level verification', 'info');
    await this._resolveUnknownCoursesViaMyCourses(unknown);
    if (!this._isRunActive()) return false;

    const nowIncomplete = unknown.filter(e => e.state === 'incomplete');
    if (nowIncomplete.length > 0) {
      for (const e of nowIncomplete) this._logCourseVerificationFailure(e, 'website-incomplete');
      this.log('❌ Website explicitly reports course incomplete — surplus deferred', 'warn');
      return false;
    }

    const stillUnknown = unknown.filter(e => e.state === 'unknown');
    if (stillUnknown.length === 0) {
      this.log(`✅ Website confirms all ${this.coursesConfig.length} configured courses are completed`, 'success');
      return true;
    }

    for (const e of stillUnknown) {
      this.log(`⚠️ Course-level progress still unavailable: ${e.title}`, 'warn');
    }
    this.log('⚠️ Falling back to verified configured study-time targets', 'warn');
    return true;
  }

  // ── SURPLUS: trạng thái theo TỪNG KHÓA ──

  _surplusStateFor(courseUrl) {
    if (!courseUrl) return null;
    if (!this.surplusCourseStates || typeof this.surplusCourseStates !== 'object') this.surplusCourseStates = {};
    if (!this.surplusCourseStates[courseUrl]) {
      this.surplusCourseStates[courseUrl] = {
        courseUrl,
        title: this.courseProgress[courseUrl]?.title || null,
        targetMinutes: null,
        confirmedMinutes: 0,
        localActiveMinutes: 0,
        verifiedMinutes: null,
        completed: false,
        exhausted: false,
        unusableLessons: [],
        studiedLessons: [],
        lessonAttempts: {},
      };
    }
    return this.surplusCourseStates[courseUrl];
  }

  _markSurplusLessonUnusable(state, lessonUrl) {
    if (state && lessonUrl && !state.unusableLessons.includes(lessonUrl)) {
      state.unusableLessons.push(lessonUrl);
    }
  }

  // Khởi tạo/chuẩn hoá trạng thái surplus per-course. MIGRATE state cũ account-level
  // (surplusTargetMinutes/surplusStudiedMinutes/surplusExhausted) mà không seed
  // confirmedMinutes từ số phút LOCAL chưa được website xác nhận.
  _ensureSurplusCourseStates() {
    this.surplusCourseStates = AutoCourseSession._normalizeSurplusCourseStates(this.surplusCourseStates);
    const hasPerCourse = Object.keys(this.surplusCourseStates).length > 0;
    if (!hasPerCourse && !this._surplusLegacyMigrated
      && (this.surplusTargetMinutes != null || this.surplusStudiedMinutes > 0 || this.surplusExhausted === true)) {
      this._surplusLegacyMigrated = true;
      this.log('♻️ Migrating legacy account-level surplus state to per-course state', 'warn');
      this.log(`   Legacy target: ${this.surplusTargetMinutes ?? 'none'} | legacy studied local (unverified): ${Math.round(this.surplusStudiedMinutes)}m | legacy exhausted: ${this.surplusExhausted === true}`, 'warn');
      this.surplusCurrentCourseIndex = 0;
    }

    for (const config of this.coursesConfig) {
      this._surplusStateFor(config.courseUrl);
    }
    const total = this.coursesConfig.length;
    if (!Number.isInteger(this.surplusCurrentCourseIndex) || this.surplusCurrentCourseIndex < 0) {
      this.surplusCurrentCourseIndex = 0;
    }
    if (this.surplusCurrentCourseIndex > total) this.surplusCurrentCourseIndex = total;
    this._syncLegacySurplusAggregates();
  }

  // Cập nhật trường legacy (tổng hợp) để Dashboard/Firestore cũ vẫn đọc được.
  _syncLegacySurplusAggregates() {
    const states = Object.values(this.surplusCourseStates || {});
    const totalTarget = states.reduce((sum, s) => sum + (s.targetMinutes || 0), 0);
    const totalConfirmed = states.reduce((sum, s) => sum + (s.confirmedMinutes || 0), 0);
    this.surplusTargetMinutes = totalTarget > 0 ? Math.round(totalTarget) : this.surplusTargetMinutes;
    this.surplusStudiedMinutes = totalConfirmed > 0 ? Math.round(totalConfirmed) : this.surplusStudiedMinutes;
    this.surplusEligibleCourses = states.filter(s => !s.exhausted && !s.completed).map(s => s.courseUrl);
    this.surplusExhausted = this.coursesConfig.length > 0
      && this.coursesConfig.every(c => this.surplusCourseStates[c.courseUrl]?.exhausted === true);
  }

  // Mục tiêu RNG 15-60 phút CHO ĐÚNG KHÓA NÀY — sinh một lần, persist, không
  // bao giờ regenerate vì F5/checkpoint/restart/daily-limit/scheduling.
  _surplusTargetFor(state) {
    if (state.targetMinutes == null) {
      state.targetMinutes = this._randomBetween(SURPLUS_TARGET_MIN_MINUTES, SURPLUS_TARGET_MAX_MINUTES);
      this.log(`🎲 Surplus target for this course: ${state.targetMinutes} minutes`, 'info');
    }
    return state.targetMinutes;
  }

  // Còn khóa nào chưa xử lý xong surplus pass không?
  _surplusPassProcessed() {
    if (this.coursesConfig.length === 0) return true;
    if (!this.surplusCourseStates || Object.keys(this.surplusCourseStates).length === 0) return false;
    return this.coursesConfig.every(config => {
      const state = this.surplusCourseStates[config.courseUrl];
      return Boolean(state) && (state.completed === true || state.exhausted === true);
    });
  }

  // Trích bằng chứng website (thời gian khóa + tiến độ bài) từ kết quả scan.
  _extractSurplusEvidence(scan, lessonUrl) {
    if (!scan) return null;
    const lessons = Array.isArray(scan.allLessons) ? scan.allLessons : [];
    let lesson = null;
    if (lessonUrl) {
      try {
        const expectedPath = new URL(lessonUrl).pathname;
        lesson = lessons.find(item => {
          try { return new URL(item.url).pathname === expectedPath; } catch { return false; }
        }) || null;
      } catch { lesson = null; }
    }
    const percent = lesson && Number.isFinite(Number(lesson.progressPercent))
      ? Number(lesson.progressPercent)
      : null;
    return {
      courseMinutes: Math.max(0, Number(scan.actualStudiedMinutes) || 0),
      lessonPercent: percent,
      lessonCompleted: lesson ? (lesson.isCompleted === true || (percent != null && percent >= 100)) : false,
      courseTitle: scan.courseTitle || null,
    };
  }

  async _captureSurplusCourseScan(courseUrl) {
    if (!this.context) return null;
    if (!this._isRunActive()) return null;
    try {
      return await this._scanCourseDetailsForCheckpoint(courseUrl, true);
    } catch (err) {
      this.log(`⚠️ Surplus course scan failed: ${String(err.message).split('\n')[0]}`, 'warn');
      return null;
    }
  }

  async _captureSurplusEvidence(courseUrl, lessonUrl) {
    const scan = await this._captureSurplusCourseScan(courseUrl);
    if (!this._isRunActive()) return null;
    return this._extractSurplusEvidence(scan, lessonUrl);
  }

  // F5 trang bài học để Odoo chốt checkpoint, rồi quét lại bằng chứng website.
  async _checkpointAndCaptureSurplusEvidence(courseUrl, lessonUrl) {
    if (this.page && !this._stopped) {
      try {
        await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await this._fakeVisibilityAPI();
        await this.page.waitForTimeout(7000);
      } catch (err) {
        this.log(`⚠️ Surplus checkpoint refresh failed: ${String(err.message).split('\n')[0]}`, 'warn');
      }
    }
    if (!this._isRunActive()) return null;
    return this._captureSurplusEvidence(courseUrl, lessonUrl);
  }

  // Phân loại một block surplus dựa trên bằng chứng website BEFORE/AFTER. Thời
  // gian local KHÔNG tự động là bằng chứng thành công.
  _classifySurplusProgress(before, after, activeMinutes) {
    if (!before || !after) return { confirmed: false, via: 'none', creditedMinutes: 0 };
    const courseDelta = (after.courseMinutes || 0) - (before.courseMinutes || 0);
    const lessonDelta = (after.lessonPercent != null && before.lessonPercent != null)
      ? after.lessonPercent - before.lessonPercent
      : 0;
    const lessonCompletedNow = after.lessonCompleted === true && before.lessonCompleted !== true;
    // Ưu tiên số phút WEBSITE thực ghi nhận khi có tín hiệu thời gian khóa.
    if (courseDelta > 0) {
      return { confirmed: true, via: 'course_time', creditedMinutes: courseDelta };
    }
    // Tổng thời gian khóa có thể bị "capped" sau khi đạt mục tiêu, nhưng tiến độ
    // bài học vẫn tăng → vẫn là bằng chứng hợp lệ; khi đó credit thời gian local
    // của block (được coi là đã học).
    if (lessonDelta > 0 || lessonCompletedNow) {
      return { confirmed: true, via: 'lesson_progress', creditedMinutes: Math.max(0, Number(activeMinutes) || 0) };
    }
    return { confirmed: false, via: 'none', creditedMinutes: 0 };
  }

  _logSurplusVerification(before, after, verdict) {
    const beforeP = before && before.lessonPercent != null ? `${before.lessonPercent}%` : 'unknown';
    const afterP = after && after.lessonPercent != null ? `${after.lessonPercent}%` : 'unknown';
    const beforeM = before ? before.courseMinutes : '?';
    const afterM = after ? after.courseMinutes : '?';
    this.log('📊 Website surplus verification', 'info');
    this.log(`   Lesson progress: ${beforeP} → ${afterP}`, 'info');
    this.log(`   Course recorded time: ${beforeM} → ${afterM} min`, 'info');
    const confirmed = verdict && verdict.confirmed;
    const suffix = confirmed && verdict.via === 'lesson_progress' ? ' via lesson progress' : '';
    this.log(`   Result: ${confirmed ? `CONFIRMED${suffix}` : 'NOT CONFIRMED'}`, confirmed ? 'success' : 'warn');
  }

  // Các bài CHƯA XONG (<100%) còn học được của một khóa. Trả null nếu không quét
  // được (khác với mảng rỗng = không còn bài).
  _extractUnfinishedLessons(scan, state) {
    if (!scan || !Array.isArray(scan.allLessons)) return null;
    const unusable = new Set(state.unusableLessons || []);
    const studied = new Set(state.studiedLessons || []);
    return scan.allLessons.filter(lesson => lesson && lesson.url
      && !unusable.has(lesson.url)
      && !studied.has(lesson.url)
      && Number.isFinite(Number(lesson.progressPercent))
      && Number(lesson.progressPercent) < 100);
  }

  _logSurplusSummary() {
    const total = this.coursesConfig.length;
    this.log('📊 Surplus summary', 'info');
    this.coursesConfig.forEach((config, idx) => {
      const state = this.surplusCourseStates[config.courseUrl] || {};
      const target = state.targetMinutes ?? 0;
      const confirmed = Math.round(state.confirmedMinutes || 0);
      const status = state.completed ? 'target reached' : state.exhausted ? 'exhausted' : 'incomplete';
      this.log(`   Course ${idx + 1}/${total}: ${confirmed}/${target} min — ${status}`, 'info');
    });
  }

  // Vào surplus pass: gate website cấp khóa đã đạt, dựng state per-course, giữ
  // nguyên tiến độ đã persist để resume đúng khóa.
  async _initializeSurplusMode() {
    if (!this._isRunActive()) return false;
    if (!(await this._verifyAllConfiguredCoursesCompleted())) return false;
    if (!this._isRunActive()) return false;

    this._ensureSurplusCourseStates();
    this.surplusMode = true;
    this.log('➡️ Entering surplus-study phase', 'success');
    this.log(`   Courses: ${this.coursesConfig.length} | resume index: ${this.surplusCurrentCourseIndex}`, 'info');
    this.emit('status', this.getStatus());
    return true;
  }

  // Điều khiển surplus pass TUẦN TỰ theo this.coursesConfig: 1 → 2 → 3 → 4.
  // Không chọn ngẫu nhiên khóa. Resume từ surplusCurrentCourseIndex đã persist.
  async _runSurplusStudy() {
    if (!this.surplusMode) return true;
    this._setStatus('surplus-study');
    this.emit('status', this.getStatus());
    this._ensureSurplusCourseStates();

    const total = this.coursesConfig.length;
    this.log('🔁 Starting surplus pass', 'info');
    this.log(`   Courses: ${total}`, 'info');
    this.log('   Strategy: sequential', 'info');
    this.log(`   RNG: per-course ${SURPLUS_TARGET_MIN_MINUTES}-${SURPLUS_TARGET_MAX_MINUTES} minutes`, 'info');

    for (let cIdx = this.surplusCurrentCourseIndex; cIdx < total; cIdx++) {
      if (!this._isRunActive()) return false;
      await this._checkPaused();
      if (!this._isRunActive()) return false;
      this.surplusCurrentCourseIndex = cIdx;
      const config = this.coursesConfig[cIdx];
      const state = this._surplusStateFor(config.courseUrl);
      if (state.completed || state.exhausted) {
        this.log(`⏭️ Surplus Course ${cIdx + 1}/${total} already ${state.exhausted ? 'exhausted' : 'completed'} — skipping`, 'info');
        continue;
      }

      const outcome = await this._runSurplusCourseBlock(cIdx, config, state);
      if (outcome === 'scheduled' || outcome === 'stopped') return false;

      this.surplusCurrentCourseIndex = cIdx + 1;
      this._syncLegacySurplusAggregates();
      this.emit('status', this.getStatus());
    }

    this.surplusMode = false;
    this.log('✅ Surplus pass completed', 'success');
    this._logSurplusSummary();
    this.emit('status', this.getStatus());
    return true;
  }

  async _runSurplusCourseBlock(cIdx, config, state) {
    const total = this.coursesConfig.length;
    const courseUrl = config.courseUrl;
    const normalTarget = AutoCourseSession._targetMinutesFor(config);
    const currentStudied = Math.max(0, Number(this.courseProgress[courseUrl]?.studiedMinutes) || 0);
    const normalReached = normalTarget > 0 ? currentStudied >= normalTarget : true;
    const target = this._surplusTargetFor(state);
    const courseLabel = state.title || this.courseProgress[courseUrl]?.title || courseUrl;

    let scan = await this._captureSurplusCourseScan(courseUrl);
    if (!this._isRunActive()) return 'stopped';
    if (!scan) {
      // Một lần thử lại có giới hạn cho lỗi quét tạm thời (không lặp vô hạn).
      scan = await this._captureSurplusCourseScan(courseUrl);
      if (!this._isRunActive()) return 'stopped';
    }
    let lessons = this._extractUnfinishedLessons(scan, state);

    if (lessons === null || lessons.length === 0) {
      state.exhausted = true;
      this.log(`📘 Surplus Course ${cIdx + 1}/${total}`, 'info');
      this.log(`   Course: ${courseLabel}`, 'info');
      this.log(`   Normal target: ${normalTarget} minutes`, 'info');
      this.log(`   Normal target status: ${normalReached ? 'reached' : 'not reached'}`, 'info');
      this.log('   Unfinished lessons found: 0', 'warn');
      this.log(`   Surplus target: ${target} minutes`, 'warn');
      this.log(`⚠️ Course ${cIdx + 1}/${total} surplus exhausted`, 'warn');
      this.log(`   Target: ${target} minutes`, 'warn');
      this.log(`   Confirmed/accounted surplus: ${Math.round(state.confirmedMinutes)} minutes`, 'warn');
      this.log('   No more studyable unfinished lessons remain', 'warn');
      if (cIdx + 1 < total) this.log(`➡️ Moving to Course ${cIdx + 2}/${total}`, 'info');
      return 'exhausted';
    }

    const resuming = state.confirmedMinutes > 0 || state.localActiveMinutes > 0;
    this.log(resuming ? `♻️ Resuming Surplus Course ${cIdx + 1}/${total}` : `📘 Surplus Course ${cIdx + 1}/${total}`, 'info');
    this.log(`   Course: ${courseLabel}`, 'info');
    this.log(`   Normal target: ${normalTarget} minutes`, 'info');
    this.log(`   Normal target status: ${normalReached ? 'reached' : 'not reached'}`, 'info');
    this.log(`   Unfinished lessons found: ${lessons.length}`, 'info');
    this.log(`   Surplus target: ${target} minutes`, 'info');
    this.log(`   Confirmed surplus: ${Math.round(state.confirmedMinutes)}/${target} minutes`, 'info');
    this.emit('status', this.getStatus());

    while (state.confirmedMinutes < target) {
      if (!this._isRunActive()) return 'stopped';
      await this._checkPaused();
      if (!this._isRunActive()) return 'stopped';
      if (this._hitSchedulingLimit()) return 'scheduled';
      this._rolloverDailyCounter();
      const dailyRemainingMs = Math.max(0, this.options.dailyMaxMinutes - this.dailyStudiedMinutes) * 60000;
      if (dailyRemainingMs <= 0) { this._hitDailyLimit(); return 'scheduled'; }
      if (lessons.length === 0) break;

      const lesson = lessons[0];
      const result = await this._studySurplusLesson(cIdx, config, state, lesson);
      if (!this._isRunActive()) return 'stopped';
      if (result.outcome === 'scheduled') return 'scheduled';
      if (result.outcome === 'stopped') return 'stopped';
      this._syncLegacySurplusAggregates();
      this.emit('status', this.getStatus());

      if (result.outcome === 'confirmed') {
        // Bài đã 100% → loại khỏi danh sách; còn dang dở → tiếp tục bài này.
        if (result.lessonCompleted || (result.lessonPercent != null && result.lessonPercent >= 100)) {
          lessons.shift();
        } else if (result.lessonPercent != null) {
          lesson.progressPercent = result.lessonPercent;
        }
      } else if (result.outcome === 'unavailable') {
        lessons.shift();
      } else if (state.unusableLessons.includes(lesson.url)) {
        // unconfirmed & đã chạm ngưỡng → bỏ bài này.
        lessons.shift();
      }
      // unconfirmed nhưng chưa chạm ngưỡng → thử lại (bị chặn bởi số lần tối đa).
    }

    if (state.confirmedMinutes >= target) {
      state.completed = true;
      this.log(`🎯 Surplus target reached for Course ${cIdx + 1}/${total}`, 'success');
      this.log(`   Target: ${target} minutes`, 'success');
      this.log(`   Confirmed/accounted surplus: ${Math.round(state.confirmedMinutes)} minutes`, 'success');
      if (cIdx + 1 < total) this.log(`➡️ Moving to Course ${cIdx + 2}/${total}`, 'info');
    } else {
      state.exhausted = true;
      this.log(`⚠️ Course ${cIdx + 1}/${total} surplus exhausted`, 'warn');
      this.log(`   Target: ${target} minutes`, 'warn');
      this.log(`   Confirmed/accounted surplus: ${Math.round(state.confirmedMinutes)} minutes`, 'warn');
      this.log('   No more studyable unfinished lessons remain', 'warn');
      if (cIdx + 1 < total) this.log(`➡️ Moving to Course ${cIdx + 2}/${total}`, 'info');
    }
    this._syncLegacySurplusAggregates();
    this.emit('status', this.getStatus());
    return state.completed ? 'completed' : 'exhausted';
  }

  // Học MỘT block surplus cho một bài, rồi xác minh website BEFORE/AFTER. Chỉ
  // credit khi website xác nhận (thời gian khóa tăng HOẶC tiến độ bài tăng).
  async _studySurplusLesson(cIdx, config, state, lesson) {
    const total = this.coursesConfig.length;
    const courseUrl = config.courseUrl;

    this.log('📖 Selecting unfinished lesson', 'info');
    this.log(`   Course: ${cIdx + 1}/${total}`, 'info');
    this.log(`   Lesson: ${lesson.title || lesson.url}`, 'info');
    this.log(`   Current website progress: ${lesson.progressPercent}%`, 'info');
    this.log(`   URL: ${lesson.url}`, 'info');

    let before = await this._captureSurplusEvidence(courseUrl, lesson.url);
    if (!this._isRunActive()) return { outcome: 'stopped' };
    if (!before) {
      // Thử đọc lại một lần trước khi kết luận bài không dùng được.
      before = await this._captureSurplusEvidence(courseUrl, lesson.url);
      if (!this._isRunActive()) return { outcome: 'stopped' };
    }
    if (!before) {
      this._markSurplusLessonUnusable(state, lesson.url);
      this.log('⚠️ Surplus lesson unavailable', 'warn');
      this.log(`   Lesson: ${lesson.title || lesson.url}`, 'warn');
      this.log('   Reason: cannot read website progress', 'warn');
      this.log('🔄 Trying next unfinished lesson', 'info');
      return { outcome: 'unavailable' };
    }

    let opened = false;
    try {
      this.log('🌐 Opening surplus lesson...', 'info');
      await this.page.goto(lesson.url, { waitUntil: 'load', timeout: 60000 });
      await this._fakeVisibilityAPI();
      await this.page.waitForTimeout(3500);
      opened = this._isOnUrl(lesson.url);
    } catch (err) {
      this.log('⚠️ Surplus lesson unavailable', 'warn');
      this.log(`   Lesson: ${lesson.title || lesson.url}`, 'warn');
      this.log(`   Reason: ${String(err.message).split('\n')[0]}`, 'warn');
    }
    // Mở bài là I/O dài — phiên có thể đã hẹn giờ/kết thúc trong lúc chờ.
    if (!this._isRunActive()) return { outcome: 'stopped' };
    if (!opened) {
      this._markSurplusLessonUnusable(state, lesson.url);
      this.log('🔄 Trying next unfinished lesson', 'info');
      return { outcome: 'unavailable' };
    }
    this.log('✅ Surplus lesson opened successfully', 'success');

    const dailyRemainingMs = Math.max(0, this.options.dailyMaxMinutes - this.dailyStudiedMinutes) * 60000;
    const targetRemainingMs = Math.max(0, state.targetMinutes - state.confirmedMinutes) * 60000;
    if (dailyRemainingMs <= 0) { this._hitDailyLimit(); return { outcome: 'scheduled' }; }

    let blockMinutes = SURPLUS_MIN_BLOCK_MINUTES;
    try {
      const timer = await readDomTimer(this.page);
      if (timer && timer.totalMinutes > 0) blockMinutes = Math.max(SURPLUS_MIN_BLOCK_MINUTES, timer.totalMinutes);
    } catch { /* dùng block tối thiểu */ }
    if (!this._isRunActive()) return { outcome: 'stopped' };

    const plannedMs = Math.max(0, Math.min(blockMinutes * 60000, targetRemainingMs, dailyRemainingMs));
    if (plannedMs <= 0) return { outcome: 'unavailable' };

    this.log('📚 Surplus study plan', 'info');
    this.log(`   Course: ${cIdx + 1}/${total}`, 'info');
    this.log(`   Lesson: ${lesson.title || lesson.url}`, 'info');
    this.log(`   Lesson progress before: ${before.lessonPercent == null ? 'unknown' : `${before.lessonPercent}%`}`, 'info');
    this.log(`   Course surplus progress: ${Math.round(state.confirmedMinutes)}/${state.targetMinutes} min`, 'info');
    this.log(`   Surplus remaining: ${Math.ceil(targetRemainingMs / 60000)} min`, 'info');
    this.log(`   Daily remaining: ${Math.floor(dailyRemainingMs / 60000)} min`, 'info');
    this.log(`   Planned active study: ${Math.round(plannedMs / 60000)} min`, 'info');
    this.log('▶️ Starting surplus study block', 'info');
    this.log(`   Planned duration: ${Math.round(plannedMs / 60000)} minutes`, 'info');

    const activeMs = await this._waitForActiveStudyTime(plannedMs);
    if (!this._isRunActive()) return { outcome: 'stopped' };
    const activeMinutes = activeMs / 60000;
    state.localActiveMinutes = Math.round((state.localActiveMinutes + activeMinutes) * 100) / 100;
    this.log('⏱️ Local active study finished', 'info');
    this.log(`   Active time: ${Math.round(activeMinutes)} minutes`, 'info');

    this.log('🔄 Refreshing/checkpointing surplus lesson...', 'info');
    let after = await this._checkpointAndCaptureSurplusEvidence(courseUrl, lesson.url);
    if (!this._isRunActive()) return { outcome: 'stopped' };
    this.log('🔍 Verifying website-recorded progress...', 'info');
    let verdict = this._classifySurplusProgress(before, after, activeMinutes);
    this._logSurplusVerification(before, after, verdict);

    if (!verdict.confirmed) {
      // Một lần xác minh lại có giới hạn (không lặp vô hạn).
      this.log('🔄 Performing one bounded re-verification', 'info');
      after = await this._captureSurplusEvidence(courseUrl, lesson.url);
      if (!this._isRunActive()) return { outcome: 'stopped' };
      verdict = this._classifySurplusProgress(before, after, activeMinutes);
      this._logSurplusVerification(before, after, verdict);
    }

    if (!verdict.confirmed) {
      this.log('⚠️ Website did not confirm additional progress for this study block', 'warn');
      const attempts = (state.lessonAttempts[lesson.url] || 0) + 1;
      state.lessonAttempts[lesson.url] = attempts;
      if (attempts >= SURPLUS_MAX_UNCONFIRMED_ATTEMPTS) {
        this._markSurplusLessonUnusable(state, lesson.url);
        this.log(`⚠️ Marking lesson unusable after ${attempts} unconfirmed attempts`, 'warn');
      }
      this.log('🔄 Trying next unfinished lesson', 'info');
      return { outcome: 'unconfirmed' };
    }

    const credited = Math.max(0, Math.min(verdict.creditedMinutes, state.targetMinutes - state.confirmedMinutes));
    state.confirmedMinutes = Math.round((state.confirmedMinutes + credited) * 100) / 100;
    state.localActiveMinutes = Math.max(0, Math.round((state.localActiveMinutes - credited) * 100) / 100);
    state.lessonAttempts[lesson.url] = 0;
    if (after && after.courseMinutes != null) state.verifiedMinutes = after.courseMinutes;
    this.dailyStudiedMinutes += credited;
    this.surplusStudiedMinutes = Math.round((this.surplusStudiedMinutes + credited) * 100) / 100;
    if (after && after.courseTitle) state.title = after.courseTitle;
    const lessonCompleted = after ? (after.lessonCompleted === true || (after.lessonPercent != null && after.lessonPercent >= 100)) : false;
    if (lessonCompleted && !state.studiedLessons.includes(lesson.url)) state.studiedLessons.push(lesson.url);
    this.log(`📈 Course surplus progress: ${Math.round(state.confirmedMinutes)}/${state.targetMinutes} minutes`, 'success');

    return { outcome: 'confirmed', lessonPercent: after ? after.lessonPercent : null, lessonCompleted };
  }

  async _finalizeSurplusCompletion() {
    // Chỉ hoàn tất khi TOÀN BỘ khóa đã xử lý xong surplus pass (đạt target hoặc
    // kiệt khẩu). `unknown` của gate cấp khóa không gây lặp vô hạn.
    if (!this._surplusPassProcessed()) return false;
    if (!this._isRunActive()) return false;
    this.log('🔎 Final verification after surplus pass', 'info');
    const verified = await this._verifyAllConfiguredCoursesCompleted();
    if (!this._isRunActive()) return false;
    if (!verified) {
      this.log('⚠️ Surplus pass finished, but final all-course verification failed; deferring completion', 'warn');
      return false;
    }
    this.surplusMode = false;
    return true;
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
    if (!this._isRunActive()) return { completed: false, progressPercent: null };
    let verifyPage = null;
    try {
      verifyPage = await this.context.newPage();
      const result = await scanCourseDetails(verifyPage, courseUrl);
      if (!this._isRunActive()) return { completed: false, progressPercent: null };
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

  // Bất biến thế hệ run: callback chỉ hợp lệ khi phiên chưa kết thúc/hẹn giờ VÀ
  // vẫn đúng thế hệ khóa học đang chạy (xem _isRunActive).
  _isCurrentCourseRun(courseRunId) {
    return this._isRunActive(courseRunId);
  }

  _setCourseFinalizationState(courseUrl, state) {
    if (!this._isRunActive()) return;
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
    // Callback đến muộn sau khi đã hẹn giờ / dừng / đổi run → vứt bỏ TRƯỚC khi log
    // hay chạm courseProgress ("Re-checking…"/"continuing…" không được xuất hiện
    // sau khi phiên đã sang daily-limit/date-limit/time-window/next-day).
    if (!this._isCurrentCourseRun(courseRunId)) {
      return { confirmed: false, stale: true, scanResult: null };
    }
    this.log('🔍 Re-checking course progress after checkpoint', 'info');
    let verifiedScan = null;
    for (let attempt = 1; attempt <= 2 && this._isCurrentCourseRun(courseRunId); attempt++) {
      try {
        verifiedScan = await this._scanCourseDetailsForCheckpoint(courseUrl, preserveCurrentPage);
      } catch (err) {
        this.log(`⚠️ Course checkpoint scan gặp lỗi tạm thời: ${String(err.message).split('\n')[0]}`, 'warn');
        if (!this.page || (typeof this.page.isClosed === 'function' && this.page.isClosed())) {
          await this._recreatePage();
        }
        verifiedScan = null;
      }
      if (verifiedScan && verifiedScan.totalLessons > 0) break;
      if (attempt < 2) {
        this.log(`⚠️ Course checkpoint scan failed (attempt ${attempt}/2) — retrying once`, 'warn');
        await this._waitInterruptible(5000);
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
    const siteCompletionState = AutoCourseSession._courseCompletionStateOf(verifiedScan);
    this.courseProgress[courseUrl] = {
      ...this.courseProgress[courseUrl],
      title: verifiedScan.courseTitle || courseTitle,
      targetMinutes,
      studiedMinutes: verifiedMinutes,
      completed: confirmed,
      websiteCourseCompleted: siteCompletionState === 'completed',
      websiteCourseCompletionState: siteCompletionState,
      websiteCourseProgressPercent: verifiedScan.courseProgressPercent ?? null,
      websiteCourseCompletionSource: verifiedScan.courseCompletionSource
        || verifiedScan.courseCompletionEvidence?.resolutionSource
        || null,
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
      if (this._stopped || SCHEDULED_STATUSES.has(this.status)) break;
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
      || msg.includes('ERR_ABORTED')
      || msg.toLowerCase().includes('target page, context or browser has been closed')
      || msg.toLowerCase().includes('page has been closed')
      || msg.toLowerCase().includes('frame was detached')
      || msg.toLowerCase().includes('timeout');
  }

  async _waitInterruptible(durationMs) {
    let remaining = Math.max(0, Number(durationMs) || 0);
    while (remaining > 0 && !this._stopped) {
      await this._checkPaused();
      if (this._stopped || SCHEDULED_STATUSES.has(this.status)) return false;
      const step = Math.min(250, remaining);
      await new Promise(resolve => setTimeout(resolve, step));
      remaining -= step;
    }
    return !this._stopped && !SCHEDULED_STATUSES.has(this.status);
  }

  async _recreatePage() {
    const oldPage = this.page;
    try { if (oldPage) await oldPage.close(); } catch { /* ignore */ }
    if (this._stopped || !this.context) return false;
    try {
      this.page = await this.context.newPage();
      await this._fakeVisibilityAPI();
      return true;
    } catch (err) {
      this.page = null;
      this.log(`⚠️ Không thể tạo lại trang trình duyệt: ${String(err.message).split('\n')[0]}`, 'warn');
      return false;
    }
  }

  async _readAuthenticationError() {
    if (!this.page) return null;
    try {
      const errorEl = await this.page.$('.alert-danger');
      if (!errorEl) return null;
      if (typeof errorEl.isVisible === 'function' && !(await errorEl.isVisible())) return null;
      const text = String((await errorEl.textContent()) || '').trim();
      if (!text) return null;
      const authRejection = /(mật khẩu|tên đăng nhập|đăng nhập|password|username|credential|authentication|invalid login|wrong login|incorrect|access denied|unauthorized|forbidden)/i;
      return authRejection.test(text) ? text : null;
    } catch {
      return null;
    }
  }

  async _waitForLoginOutcome(redirect, loginError, timeoutMs = LOGIN_POST_SUBMIT_TIMEOUT_MS) {
    let timeoutHandle;
    let stopPoll;
    const timedOut = new Promise(resolve => {
      timeoutHandle = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs));
    });
    const stopped = new Promise(resolve => {
      if (this._stopped) {
        resolve('stopped');
        return;
      }
      stopPoll = setInterval(() => {
        if (this._stopped) resolve('stopped');
      }, 100);
    });
    try {
      return await Promise.race([redirect, loginError, timedOut, stopped]);
    } finally {
      clearTimeout(timeoutHandle);
      if (stopPoll) clearInterval(stopPoll);
    }
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
      if (SCHEDULED_STATUSES.has(this.status)) return false;

      if (!this.page || (typeof this.page.isClosed === 'function' && this.page.isClosed())) {
        await this._recreatePage();
        if (!this.page) {
          await this._waitInterruptible(30000);
          continue;
        }
      }

      // Phát hiện bị văng phiên đăng nhập (trang /web/login) → tự đăng nhập lại
      if (this.page && this.page.url().includes('/web/login')) {
        this.log('⚠️ Bị văng phiên đăng nhập (redirect về trang login) → Tự động đăng nhập lại...', 'warn');
        try {
          await this.login();
        } catch (err) {
          if (err && err.code === 'AUTHENTICATION_REJECTED') throw err;
          this.log(`⚠️ Lỗi đăng nhập lại: ${err.message} → Thử lại sau 30s`, 'warn');
          await this._waitInterruptible(30000);
          continue;
        }
      }

      if (this._isOnUrl(expectedUrl)) return true;
      attempt++;
      this.log(`⚠️ Đang chờ hệ thống cho phép vào đúng URL (lần ${attempt}): ${this.page ? this.page.url() : ''} → Thử lại sau 30 giây...`, 'warn');
      this.emit('status', this.getStatus());
      await this._waitInterruptible(30000);
      if (this._stopped) return false;
      try {
        await this.page.goto(expectedUrl, { waitUntil: 'load', timeout: 60000 });
        await this._fakeVisibilityAPI();
        await this.page.waitForTimeout(2000);
      } catch (err) {
        this.log(`⚠️ Lỗi truy cập lại: ${String(err.message).split('\n')[0]}`, 'warn');
        if (!this.page || (typeof this.page.isClosed === 'function' && this.page.isClosed())) {
          await this._recreatePage();
        }
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
      randomStartEnabled: this.options.randomStartEnabled === true,
      randomStartFrom: this.options.randomStartFrom || this.options.newDayStartTime || '06:00',
      randomStartTo: this.options.randomStartTo || this.options.newDayStartTime || '06:00',
      scheduledStartAt: this.options.scheduledStartAt || null,
      scheduledStartDate: this.options.scheduledStartDate || null,
      refreshInterval: this.options.refreshInterval || 15,
      dailyDate: this.dailyDate,
      courseProgress: this.courseProgress,
      surplusMode: this.surplusMode,
      surplusCurrentCourseIndex: this.surplusCurrentCourseIndex,
      surplusCourseStates: this.surplusCourseStates,
      surplusPassProcessed: this._surplusPassProcessed(),
      surplusTargetMinutes: this.surplusTargetMinutes,
      surplusStudiedMinutes: this.surplusStudiedMinutes,
      surplusEligibleCourses: this.surplusEligibleCourses,
      surplusExhausted: this.surplusExhausted,
    };
  }

  async login() {
    this._setStatus('logging-in');
    this.emit('status', this.getStatus());

    const retryIntervalMs = Math.max(1, Number(this.options.loginRetryIntervalMs ?? LOGIN_RETRY_BASE_MS));
    const gracePeriodMs = Math.max(0, Number(this.options.loginPostSubmitGraceMs ?? LOGIN_POST_SUBMIT_GRACE_MS));
    let attempt = 0;
    while (!this._stopped) {
      await this._checkPaused();
      if (this._stopped) return false;
      if (this._hitSchedulingLimit()) return false;
      attempt++;
      try {
        if (!this.page || (typeof this.page.isClosed === 'function' && this.page.isClosed())) {
          await this._recreatePage();
        }
        if (!this.page) throw new Error('Không có trang trình duyệt để đăng nhập');

        this.log(attempt === 1 ? '🔑 Đang đăng nhập tài khoản...' : `🔁 Login retry #${attempt}...`, 'info');
        await this.page.goto(LOGIN_URL, {
          waitUntil: 'domcontentloaded',
          timeout: Number(this.options.loginNavigationTimeoutMs) || LOGIN_NAVIGATION_TIMEOUT_MS,
        });
        await this.page.waitForSelector('input[name="login"]', {
          timeout: Number(this.options.loginFormTimeoutMs) || LOGIN_FORM_TIMEOUT_MS,
        });
        await this.page.fill('input[name="login"]', this.account.email);
        await this.page.fill('input[name="password"]', this.account.password);

        if (this.options.stealth) {
          await this.page.waitForTimeout(this._randomBetween(500, 1500));
        }

        const submitTimeoutMs = Number(this.options.loginPostSubmitTimeoutMs) || LOGIN_POST_SUBMIT_TIMEOUT_MS;
        const redirect = this.page.waitForURL(
          url => !url.pathname.includes('/web/login'),
          { waitUntil: 'domcontentloaded', timeout: submitTimeoutMs },
        ).then(() => 'redirect').catch(() => null);
        const loginError = this.page.waitForSelector('.alert-danger', {
          state: 'visible',
          timeout: submitTimeoutMs,
        }).then(() => 'error').catch(() => null);

        if (this.loginLimiter.active >= this.loginLimiter.max) {
          this.log(`Đang chờ lượt đăng nhập (${this.loginLimiter.active}/${this.loginLimiter.max} slot đang được sử dụng).`, 'info');
        }
        const acquired = await this.loginLimiter.acquire(this);
        if (!acquired || this._stopped) return false;
        let submitOutcome;
        try {
          this.log('Đã nhận login slot.', 'info');
          await this.page.click('button[type="submit"]', { noWaitAfter: true });
          submitOutcome = await this._waitForLoginOutcome(
            redirect,
            loginError,
            submitTimeoutMs,
          );
        } finally {
          this.loginLimiter.release();
        }
        if (submitOutcome === 'stopped') return false;

        // A redirect may be delayed even after the watcher settles. Give Odoo
        // a short grace period before classifying the attempt as transient.
        if (gracePeriodMs > 0) await this._waitInterruptible(gracePeriodMs);
        if (this._stopped) return false;

        const currentUrl = this.page.url();
        if (!currentUrl.includes('/web/login')) {
          this.log(`✅ Login thành công${attempt > 1 ? ` sau ${attempt} lần thử` : ''}!`, 'success');
          return true;
        }

        const errorText = await this._readAuthenticationError();
        if (errorText) {
          const authError = new Error(`Login thất bại: ${errorText}`);
          authError.code = 'AUTHENTICATION_REJECTED';
          throw authError;
        }

        this.log('⚠️ Sau khi gửi form vẫn đang ở /web/login. Không phát hiện lỗi xác thực rõ ràng.', 'warn');
      } catch (err) {
        if (err && err.code === 'AUTHENTICATION_REJECTED') {
          this.log(`❌ Server từ chối đăng nhập: ${err.message.replace(/^Login thất bại:\s*/i, '')}`, 'error');
          throw err;
        }
        if (!this._isNetworkError(err)) {
          this.log(`⚠️ Login tạm thời chưa hoàn tất: ${String(err.message).split('\n')[0]}`, 'warn');
        } else {
          this.log(`⚠️ Login gặp lỗi tạm thời: ${String(err.message).split('\n')[0]}`, 'warn');
        }
      }
      if (this._stopped) return false;
      this.emit('status', this.getStatus());
      const retryDelayMs = Math.min(LOGIN_RETRY_MAX_MS, Math.max(1, Math.floor(retryIntervalMs * Math.pow(1.7, attempt - 1) * (0.75 + Math.random() * 0.5))));
      this.log(`⏳ Login chưa hoàn tất. Chờ ${Math.round(retryDelayMs / 1000)} giây trước khi thử lại...`, 'warn');
      await this._waitInterruptible(retryDelayMs);
      if (this._stopped) return false;
      await this._recreatePage();
    }
    return false;
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

  // Phát hiện (thuần, không side effect) — ngoài Ca học theo quy tắc ngày cụ thể?
  _isOutsideTimeShift() {
    const customRules = this.options.customTimeRules || [];
    if (!customRules || customRules.length === 0) return false;
    const now = new Date();
    const shiftsToday = getShiftsForDate(now, customRules);
    if (!shiftsToday || shiftsToday.length === 0) return false;
    return !calcMsRemainingInShift(now, shiftsToday).inShift;
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
      this._enterScheduledStatus('date-limit');
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

      let surplusHandled = false;
      if (this.surplusMode) {
        // A restored surplus session must still pass the website-level gate.
        if (await this._initializeSurplusMode()) {
          surplusHandled = true;
          await this._runSurplusStudy();
        } else if (!this.surplusExhausted) {
          this.surplusMode = false;
          this.log('⚠️ Restored surplus state failed the all-course 100% verification; returning to normal course mode', 'warn');
        }
      }

      // Vòng lặp qua các khóa học được cấu hình
      for (let cIdx = 0; cIdx < this.coursesConfig.length && !surplusHandled; cIdx++) {
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
          if (!this.page || (typeof this.page.isClosed === 'function' && this.page.isClosed())) {
            await this._recreatePage();
          }
          await this._waitInterruptible(30000);
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
          websiteCourseCompleted: scanResult.courseLevelCompleted === true,
          websiteCourseProgressPercent: scanResult.courseProgressPercent ?? null,
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
              if (!this.page || (typeof this.page.isClosed === 'function' && this.page.isClosed())) {
                await this._recreatePage();
              }
              await this._waitInterruptible(30000);
              continue;
            }
            await this._fakeVisibilityAPI();
            await this.page.waitForTimeout(3500);
            if (this._isOnUrl(lesson.url)) break;
            navAttempt++;
            this.log(`⚠️ Bài học chưa mở được, bị redirect (lần ${navAttempt}): ${this.page.url()} → Thử lại sau 30 giây...`, 'warn');
            this.emit('status', this.getStatus());
            await this._waitInterruptible(30000);
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
            if (!this._isCurrentCourseRun(courseRunId)) return;
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

          const verifyCurrentCheckpoint = async (refreshPage, continueStudying = true) => {
            // Callback muộn sau khi phiên đã hẹn giờ/kết thúc hoặc đã đổi run phải bị
            // vứt bỏ hoàn toàn — không log, không quét, không ghi courseProgress.
            if (!this._isCurrentCourseRun(courseRunId)) {
              return { confirmed: false, stale: true, scanResult: null };
            }
            const verifyArgs = {
              courseUrl: cConfig.courseUrl,
              targetMinutes,
              courseTitle: scanResult.courseTitle,
              courseRunId,
              preserveCurrentPage: true,
              continueStudying,
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
                await verifyCurrentCheckpoint(false, false);
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

            // Giới hạn lịch: LƯU TIẾN ĐỘ TRƯỚC (F5 để Odoo chốt checkpoint) rồi mới
            // chốt sang trạng thái hẹn giờ. Từ lúc _enterScheduledStatus() chạy,
            // mọi callback async còn treo đều bị _isRunActive() từ chối.
            if (activeWaitMs < waitStep && !this._allConfiguredCoursesCompleted() && this._peekSchedulingLimit()) {
              if (courseFinalizationPlan) break;
              try {
                await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                await verifyCurrentCheckpoint(false, false);
              } catch { /* ignore */ }
              this._hitSchedulingLimit();
              return;
            }

            // Ghi nhận phần vừa học trước, sau đó mới hẹn tiếp ca/ngày kế tiếp.
            if (!this._allConfiguredCoursesCompleted() && this._peekSchedulingLimit()) {
              if (courseFinalizationPlan) break;
              try {
                await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                await verifyCurrentCheckpoint(false, false);
              } catch { /* ignore */ }
              this._hitSchedulingLimit();
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
      } else if (surplusHandled && await this._finalizeSurplusCompletion()) {
        this._setStatus('completed');
        this.log('✅ Account fully completed', 'success');
        this.log('➡️ Moving account to complete queue', 'success');
        this.emit('status', this.getStatus());
      } else {
        const allWebsiteCoursesCompleted = this.coursesConfig.length === 0
          || await this._verifyAllConfiguredCoursesCompleted();
        // Surplus pass chỉ bắt đầu khi mọi target thường đã đạt VÀ pass chưa xử lý xong.
        const surplusPassPending = this.coursesConfig.length > 0
          && allWebsiteCoursesCompleted
          && !this.surplusMode
          && !this._surplusPassProcessed();
        if (surplusPassPending) {
          await this._initializeSurplusMode();
          if (this.surplusMode) {
            await this._runSurplusStudy();
          }
          if (SCHEDULED_STATUSES.has(this.status) || this.status === 'paused') {
            this.emit('status', this.getStatus());
            return;
          }
          if (await this._finalizeSurplusCompletion()) {
            this._setStatus('completed');
            this.log('✅ Account fully completed', 'success');
            this.log('➡️ Moving account to complete queue', 'success');
            this.emit('status', this.getStatus());
            return;
          }
        }
        // Pass đã xử lý xong (restore/khôi phục) → xác minh lần cuối rồi hoàn tất.
        if (allWebsiteCoursesCompleted && this._surplusPassProcessed()) {
          if (await this._finalizeSurplusCompletion()) {
            this._setStatus('completed');
            this.log('✅ Account fully completed', 'success');
            this.log('➡️ Moving account to complete queue', 'success');
            this.emit('status', this.getStatus());
            return;
          }
        }
        const incompleteCourses = this.coursesConfig.filter(c => !this.courseProgress[c.courseUrl]?.completed);
        if (this.surplusMode || (!allWebsiteCoursesCompleted && incompleteCourses.length === 0)) {
          if (this._hitSchedulingLimit()) return;
          this._enterScheduledStatus('next-day');
          this.log('⏭️ Course targets are met locally, but website has not confirmed all courses at 100%; waiting for the next verification run', 'warn');
        } else if (incompleteCourses.length > 0) {
          // Bắt lại đúng loại lịch hẹn nếu ca/khung/ngân sách ngày vừa kết thúc
          // trong lúc xử lý bài cuối cùng của lượt quét.
          if (this._hitSchedulingLimit()) return;
          this._enterScheduledStatus('next-day');
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
      } else if (SCHEDULED_STATUSES.has(this.status)) {
        // Phiên đã chốt sang trạng thái hẹn giờ: một lỗi đến muộn KHÔNG được biến
        // nó thành 'error' (sẽ mất lịch hẹn) và cũng không được hồi sinh việc học.
        console.log(`[AUTOSCAN] bỏ qua lỗi muộn sau khi đã hẹn giờ | session=${this.id} | status=${this.status} | ${err.message}`);
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
    this.loginLimiter.cancel(this);
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
  LoginLimiter,
  globalLoginLimiter,
  MAX_CONCURRENT_LOGINS,
};
