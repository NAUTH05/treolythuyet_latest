// Chuyển kết quả POST /api/auto-scan/start thành các toast hiển thị.
// Tách khỏi component React để có thể unit-test bằng Node (dynamic import).
//
// BẤT BIẾN: started.length === 0 KHÔNG BAO GIỜ được hiện như thành công.
export const AUTO_SCAN_START_RESULTS = {
  ALL_STARTED: 'all-started',
  PARTIAL: 'partial',
  NONE_STARTED: 'none-started',
};

function skipLabel(item) {
  return item && (item.account || item.sessionId) ? (item.account || item.sessionId) : 'tài khoản';
}

function skipReason(item) {
  return (item && item.reason) ? item.reason : 'đã có phiên Auto-Scan';
}

export function formatAutoScanStartFeedback(data = {}) {
  const started = Array.isArray(data.started) ? data.started : [];
  const skipped = Array.isArray(data.skipped) ? data.skipped : [];
  const unresolved = Array.isArray(data.unresolved) ? data.unresolved : [];
  const messages = [];

  if (started.length > 0) {
    if (skipped.length === 0 && unresolved.length === 0) {
      messages.push({
        type: 'success',
        message: `✅ Đã khởi động Auto-Scan cho ${started.length} tài khoản`,
      });
    } else {
      messages.push({
        type: 'success',
        message: `✅ Đã khởi động ${started.length} tài khoản`,
      });
      for (const item of skipped) {
        messages.push({
          type: 'warning',
          message: `⚠️ Bỏ qua ${skipLabel(item)}: ${skipReason(item)}`,
        });
      }
      for (const id of unresolved) {
        messages.push({
          type: 'error',
          message: `❌ Không tìm thấy tài khoản đã chọn: ${id}`,
        });
      }
    }
    return {
      result: data.result || (skipped.length || unresolved.length ? AUTO_SCAN_START_RESULTS.PARTIAL : AUTO_SCAN_START_RESULTS.ALL_STARTED),
      messages,
    };
  }

  if (skipped.length > 0) {
    const detail = skipped
      .map(item => `${skipLabel(item)} — ${skipReason(item)}`)
      .join('; ');
    messages.push({
      type: 'warning',
      message: `⚠️ Không có tài khoản nào được khởi động. ${detail}`,
    });
  }

  for (const id of unresolved) {
    messages.push({
      type: 'error',
      message: `❌ Không tìm thấy tài khoản đã chọn: ${id}`,
    });
  }

  if (skipped.length === 0 && unresolved.length === 0) {
    messages.push({
      type: 'warning',
      message: '⚠️ Không có tài khoản nào được khởi động',
    });
  }

  return { result: AUTO_SCAN_START_RESULTS.NONE_STARTED, messages };
}
