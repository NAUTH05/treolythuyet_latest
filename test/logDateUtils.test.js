const test = require('node:test');
const assert = require('node:assert/strict');
const {
  vnDateStr,
  vnDateDDMMYYYY,
  formatToDDMMYYYY,
  filterLogsForDate,
} = require('../logDateUtils');

test('định dạng ngày Việt Nam ổn định, không phụ thuộc format mặc định của locale', () => {
  const instant = new Date('2026-08-08T17:30:00.000Z'); // 00:30 ngày 09/08 tại VN
  assert.equal(vnDateStr(instant), '2026-08-09');
  assert.equal(vnDateDDMMYYYY(instant), '09-08-2026');
});

test('lọc bỏ log ngày hôm trước khỏi API ngày hôm nay', () => {
  const logs = [
    { date: '08-08-2026', msg: 'hôm qua' },
    { date: '2026-08-09', msg: 'hôm nay dạng ISO' },
    { date: '09-08-2026', msg: 'hôm nay' },
  ];
  assert.deepEqual(
    filterLogsForDate(logs, '09-08-2026').map(item => item.msg),
    ['hôm nay dạng ISO', 'hôm nay']
  );
  assert.equal(formatToDDMMYYYY('../../etc/passwd'), '');
});
