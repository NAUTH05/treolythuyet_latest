const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { AutoCourseRegistry } = require('../autoCourseRegistry');

// Phiên giả lập đủ bề mặt mà registry cần: id, account, stop(), listener, và
// ownsAccountSession() (true khi đang thực sự giữ phiên đăng nhập Odoo).
class FakeSession extends EventEmitter {
  constructor(id, email = 'a@x.vn', owns = false) {
    super();
    this.id = id;
    this.account = { name: id, email };
    this.stopCalls = 0;
    this._owns = owns;
  }
  ownsAccountSession() { return this._owns; }
  async stop() { this.stopCalls++; this._owns = false; }
}

test('mỗi phiên nhận một ID riêng dù được tạo trong cùng một milisecond', () => {
  const reg = new AutoCourseRegistry();
  const a = reg.nextSessionId('acc1', 1_700_000_000_000);
  const b = reg.nextSessionId('acc1', 1_700_000_000_000);
  assert.notEqual(a, b);
});

test('phiên mới cùng ID thu hồi phiên cũ: đóng browser, ngắt listener, hết là phiên chính', async () => {
  const reg = new AutoCourseRegistry();
  const old = new FakeSession('s1');
  const fresh = new FakeSession('s1');
  let oldEmitsSeen = 0;
  old.on('status', () => { oldEmitsSeen++; });

  reg.adopt(old);
  reg.adopt(fresh);

  assert.equal(reg.isCurrent(fresh), true);
  assert.equal(reg.isCurrent(old), false, 'phiên cũ không còn là chủ của ID');
  assert.equal(reg.size, 1, 'không được sinh thêm thẻ trên Dashboard');

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(old.stopCalls, 1, 'phiên cũ phải bị đóng, không được chạy nền mồ côi');

  old.emit('status', { id: 's1', status: 'studying' });
  assert.equal(oldEmitsSeen, 0, 'listener của phiên cũ phải bị ngắt');
});

test('emit muộn của phiên đã bị thay thế không được coi là trạng thái thật', () => {
  const reg = new AutoCourseRegistry();
  const old = new FakeSession('s1');
  reg.adopt(old);
  const fresh = new FakeSession('s1');
  reg.adopt(fresh);

  // Guard mà server dùng trong listener 'status' — so theo danh tính, không theo ID.
  assert.equal(reg.isCurrent(old), false);
  assert.equal(reg.has('s1'), true, 'ID vẫn tồn tại nên guard theo has(id) sẽ cho qua sai');
});

test('hai phiên chưa khởi động của cùng tài khoản KHÔNG chặn lẫn nhau (chống deadlock)', () => {
  const reg = new AutoCourseRegistry();
  const a = new FakeSession('s1', 'same@x.vn', false);
  const b = new FakeSession('s2', 'same@x.vn', false);
  reg.adopt(a);
  reg.adopt(b);

  // Trước khi ai giành khóa: không phiên nào bị chặn → không đứng chờ vĩnh viễn.
  assert.equal(reg.whoBlocks('same@x.vn', a), null);
  assert.equal(reg.whoBlocks('same@x.vn', b), null);
});

test('đúng một phiên giành được tài khoản; phiên còn lại chờ rồi chạy sau khi khóa được nhả', () => {
  const reg = new AutoCourseRegistry();
  const a = new FakeSession('s1', 'same@x.vn');
  const b = new FakeSession('s2', 'same@x.vn');
  reg.adopt(a);
  reg.adopt(b);

  assert.equal(reg.claimAccount('same@x.vn', a), true, 'phiên đầu tiên thắng');
  assert.equal(reg.claimAccount('same@x.vn', b), false, 'phiên thứ hai không được mở browser thứ hai');
  assert.equal(reg.whoBlocks('same@x.vn', b), a);

  reg.releaseAccount(a);
  assert.equal(reg.claimAccount('same@x.vn', b), true, 'khóa nhả xong thì phiên chờ được chạy');
});

