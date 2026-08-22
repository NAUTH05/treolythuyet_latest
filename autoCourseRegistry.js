// ============================================================
//  AUTO-COURSE SESSION REGISTRY
//  Nơi DUY NHẤT giữ quyền sở hữu của một phiên Auto-Scan:
//    - 1 sessionId  ⇒ đúng 1 phiên đang sống (phiên cũ bị thu hồi, không mồ côi)
//    - 1 tài khoản  ⇒ đúng 1 phiên được chạy (khóa theo email, không deadlock)
//    - 1 sessionId  ⇒ đúng 1 timer hẹn giờ
//  Tách riêng khỏi server.js để các bất biến này kiểm thử được bằng unit test.
// ============================================================

// setTimeout của Node tràn int32 (~24.8 ngày) → chia nhỏ thành các bước 12h
const MAX_TIMER_STEP_MS = 12 * 60 * 60 * 1000;

class AutoCourseRegistry {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this._sessions = new Map();      // sessionId -> session
    this._timers = new Map();        // sessionId -> Timeout
    this._accountOwners = new Map(); // account email -> session đang giữ quyền chạy
    this._idSeq = 0;
  }

  // ID phải duy nhất tuyệt đối: `Date.now()` một mình vẫn trùng khi nhiều phiên
  // được tạo trong cùng một milisecond (vòng lặp đồng bộ của API /start).
  nextSessionId(accountName, now = Date.now()) {
    this._idSeq += 1;
    return `autoscan_${accountName}_${now}_${this._idSeq}`;
  }

  get size() {
    return this._sessions.size;
  }

  has(id) {
    return this._sessions.has(id);
  }

  get(id) {
    return this._sessions.get(id) || null;
  }

  values() {
    return [...this._sessions.values()];
  }

  entries() {
    return [...this._sessions.entries()];
  }

  // Phiên `session` có còn là phiên chính thức của ID đó không?
  // Dùng để chặn emit muộn của một phiên đã bị thay thế/xóa ghi đè trạng thái thật.
  isCurrent(session) {
    return Boolean(session) && this._sessions.get(session.id) === session;
  }

  // Đăng ký phiên cho một ID. Nếu ID đó đã có phiên khác → thu hồi phiên cũ
  // (ngắt listener, nhả khóa tài khoản, đóng browser) để không còn phiên mồ côi
  // vẫn chạy nền mà Dashboard không điều khiển được.
  adopt(session) {
    const previous = this._sessions.get(session.id) || null;
    this._sessions.set(session.id, session);
    if (previous && previous !== session) {
      this.log(`♻️ Thu hồi phiên Auto-Scan cũ cùng ID ${session.id} (bị thay thế bởi phiên mới)`);
      this._detach(previous);
      this._closeInBackground(previous);
    }
    return previous;
  }

  // Xóa hẳn một phiên khỏi registry và đóng browser của nó.
  async forget(id) {
    const session = this._sessions.get(id) || null;
    this.clearTimer(id);
    this._sessions.delete(id);
    if (!session) return null;
    this._detach(session);
    try {
      if (typeof session.stop === 'function') await session.stop();
    } catch (err) {
      this.log(`⚠️ Không thể đóng phiên Auto-Scan ${id}: ${err.message}`);
    }
    return session;
  }

  _detach(session) {
    this.releaseAccount(session);
    if (typeof session.removeAllListeners === 'function') session.removeAllListeners();
  }

  _closeInBackground(session) {
    if (typeof session.stop !== 'function') return;
    Promise.resolve()
      .then(() => session.stop())
      .catch(err => this.log(`⚠️ Không thể đóng phiên Auto-Scan cũ ${session.id}: ${err.message}`));
  }

  // ── Hẹn giờ: mỗi sessionId chỉ được có tối đa 1 timer ──

  hasTimer(id) {
    return this._timers.has(id);
  }

  clearTimer(id) {
    const timer = this._timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this._timers.delete(id);
    }
  }

  setTimer(id, fireAt, fn) {
    this.clearTimer(id);
    const at = fireAt instanceof Date ? fireAt.getTime() : Number(fireAt);
    const delay = Math.max(1000, at - Date.now());
    const timer = setTimeout(() => {
      this._timers.delete(id);
      if (at - Date.now() > 1000) {
        this.setTimer(id, fireAt, fn); // còn xa → hẹn bước 12h tiếp theo
      } else {
        fn();
      }
    }, Math.min(delay, MAX_TIMER_STEP_MS));
    this._timers.set(id, timer);
    return timer;
  }

  clearAllTimers() {
    for (const id of [...this._timers.keys()]) this.clearTimer(id);
  }

  // ── Khóa tài khoản: chống 2 phiên mở browser cho cùng 1 tài khoản Odoo ──
  //
  // Trước đây việc này chỉ dựa vào trạng thái chuỗi ('idle' cũng bị coi là đang
  // chiếm tài khoản), nên hai phiên cùng chờ khởi động sẽ chặn lẫn nhau vĩnh
  // viễn. Nay có hai lớp rõ ràng:
  //   1. phiên THỰC SỰ đang chiếm (đang chạy, hoặc tạm dừng chờ resume)
  //   2. khóa tường minh theo email — người giành được khóa trước thì chạy trước
  // Phiên mới tạo (chưa start) KHÔNG chặn ai, nên không còn deadlock.
  whoBlocks(email, requester = null) {
    if (!email) return null;
    const busy = this.values().find(session => session !== requester
      && session.account && session.account.email === email
      && typeof session.ownsAccountSession === 'function'
      && session.ownsAccountSession());
    if (busy) return busy;
    const holder = this._accountOwners.get(email);
    // Chủ sở hữu đã bị thay thế/xóa khỏi registry thì khóa coi như đã mục — tự nhả.
    if (holder && holder !== requester && this.isCurrent(holder)) return holder;
    return null;
  }

  // Giành khóa tài khoản. Kiểm tra + ghi nhận diễn ra đồng bộ (không await ở
  // giữa) nên hai request/timer đồng thời chỉ có đúng một phiên thắng.
  claimAccount(email, session) {
    if (!email) return true;
    if (this.whoBlocks(email, session)) return false;
    this._accountOwners.set(email, session);
    return true;
  }

  accountOwner(email) {
    return this._accountOwners.get(email) || null;
  }

  releaseAccount(session) {
    for (const [email, holder] of [...this._accountOwners]) {
      if (holder === session) this._accountOwners.delete(email);
    }
  }
}

module.exports = { AutoCourseRegistry, MAX_TIMER_STEP_MS };
