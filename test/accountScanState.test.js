const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const MODULE = path.join(ROOT, 'src', 'accountCompletion.mjs');

let modulePromise = null;
function load() {
  if (!modulePromise) modulePromise = import(pathToFileURL(MODULE).href);
  return modulePromise;
}

const ACCOUNT = { index: 1, name: 'Cao Thị Kim Anh', email: 'anh@x.vn' };

function scan(overrides = {}) {
  return {
    id: 's1',
    account: ACCOUNT.name,
    accountEmail: ACCOUNT.email,
    status: 'studying',
    ...overrides,
  };
}

// ── Trạng thái hiển thị ──

test('tài khoản không có completed → chưa hoàn thành', async () => {
  const { accountScanState, ACCOUNT_STATE_INCOMPLETE } = await load();
  assert.equal(accountScanState(ACCOUNT, []), ACCOUNT_STATE_INCOMPLETE);
  assert.equal(accountScanState({ ...ACCOUNT, completed: false }, []), ACCOUNT_STATE_INCOMPLETE);
});

test('tài khoản đã đánh dấu hoàn thành → hoàn thành (kể cả khi không có phiên nào)', async () => {
  const { accountScanState, ACCOUNT_STATE_COMPLETED } = await load();
  assert.equal(accountScanState({ ...ACCOUNT, completed: true }, []), ACCOUNT_STATE_COMPLETED);
  assert.equal(accountScanState({ ...ACCOUNT, completed: true }, null), ACCOUNT_STATE_COMPLETED);
});

test('đang học / tạm dừng / chờ lịch → đang học', async () => {
  const { accountScanState, ACCOUNT_STATE_ACTIVE } = await load();
  for (const status of ['studying', 'scanning', 'logging-in', 'idle', 'surplus-study', 'paused', 'scheduled-start', 'next-day', 'daily-limit', 'date-limit', 'time-window', 'discovery-retry']) {
    assert.equal(
      accountScanState(ACCOUNT, [scan({ status })]),
      ACCOUNT_STATE_ACTIVE,
      `trạng thái '${status}' phải là đang học/đã lên lịch`
    );
  }
});

test('phiên đã kết thúc (completed/stopped/error) KHÔNG tự thành "hoàn thành"', async () => {
  const { accountScanState, ACCOUNT_STATE_INCOMPLETE } = await load();
  for (const status of ['completed', 'stopped', 'error']) {
    assert.equal(
      accountScanState(ACCOUNT, [scan({ status })]),
      ACCOUNT_STATE_INCOMPLETE,
      `'${status}' là phiên đã kết thúc — cờ hoàn thành phải do admin đặt`
    );
  }
});

test('ưu tiên: hoàn thành thủ công > đang học > chưa hoàn thành', async () => {
  const { accountScanState, ACCOUNT_STATE_COMPLETED } = await load();
  assert.equal(
    accountScanState({ ...ACCOUNT, completed: true }, [scan({ status: 'studying' })]),
    ACCOUNT_STATE_COMPLETED
  );
});

// ── Ghép phiên với tài khoản ──

test('ghép theo email hoạt động dù tên hiển thị đã đổi', async () => {
  const { matchAutoScan, accountScanState, ACCOUNT_STATE_ACTIVE } = await load();
  const renamed = { ...ACCOUNT, name: 'Tên Mới' };
  assert.equal(matchAutoScan(renamed, [scan()]).id, 's1');
  assert.equal(accountScanState(renamed, [scan()]), ACCOUNT_STATE_ACTIVE);
});

test('email so khớp không phân biệt hoa/thường và khoảng trắng', async () => {
  const { matchAutoScan } = await load();
  assert.equal(matchAutoScan(ACCOUNT, [scan({ accountEmail: '  ANH@X.VN ' })]).id, 's1');
});

test('payload cũ không có accountEmail → lùi về so tên', async () => {
  const { matchAutoScan, accountScanState, ACCOUNT_STATE_ACTIVE } = await load();
  const legacyScan = { id: 'old', account: ACCOUNT.name, status: 'studying' };
  assert.equal(matchAutoScan(ACCOUNT, [legacyScan]).id, 'old');
  assert.equal(accountScanState(ACCOUNT, [legacyScan]), ACCOUNT_STATE_ACTIVE);
});