test('phiên đang chạy/tạm dừng chặn tài khoản ngay cả khi khóa chưa được ghi (sau server restart)', () => {
  const reg = new AutoCourseRegistry();
  const paused = new FakeSession('s1', 'same@x.vn', true); // khôi phục ở trạng thái paused
  const fresh = new FakeSession('s2', 'same@x.vn', false);
  reg.adopt(paused);
  reg.adopt(fresh);

  assert.equal(reg.whoBlocks('same@x.vn', fresh), paused);
  assert.equal(reg.claimAccount('same@x.vn', fresh), false);
});

test('khóa của phiên đã bị thay thế tự mục — không giữ tài khoản vĩnh viễn', () => {
  const reg = new AutoCourseRegistry();
  const old = new FakeSession('s1', 'same@x.vn');
  reg.adopt(old);
  reg.claimAccount('same@x.vn', old);

  const fresh = new FakeSession('s1', 'same@x.vn'); // cùng ID → thay thế phiên cũ
  reg.adopt(fresh);

  assert.equal(reg.claimAccount('same@x.vn', fresh), true);
  assert.equal(reg.accountOwner('same@x.vn'), fresh);
});

test('nhả khóa theo danh tính: phiên cũ kết thúc muộn không cướp khóa của phiên mới', () => {
  const reg = new AutoCourseRegistry();
  const old = new FakeSession('s1', 'same@x.vn');
  const fresh = new FakeSession('s2', 'same@x.vn');
  reg.adopt(old);
  reg.adopt(fresh);
  reg.claimAccount('same@x.vn', old);
  reg.releaseAccount(old);
  reg.claimAccount('same@x.vn', fresh);

  reg.releaseAccount(old); // .finally() của phiên cũ chạy muộn
  assert.equal(reg.accountOwner('same@x.vn'), fresh, 'khóa của phiên mới phải còn nguyên');
});

test('mỗi sessionId chỉ có duy nhất 1 timer — hẹn lại thì timer cũ bị hủy', async () => {
  const reg = new AutoCourseRegistry();
  let fired = 0;
  // Registry luôn giữ sàn 1s cho mọi lịch hẹn (không cho chạy lại tức thì).
  reg.setTimer('s1', Date.now() + 10, () => { fired++; });
  reg.setTimer('s1', Date.now() + 10, () => { fired++; });
  assert.equal(reg.hasTimer('s1'), true);

  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(fired, 1, 'không được chạy lại 2 lần vì hẹn giờ trùng');
  assert.equal(reg.hasTimer('s1'), false);
});

test('forget() hủy timer, ngắt listener và đóng browser', async () => {
  const reg = new AutoCourseRegistry();
  const session = new FakeSession('s1');
  let fired = 0;
  let logsSeen = 0;
  session.on('log', () => { logsSeen++; });
  reg.adopt(session);
  reg.claimAccount(session.account.email, session);
  reg.setTimer('s1', Date.now() + 20, () => { fired++; });

  await reg.forget('s1');

  assert.equal(reg.size, 0);
  assert.equal(session.stopCalls, 1);
  assert.equal(reg.accountOwner(session.account.email), null, 'phải nhả khóa tài khoản');
  session.emit('log', { msg: 'muộn' });
  assert.equal(logsSeen, 0, 'ngắt TẤT CẢ listener, không chỉ riêng status');

  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(fired, 0, 'timer của phiên đã xóa không được kích hoạt');
});

test('lịch hẹn xa vẫn chờ, không chạy sớm (chia bước 12h)', async () => {
  const reg = new AutoCourseRegistry();
  let fired = 0;
  reg.setTimer('s1', Date.now() + 40 * 24 * 60 * 60 * 1000, () => { fired++; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(fired, 0);
  assert.equal(reg.hasTimer('s1'), true);
  reg.clearAllTimers();
  assert.equal(reg.hasTimer('s1'), false);
});
