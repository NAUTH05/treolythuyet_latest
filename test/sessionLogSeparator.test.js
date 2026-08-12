const test = require('node:test');
const assert = require('node:assert/strict');
const { BotSession } = require('../bot');
const { AutoCourseSession } = require('../autoCourseEngine');

const EXPECTED_SEPARATOR = '---------------------------------------------------------';

for (const [name, createSession] of [
  ['manual session', () => new BotSession('manual-1', { name: 'Test' }, ['https://example.com'])],
  ['auto-course session', () => new AutoCourseSession('auto-1', { name: 'Test' }, [])],
]) {
  test(`${name} emits exactly one separator before its logs`, () => {
    const session = createSession();
    const entries = [];
    session.on('log', entry => entries.push(entry));

    session._logSessionSeparator();
    session._logSessionSeparator();
    session.log('Đang đăng nhập...', 'info');

    assert.equal(entries.length, 2);
    assert.deepEqual(
      { msg: entries[0].msg, level: entries[0].level },
      { msg: EXPECTED_SEPARATOR, level: 'separator' }
    );
    assert.equal(entries[1].msg, 'Đang đăng nhập...');
  });
}
