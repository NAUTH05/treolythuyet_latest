// ============================================================
//  AUTO-SCAN BROADCAST
//  Một nguồn duy nhất cho payload Socket.IO của một phiên Auto-Scan.
//  Trước đây mỗi chỗ tự ghép `{ ...getStatus(), nextRunTime, completedAt }`
//  (có chỗ thiếu completedAt, có chỗ thiếu nextRunTime) → Dashboard lệch nhau
//  giữa luồng live và lần `init` khi reconnect. Mọi nơi phải dùng chung helper
//  này để `autoscan-status` và `init` luôn cùng một shape.
// ============================================================

// Snapshot chuẩn của một phiên để gửi ra client. `getStatus()` là nguồn chân lý
// của engine; chỉ bổ sung các trường vòng đời nằm ngoài engine.
function autoScanSnapshot(session) {
  if (!session || typeof session.getStatus !== 'function') return null;
  return {
    ...session.getStatus(),
    nextRunTime: session.nextRunTime || null,
    completedAt: session.completedAt || null,
  };
}

// Tạo broadcaster gắn với một io. Trả về emit(session) → snapshot đã gửi.
function createAutoScanBroadcaster(io) {
  return function emitAutoScanStatus(session) {
    const snapshot = autoScanSnapshot(session);
    if (snapshot && io && typeof io.emit === 'function') {
      io.emit('autoscan-status', snapshot);
    }
    return snapshot;
  };
}

module.exports = { autoScanSnapshot, createAutoScanBroadcaster };
