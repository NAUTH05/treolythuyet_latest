const test = require('node:test');
const assert = require('node:assert/strict');
const { autoScanSnapshot, createAutoScanBroadcaster } = require('../autoScanBroadcast');

function makeSession({ email = 'anh@x.vn', name = 'Cao Thị Kim Anh', status = 'studying', account = undefined } = {}) {
  // `account` là object tài khoản thật của phiên; getStatus() trả tên từ chính nó
  // (giống AutoCourseSession.getStatus() thật).
  const resolvedAccount = account !== undefined ? account : { name, email, password: 'secret' };
  const displayName = resolvedAccount ? resolvedAccount.name : name;
  return {
    id: 's1',
    status,
    account: resolvedAccount,
    nextRunTime: null,
    completedAt: null,
    getStatus() {
      return { id: 's1', account: displayName, status, currentCourseIndex: 0, totalCourses: 0 };
    },
  };
}

test('payload Auto-Scan công khai có accountEmail để ghép phiên với tài khoản', () => {
  const snapshot = autoScanSnapshot(makeSession());
  assert.equal(snapshot.accountEmail, 'anh@x.vn');
  assert.equal(snapshot.account, 'Cao Thị Kim Anh');
});

test('payload Auto-Scan KHÔNG lộ mật khẩu tài khoản', () => {
  const snapshot = autoScanSnapshot(makeSession());
  assert.equal('password' in snapshot, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret/);
});

test('phiên khôi phục cũ thiếu email → accountEmail null, vẫn giữ tên để lùi về so tên', () => {
  const snapshot = autoScanSnapshot(makeSession({ account: { name: 'Tài khoản cũ' } }));
  assert.equal(snapshot.accountEmail, null);
  assert.equal(snapshot.account, 'Tài khoản cũ');
});

test('phiên thiếu hẳn account → không ném lỗi, accountEmail null', () => {
  const snapshot = autoScanSnapshot(makeSession({ account: null }));
  assert.equal(snapshot.accountEmail, null);
  assert.equal(snapshot.status, 'studying');
});

test('broadcaster (luồng live) và init dùng chung payload có accountEmail', () => {
  const emitted = [];
  const emit = createAutoScanBroadcaster({ emit: (event, payload) => emitted.push({ event, payload }) });
  const session = makeSession();
  const sent = emit(session);
  assert.equal(emitted[0].event, 'autoscan-status');
  assert.equal(emitted[0].payload.accountEmail, 'anh@x.vn');
  assert.deepEqual(sent, emitted[0].payload);
  assert.deepEqual(sent, autoScanSnapshot(session), 'init và live không được lệch nhau');
});
