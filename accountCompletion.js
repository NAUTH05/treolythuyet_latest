// ============================================================
//  ACCOUNT COMPLETION (hàm thuần — dùng chung cho server + test)
// ============================================================
// `completed` là cờ do ADMIN bật/tắt THỦ CÔNG, lưu ngay trong document
// `system_accounts/list` (cùng chỗ với name/email/password). Vì vậy nó đi theo
// đúng cơ chế SerializedStateSync + Firebase sẵn có — KHÔNG có nguồn chân lý thứ
// hai, không file JSON riêng, không collection riêng.
//
// Quy ước tương thích ngược: tài khoản cũ (document chưa từng có trường này)
// được coi là `completed: false`. Server chỉ ghi cờ khi client gửi lên một giá
// trị boolean thật.

// Tài khoản đã hoàn thành? (mọi giá trị không phải `true` → chưa hoàn thành)
function isAccountCompleted(account) {
  return Boolean(account) && account.completed === true;
}

// Trạng thái hoàn thành đã chuẩn hoá để trả ra API.
// - Chưa hoàn thành → completedAt luôn là null (không lộ timestamp mồ côi).
function accountCompletionState(account) {
  const completed = isAccountCompleted(account);
  return {
    completed,
    completedAt: completed ? (account.completedAt || null) : null,
  };
}

// Bản ghi tài khoản mới: mặc định CHƯA hoàn thành.
function newAccountRecord({ name, email, password }) {
  return { name, email, password, completed: false, completedAt: null };
}

// Áp dụng thao tác đặt cờ hoàn thành thủ công.
// - Chỉ thay đổi khi `completed` là boolean thật (giá trị khác bị bỏ qua hoàn toàn).
// - Bật hoàn thành → ghi `completedAt` ISO hiện tại, nhưng giữ nguyên mốc cũ nếu
//   tài khoản đã hoàn thành sẵn (bấm lại không làm nhảy timestamp).
// - Tắt hoàn thành → đặt `completedAt = null`.
// - Không đụng tới name/email/password hay bất kỳ trường nào khác.
function applyCompletionUpdate(account, completed, now = new Date()) {
  if (typeof completed !== 'boolean') return account;
  if (completed) {
    const existingStamp = account.completed === true ? (account.completedAt || null) : null;
    account.completed = true;
    account.completedAt = existingStamp || now.toISOString();
  } else {
    account.completed = false;
    account.completedAt = null;
  }
  return account;
}

module.exports = {
  isAccountCompleted,
  accountCompletionState,
  newAccountRecord,
  applyCompletionUpdate,
};
