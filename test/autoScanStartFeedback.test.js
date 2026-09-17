const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const PANEL = path.join(ROOT, 'client', 'src', 'components', 'AutoScanPanel.jsx');

let modulePromise = null;
function loadFeedbackModule() {
  if (!modulePromise) {
    modulePromise = import(pathToFileURL(path.join(ROOT, 'src', 'autoscanStartFeedback.mjs')).href);
  }
  return modulePromise;
}

function typesOf(messages) {
  return messages.map(m => m.type);
}
function textOf(messages) {
  return messages.map(m => m.message).join('\n');
}

// 13 + 16 (Case A): 3 chọn / 3 start → success đúng.
test('Case A: 3 chọn, 3 start → một toast success', async () => {
  const { formatAutoScanStartFeedback } = await loadFeedbackModule();
  const data = {
    ok: true,
    result: 'all-started',
    started: [{ account: 'A' }, { account: 'B' }, { account: 'C' }],
    skipped: [],
    unresolved: [],
  };
  const { result, messages } = formatAutoScanStartFeedback(data);
  assert.equal(result, 'all-started');
  assert.deepEqual(typesOf(messages), ['success']);
  assert.match(messages[0].message, /khởi động Auto-Scan cho 3 tài khoản/);
});

// Case B: 2 start / 1 skip → partial đúng số lượng + lý do.
test('Case B: 2 start, 1 skip → success + warning partial', async () => {
  const { formatAutoScanStartFeedback } = await loadFeedbackModule();
  const data = {
    ok: true,
    result: 'partial',
    started: [{ account: 'A' }, { account: 'B' }],
    skipped: [{ account: 'Cao Thị Kim Anh', status: 'next-day', reason: 'đã có phiên Auto-Scan next-day' }],
    unresolved: [],
  };
  const { result, messages } = formatAutoScanStartFeedback(data);
  assert.equal(result, 'partial');
  assert.equal(typesOf(messages).includes('success'), true);
  assert.equal(typesOf(messages).includes('warning'), true);
  const text = textOf(messages);
  assert.match(text, /khởi động 2 tài khoản/);
  assert.match(text, /Cao Thị Kim Anh/);
  assert.match(text, /next-day/);
});

// Case C: 1 chọn / 0 start / 1 skip → KHÔNG được là success.
test('Case C: 0 start, 1 skip → warning, tuyệt đối không success', async () => {
  const { formatAutoScanStartFeedback } = await loadFeedbackModule();
  const data = {
    ok: true,
    result: 'none-started',
    started: [],
    skipped: [{ account: 'Cao Thị Kim Anh', status: 'next-day', reason: 'đã có phiên Auto-Scan next-day' }],
    unresolved: [],
  };
  const { result, messages } = formatAutoScanStartFeedback(data);
  assert.equal(result, 'none-started');
  assert.equal(typesOf(messages).includes('success'), false, 'không được có toast success khi 0 bắt đầu');
  assert.equal(typesOf(messages).includes('warning'), true);
  const text = textOf(messages);
  assert.match(text, /Không có tài khoản nào được khởi động/);
  assert.match(text, /Cao Thị Kim Anh/);
  assert.match(text, /next-day/);
});

// Case D: tài khoản không phân giải được → error tường minh.
test('Case D: tài khoản không tìm thấy → error có index/id', async () => {
  const { formatAutoScanStartFeedback } = await loadFeedbackModule();
  const data = { ok: true, result: 'none-started', started: [], skipped: [], unresolved: [7, 'abc'] };
  const { result, messages } = formatAutoScanStartFeedback(data);
  assert.equal(result, 'none-started');
  assert.equal(typesOf(messages).includes('success'), false);
  const text = textOf(messages);
  assert.match(text, /Không tìm thấy tài khoản đã chọn/);
  assert.match(text, /7/);
  assert.match(text, /abc/);
});

// Không bao giờ có success khi started rỗng, kể cả dữ liệu thiếu.
test('không có success khi started rỗng (dữ liệu biên)', async () => {
  const { formatAutoScanStartFeedback } = await loadFeedbackModule();
  for (const data of [{}, { started: [] }, { started: [], skipped: [], unresolved: [] }, { started: [], unresolved: ['9'] }]) {
    const { messages } = formatAutoScanStartFeedback(data);
    assert.equal(typesOf(messages).includes('success'), false, JSON.stringify(data));
  }
});

// Contract: component Dashboard phải dùng formatter chung, không tự nội suy
// data.started.length vào toast success (nguồn gốc lỗi "0 tài khoản").
test('AutoScanPanel dùng formatter và bỏ toast success cứng cho 0 tài khoản', () => {
  const source = fs.readFileSync(PANEL, 'utf8');
  assert.match(source, /formatAutoScanStartFeedback/);
  assert.equal(
    source.includes('Đã khởi động Auto-Scan cho ${data.started.length} tài khoản'),
    false,
    'vẫn còn toast success cứng phụ thuộc data.started.length',
  );
});
