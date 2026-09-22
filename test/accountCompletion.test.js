const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  isAccountCompleted,
  accountCompletionState,
  newAccountRecord,
  applyCompletionUpdate,
} = require('../accountCompletion');

const ROOT = path.join(__dirname, '..');

// ── Trạng thái hoàn thành (nguồn chân lý: account.completed) ──

test('tài khoản không có trường completed được coi là CHƯA hoàn thành', () => {
  const legacy = { name: 'Nguyễn Văn A', email: 'a@x.vn', password: 'secret' };
  assert.equal(isAccountCompleted(legacy), false);
  assert.deepEqual(accountCompletionState(legacy), { completed: false, completedAt: null });
});

test('chỉ boolean true mới là hoàn thành (chuỗi "true", 1, {} đều không)', () => {
  assert.equal(isAccountCompleted({ completed: 'true' }), false);
  assert.equal(isAccountCompleted({ completed: 1 }), false);
  assert.equal(isAccountCompleted({ completed: {} }), false);
  assert.equal(isAccountCompleted({ completed: true }), true);
  assert.equal(isAccountCompleted(null), false);
});

test('tài khoản mới mặc định chưa hoàn thành và không có mốc thời gian', () => {
  assert.deepEqual(newAccountRecord({ name: 'B', email: 'b@x.vn', password: 'p' }), {
    name: 'B',
    email: 'b@x.vn',
    password: 'p',
    completed: false,
    completedAt: null,
  });
});

test('đặt completed: true ghi lại giá trị và mốc ISO thời gian', () => {
  const account = { name: 'A', email: 'a@x.vn', password: 'p' };
  const now = new Date('2026-09-22T07:30:00.000Z');
  applyCompletionUpdate(account, true, now);
  assert.equal(account.completed, true);
  assert.equal(account.completedAt, '2026-09-22T07:30:00.000Z');
});

test('đặt completed: false xoá completedAt', () => {
  const account = { name: 'A', email: 'a@x.vn', password: 'p', completed: true, completedAt: '2026-09-22T07:30:00.000Z' };
  applyCompletionUpdate(account, false);
  assert.equal(account.completed, false);
  assert.equal(account.completedAt, null);
});

test('bật lại hoàn thành khi đã hoàn thành KHÔNG làm nhảy mốc thời gian cũ', () => {
  const account = { name: 'A', email: 'a@x.vn', password: 'p', completed: true, completedAt: '2026-01-01T00:00:00.000Z' };
  applyCompletionUpdate(account, true, new Date('2026-09-22T07:30:00.000Z'));
  assert.equal(account.completedAt, '2026-01-01T00:00:00.000Z');
});

test('giá trị không phải boolean bị bỏ qua hoàn toàn (không xoá cờ)', () => {
  for (const bad of [undefined, null, 'true', 'false', 1, 0, {}, []]) {
    const account = { name: 'A', email: 'a@x.vn', password: 'p', completed: true, completedAt: '2026-01-01T00:00:00.000Z' };
    applyCompletionUpdate(account, bad);
    assert.equal(account.completed, true, `giá trị ${JSON.stringify(bad)} không được phép đổi cờ`);
    assert.equal(account.completedAt, '2026-01-01T00:00:00.000Z');
  }
});

test('bật/tắt hoàn thành KHÔNG đụng tới name, email hay password', () => {
  const account = { name: 'Cao Thị Kim Anh', email: 'anh@x.vn', password: 'MatKhau123' };
  applyCompletionUpdate(account, true);
  applyCompletionUpdate(account, false);
  applyCompletionUpdate(account, true);
  assert.equal(account.name, 'Cao Thị Kim Anh');
  assert.equal(account.email, 'anh@x.vn');
  assert.equal(account.password, 'MatKhau123');
});

test('accountCompletionState không lộ mốc thời gian mồ côi khi chưa hoàn thành', () => {
  assert.deepEqual(
    accountCompletionState({ completed: false, completedAt: '2026-01-01T00:00:00.000Z' }),
    { completed: false, completedAt: null }
  );
  assert.deepEqual(
    accountCompletionState({ completed: true, completedAt: '2026-01-01T00:00:00.000Z' }),
    { completed: true, completedAt: '2026-01-01T00:00:00.000Z' }
  );
});

// ── Hợp đồng API tài khoản (kiểm tra trên nguồn server.js) ──
// server.js khởi động HTTP server khi được require nên không import trực tiếp
// được; các test dưới đây khoá đúng hợp đồng của 3 route bằng nguồn.

function accountRoute(method, nextMarker) {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = server.indexOf(`app.${method}('/api/accounts`);
  assert.notEqual(start, -1, `không tìm thấy route ${method} /api/accounts`);
  const end = nextMarker ? server.indexOf(nextMarker, start) : server.length;
  assert.ok(end > start, `không xác định được cuối route ${method}`);
  return server.slice(start, end);
}

test('GET /api/accounts trả về completed + completedAt và vẫn ẩn password', () => {
  const route = accountRoute('get', "app.post('/api/accounts'");
  assert.match(route, /hasPassword/);
  assert.match(route, /accountCompletionState\(a\)/);
  assert.doesNotMatch(route, /password:\s*a\.password|res\.json\(accounts\)/);
});

test('POST /api/accounts tạo tài khoản mới ở trạng thái chưa hoàn thành', () => {
  const route = accountRoute('post', "app.delete('/api/accounts");
  assert.match(route, /newAccountRecord\(/);
  assert.doesNotMatch(route, /accounts\.push\(\{\s*name/);
});

test('PUT /api/accounts/:index nhận boolean completed qua applyCompletionUpdate', () => {
  const route = accountRoute('put', "app.get('/api/sessions'");
  assert.match(route, /const \{[^}]*completed[^}]*\} = req\.body/);
  assert.match(route, /applyCompletionUpdate\(accounts\[idx\], completed\)/);
  // Các trường cũ vẫn giữ nguyên hành vi.
  assert.match(route, /if \(name\) accounts\[idx\]\.name = name;/);
  assert.match(route, /if \(email\) accounts\[idx\]\.email = email;/);
  assert.match(route, /if \(password\) accounts\[idx\]\.password = password;/);
});

test('không có nguồn chân lý thứ hai: không thêm file/collection cho cờ hoàn thành', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.doesNotMatch(server, /completed-accounts\.json|accountCompletion\.json|system_account_completion/);
  // Cờ hoàn thành đi cùng document tài khoản sẵn có.
  assert.match(server, /accountsStateSync = new SerializedStateSync\(\{[\s\S]*?collection: 'system_accounts', documentId: 'list'/);
});
