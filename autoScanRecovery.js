// ============================================================
//  AUTO-SCAN SCHEDULE RECOVERY
//  Quyết định khi nào một phiên Auto-Scan đang hẹn giờ bị "mắc kẹt" (quá
//  nextRunTime nhưng không còn phiên sống nào giữ tài khoản, người dùng cũng
//  không bấm Dừng) để server tự tạo MỘT phiên mới khôi phục.
//
//  Tách riêng khỏi server.js vì server.js tự listen cổng, không thể require
//  trong unit test. Giữ đúng bất biến vòng đời của engine: trạng thái hẹn giờ
//  (daily-limit / date-limit / time-window / next-day) không bao giờ là trạng
//  thái kết thúc, và phiên đã Dừng thì không được hồi sinh.
// ============================================================

const { SCHEDULED_STATUSES, TERMINAL_STATUSES, PHASE_RUNNING } = require('./autoCourseEngine');

// Có phải trạng thái server tự hẹn giờ chạy lại (không phải kết thúc)?
function isScheduledAutoScan(session) {
  if (!session) return false;
  return SCHEDULED_STATUSES.has(session.status) && !TERMINAL_STATUSES.has(session.status);
}

// Được phép tạo phiên MỚI từ phiên hẹn giờ này chưa?
//   - phải đang ở trạng thái hẹn giờ. Phiên bị người dùng Dừng sẽ chuyển sang
//     'stopped' (terminal) nên tự động bị loại; KHÔNG được xét `_stopped` ở đây
//     vì `stop()` cũng được khối finally của start() gọi để dọn dẹp bình thường.
//   - không còn vòng lặp start() đang chạy (phase running) — tránh hai browser.
function canRestartScheduledSession(session) {
  if (!isScheduledAutoScan(session)) return false;
  if (session._phase === PHASE_RUNNING) return false;
  return true;
}

// Phiên hẹn giờ đã quá hạn mà không còn ai giữ tài khoản → cần tự khôi phục.
// `hasLiveOwner` do phía server tính (Queue thủ công / Auto-Scan khác cùng tài khoản).
function isStaleScheduledSession(session, { now = Date.now(), hasLiveOwner = false } = {}) {
  if (!canRestartScheduledSession(session)) return false;
  if (hasLiveOwner) return false;
  const at = session.nextRunTime ? new Date(session.nextRunTime).getTime() : NaN;
  if (!Number.isFinite(at)) return false;
  return at <= now;
}

// Điều phối việc restart: dọn timer cũ, chốt điều kiện, rồi tạo ĐÚNG MỘT phiên
// mới từ phiên cũ. Trả về phiên mới (hoặc null nếu không được phép restart).
// Tách rời khỏi server.js để kiểm thử được bằng unit test với registry thật.
function restartScheduledSession(registry, sessionId, { createFreshSession, startSession }) {
  const old = registry.get(sessionId);
  if (!old) return null;
  registry.clearTimer(sessionId);
  if (!canRestartScheduledSession(old)) return null;
  const fresh = createFreshSession(old);
  if (!fresh) return null;
  // adopt() thu hồi phiên cũ (ngắt listener, nhả khóa, đóng browser) — đối tượng
  // cũ KHÔNG bao giờ được tái sử dụng.
  startSession(fresh);
  return fresh;
}

// Khôi phục state tích lũy (surplus + tiến độ ngày) sang một phiên mới. Dùng
// chung cho next-day restart / resume-sau-restart để surplus không bị mất.
function applyAutoScanRestoreState(session, restoreState = {}) {
  if (!session || !restoreState) return session;
  if (restoreState.dailyStudiedMinutes != null) session.dailyStudiedMinutes = restoreState.dailyStudiedMinutes;
  if (restoreState.dailyDate) session.dailyDate = restoreState.dailyDate;
  if (restoreState.courseProgress) session.courseProgress = restoreState.courseProgress;
  if (restoreState.surplusMode != null) session.surplusMode = restoreState.surplusMode === true;
  if (restoreState.surplusTargetMinutes != null) {
    session.surplusTargetMinutes = Math.max(15, Math.min(60, Number(restoreState.surplusTargetMinutes)));
  }
  if (restoreState.surplusStudiedMinutes != null) {
    session.surplusStudiedMinutes = Math.max(0, Number(restoreState.surplusStudiedMinutes) || 0);
  }
  if (Array.isArray(restoreState.surplusEligibleCourses)) {
    session.surplusEligibleCourses = [...new Set(restoreState.surplusEligibleCourses)];
  }
  if (restoreState.surplusExhausted != null) session.surplusExhausted = restoreState.surplusExhausted === true;
  if (restoreState.scheduledStartAt) session.options.scheduledStartAt = restoreState.scheduledStartAt;
  if (restoreState.scheduledStartDate) session.options.scheduledStartDate = restoreState.scheduledStartDate;
  return session;
}

module.exports = {
  isScheduledAutoScan,
  canRestartScheduledSession,
  isStaleScheduledSession,
  restartScheduledSession,
  applyAutoScanRestoreState,
};
