const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { AUTO_COURSE_STATUSES, SCHEDULED_STATUSES } = require('../autoCourseEngine');

const ROOT = path.join(__dirname, '..');
const PANEL = path.join(ROOT, 'client', 'src', 'components', 'AutoScanPanel.jsx');

function readPanel() {
  return fs.readFileSync(PANEL, 'utf8');
}

// Lấy tập khóa của một object literal khai báo dạng `const NAME = { ... }`
function objectKeys(source, name) {
  const start = source.indexOf(`const ${name} = {`);
  assert.notEqual(start, -1, `không tìm thấy ${name} trong AutoScanPanel.jsx`);
  const body = source.slice(start, source.indexOf('\n};', start));
  return new Set([...body.matchAll(/^\s*'?([a-z-]+)'?\s*:/gm)].map(m => m[1]));
}

// Lấy tập phần tử của `const NAME = new Set([...])`
function setMembers(source, name) {
  const match = source.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`));
  assert.notEqual(match, null, `không tìm thấy ${name} trong AutoScanPanel.jsx`);
  return new Set([...match[1].matchAll(/'([a-z-]+)'/g)].map(m => m[1]));
}

test('Dashboard hiểu được MỌI trạng thái mà engine có thể phát ra', () => {
  const known = objectKeys(readPanel(), 'AUTO_STATUS');
  const missing = AUTO_COURSE_STATUSES.filter(status => !known.has(status));
  assert.deepEqual(missing, [], `AutoScanPanel.jsx thiếu nhãn cho: ${missing.join(', ')}`);
});

test('mọi trạng thái hẹn giờ đều được Dashboard xếp vào nhóm "đã hẹn lịch"', () => {
  // Thiếu một trạng thái ở đây là thẻ mất nút Dừng, mất dòng "Tự chạy lại"
  // và hiện thêm nút Xóa — trông như phiên đã chết dù backend vẫn đang hẹn giờ.
  const source = readPanel();
  const scheduled = setMembers(source, 'SCHEDULED_STATUSES');
  for (const status of SCHEDULED_STATUSES) {
    assert.equal(scheduled.has(status), true, `SCHEDULED_STATUSES của Dashboard thiếu '${status}'`);
  }
});

test('một trạng thái không thể vừa là "đang hoạt động" vừa là "đã kết thúc"', () => {
  const source = readPanel();
  const active = setMembers(source, 'ACTIVE_STATUSES');
  const scheduled = setMembers(source, 'SCHEDULED_STATUSES');
  const done = setMembers(source, 'DONE_STATUSES');
  for (const status of [...active, ...scheduled]) {
    assert.equal(done.has(status), false, `'${status}' bị xếp vào cả nhóm đang chạy và nhóm kết thúc`);
  }
});

// Hai cây frontend (src/ và client/src/) từng lệch nhau: bản vá 'next-day' chỉ
// vào src/ trong khi npm run build chỉ biên dịch client/src/ → Dashboard đang
// chạy không hiểu trạng thái mới. Test này chặn đúng lớp lỗi đó tái diễn.
test('src/ và client/src/ không được lệch nhau', () => {
  const walk = (dir, base = dir, out = new Map()) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, base, out);
      else out.set(path.relative(base, full).replace(/\\/g, '/'), fs.readFileSync(full, 'utf8'));
    }
    return out;
  };

  const rootTree = walk(path.join(ROOT, 'src'));
  const clientTree = walk(path.join(ROOT, 'client', 'src'));

  assert.deepEqual([...rootTree.keys()].sort(), [...clientTree.keys()].sort(), 'danh sách file hai cây khác nhau');
  const drifted = [...rootTree.entries()].filter(([file, content]) => clientTree.get(file) !== content).map(([file]) => file);
  assert.deepEqual(drifted, [], `nội dung lệch nhau: ${drifted.join(', ')}`);
});

test('bundle đang chạy trong public/ đã biết mọi trạng thái Auto-Scan', () => {
  const assetsDir = path.join(ROOT, 'public', 'assets');
  if (!fs.existsSync(assetsDir)) return; // chưa build lần nào → bỏ qua
  const bundles = fs.readdirSync(assetsDir).filter(f => f.endsWith('.js'));
  if (bundles.length === 0) return;

  const code = bundles.map(f => fs.readFileSync(path.join(assetsDir, f), 'utf8')).join('\n');
  const missing = AUTO_COURSE_STATUSES.filter(status => !code.includes(`"${status}"`) && !code.includes(`'${status}'`));
  assert.deepEqual(missing, [], `bundle trong public/ thiếu: ${missing.join(', ')} — cần chạy "npm run build"`);
});