test('KHÔNG so tên khi phiên đã có email khác (tránh gán nhầm hai tài khoản trùng tên)', async () => {
  const { matchAutoScan, accountScanState, ACCOUNT_STATE_INCOMPLETE } = await load();
  const other = scan({ id: 'other', accountEmail: 'khac@x.vn', account: ACCOUNT.name });
  assert.equal(matchAutoScan(ACCOUNT, [other]), null);
  assert.equal(accountScanState(ACCOUNT, [other]), ACCOUNT_STATE_INCOMPLETE);
});

test('nhiều phiên: mỗi tài khoản nhận đúng phiên của mình', async () => {
  const { accountScanState, ACCOUNT_STATE_ACTIVE, ACCOUNT_STATE_INCOMPLETE } = await load();
  const scans = [
    scan({ id: 'a', accountEmail: 'anh@x.vn', account: 'Anh', status: 'studying' }),
    scan({ id: 'b', accountEmail: 'binh@x.vn', account: 'Bình', status: 'stopped' }),
  ];
  assert.equal(accountScanState(ACCOUNT, scans), ACCOUNT_STATE_ACTIVE);
  assert.equal(accountScanState({ index: 2, name: 'Bình', email: 'binh@x.vn' }, scans), ACCOUNT_STATE_INCOMPLETE);
  assert.equal(accountScanState({ index: 3, name: 'Cường', email: 'cuong@x.vn' }, scans), ACCOUNT_STATE_INCOMPLETE);
});

// ── Ba trạng thái phải KHÁC NHAU về mặt hiển thị ──

test('ba trạng thái có nhãn, class CSS và ký hiệu khác nhau', async () => {
  const {
    accountStateLabel, accountStateClass, accountStateMark,
    ACCOUNT_STATE_COMPLETED, ACCOUNT_STATE_ACTIVE, ACCOUNT_STATE_INCOMPLETE,
  } = await load();
  const states = [ACCOUNT_STATE_COMPLETED, ACCOUNT_STATE_ACTIVE, ACCOUNT_STATE_INCOMPLETE];
  const labels = states.map(accountStateLabel);
  const classes = states.map(accountStateClass);
  const marks = states.map(accountStateMark);
  assert.deepEqual(labels, ['✓ Hoàn thành', '● Đang học / đã lên lịch', '○ Chưa hoàn thành']);
  assert.deepEqual(classes, ['chip-completed', 'chip-learning', 'chip-incomplete']);
  assert.deepEqual(marks, ['✓', '●', '○']);
  assert.equal(new Set(classes).size, 3);
});

test('trạng thái lạ luôn lùi về "chưa hoàn thành" thay vì vỡ UI', async () => {
  const { accountStateLabel, accountStateClass, accountStateMark } = await load();
  assert.equal(accountStateLabel('nonsense'), '○ Chưa hoàn thành');
  assert.equal(accountStateClass('nonsense'), 'chip-incomplete');
  assert.equal(accountStateMark('nonsense'), '○');
});

// ── Hợp đồng UI: chip phải hiển thị trạng thái và giữ trạng thái đang chọn ──

test('AutoScanPanel dùng trạng thái tài khoản trên chip và không tự chọn sẵn', () => {
  const panel = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'AutoScanPanel.jsx'), 'utf8');
  assert.match(panel, /accountScanState\(acc, scanList\)/);
  assert.match(panel, /accountStateClass\(state\)/);
  assert.match(panel, /accountStateMark\(state\)/);
  // Trạng thái đang chọn vẫn được gắn class 'selected' cùng class trạng thái.
  assert.match(panel, /className=\{`chip \$\{accountStateClass\(state\)\} \$\{isSelected \? 'selected' : ''\}`\}/);
  // Không tự động chọn tài khoản nào (mặc định là Set rỗng).
  assert.match(panel, /useState\(new Set\(\)\)/);
  // Không khoá/chặn tài khoản đã hoàn thành.
  assert.doesNotMatch(panel, /disabled=\{state === ACCOUNT_STATE_COMPLETED\}/);
});

test('AccountPanel có nút đặt cờ hoàn thành thủ công và khoá trong lúc lưu', () => {
  const panel = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'AccountPanel.jsx'), 'utf8');
  assert.match(panel, /api\.updateAccount\(account\.index, \{ completed: nextCompleted \}\)/);
  assert.match(panel, /disabled=\{saving\}/);
  assert.match(panel, /Đang lưu\.\.\./);
  assert.match(panel, /account-item-completed/);
});
