const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeFirestoreFields, decodeFirestoreDocument } = require('../firebase-service');

function roundTrip(data) {
  return decodeFirestoreDocument({ fields: encodeFirestoreFields(data) });
}

test('nested object và array được lưu đúng cấu trúc Firestore, không stringify', () => {
  const fields = encodeFirestoreFields({
    account: { name: 'Nguyễn Văn A', email: 'a@x.vn' },
    courses: [{ id: 1, title: 'Bài 1' }, { id: 2, title: 'Bài 2' }],
  });

  assert.deepEqual(fields.account, {
    mapValue: { fields: { name: { stringValue: 'Nguyễn Văn A' }, email: { stringValue: 'a@x.vn' } } },
  });
  assert.equal(fields.courses.arrayValue.values.length, 2);
  assert.deepEqual(fields.courses.arrayValue.values[0], {
    mapValue: { fields: { id: { integerValue: '1' }, title: { stringValue: 'Bài 1' } } },
  });
});

test('null được giữ lại thay vì bị loại khỏi document', () => {
  const fields = encodeFirestoreFields({ nextRunTime: null, completedAt: null, pausedFromStatus: null });

  assert.deepEqual(fields, {
    nextRunTime: { nullValue: null },
    completedAt: { nullValue: null },
    pausedFromStatus: { nullValue: null },
  });
  assert.deepEqual(roundTrip({ nextRunTime: null }), { nextRunTime: null });
});

test('số nguyên giữ kiểu integer, số thực giữ kiểu double', () => {
  const fields = encodeFirestoreFields({ revision: 7, ratio: 1.5 });

  assert.deepEqual(fields.revision, { integerValue: '7' });
  assert.deepEqual(fields.ratio, { doubleValue: 1.5 });
  assert.deepEqual(roundTrip({ revision: 7, ratio: 1.5 }), { revision: 7, ratio: 1.5 });
});

test('chuỗi trông giống số hoặc boolean không bị đổi kiểu khi đọc về', () => {
  assert.deepEqual(roundTrip({ code: '123', flag: 'true' }), { code: '123', flag: 'true' });
});

test('mảng lồng mảng vẫn round-trip đúng dù Firestore không hỗ trợ trực tiếp', () => {
  const data = { matrix: [[1, 2], [3, 4]] };
  const fields = encodeFirestoreFields(data);

  // Phần tử con phải được bọc trong map, không phải arrayValue lồng arrayValue.
  assert.ok(fields.matrix.arrayValue.values[0].mapValue);
  assert.deepEqual(roundTrip(data), data);
});

test('state Auto-Scan phức hợp round-trip nguyên vẹn', () => {
  const state = {
    revision: 12,
    autoScans: [
      {
        id: 'abc',
        account: { name: 'user1', email: 'u1@x.vn' },
        status: 'studying',
        nextRunTime: null,
        completedAt: null,
        currentCourseIndex: 0,
        dailyStudiedMinutes: 45,
        courseProgress: { 'course-1': { done: true, minutes: 30.5 } },
        options: { headless: true, timeWindows: [{ from: '06:00', to: '22:00' }] },
      },
    ],
  };

  assert.deepEqual(roundTrip(state), state);
});

test('đọc được document cũ lưu object dưới dạng chuỗi JSON', () => {
  const legacy = { fields: { autoScans: { stringValue: JSON.stringify([{ id: 'a' }]) } } };

  assert.deepEqual(decodeFirestoreDocument(legacy), { autoScans: [{ id: 'a' }] });
});

test('document vượt ngân sách 1MB bị cắt bớt log cũ thay vì để Firestore từ chối', async t => {
  const originalFetch = global.fetch;
  const originalWarn = console.warn;
  t.after(() => { global.fetch = originalFetch; console.warn = originalWarn; });
  console.warn = () => {};

  let sentBody = null;
  global.fetch = async (_url, options) => {
    sentBody = JSON.parse(options.body);
    return { ok: true, status: 200 };
  };

  const { syncToFirebaseREST } = require('../firebase-service');
  const logs = Array.from({ length: 5000 }, (_, i) => ({
    timestamp: '22-08-2026 10:00:00',
    account: 'user1',
    level: 'info',
    msg: `Dòng log số ${i} `.repeat(12),
  }));

  await syncToFirebaseREST('system_logs_daily', '22-08-2026_user1', { date: '22-08-2026', logs }, {
    projectId: `budget-${process.pid}`,
    apiKey: 'key',
  });

  assert.ok(Buffer.byteLength(JSON.stringify(sentBody.fields), 'utf8') <= 950 * 1024);
  assert.deepEqual(sentBody.fields.truncated, { booleanValue: true });
  assert.ok(Number(sentBody.fields.omittedOldestCount.integerValue) > 0);
  // Cắt từ đầu mảng → log mới nhất phải còn lại.
  const kept = sentBody.fields.logs.arrayValue.values;
  assert.equal(kept[kept.length - 1].mapValue.fields.msg.stringValue, logs[logs.length - 1].msg);
});
