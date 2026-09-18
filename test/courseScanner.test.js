const test = require('node:test');
const assert = require('node:assert/strict');
const { scanCourseDetails, scanMyCoursesCompletion } = require('../courseScanner');

// ── Fake DOM tối giản: đủ để chạy detect cấp khóa trong page.evaluate ──

function matchSimple(node, sel) {
  sel = String(sel || '').trim();
  if (!sel) return false;
  const tagMatch = sel.match(/^([a-zA-Z][a-zA-Z0-9]*)/);
  let rest = sel;
  if (tagMatch) {
    if (node.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
    rest = sel.slice(tagMatch[1].length);
  }
  for (const m of rest.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
    if (!String(node.className || '').split(/\s+/).includes(m[1])) return false;
  }
  for (const m of rest.matchAll(/\[([a-zA-Z0-9_-]+)(?:([*^$]?=)"([^"]*)")?\]/g)) {
    const [, name, op, value] = m;
    const actual = name === 'class' ? String(node.className || '') : node.getAttribute(name);
    if (actual == null) return false;
    if (op === '*=' && value != null && !String(actual).includes(value)) return false;
    if (op === '=' && value != null && String(actual) !== value) return false;
  }
  return true;
}

function matches(node, selector) {
  return String(selector || '').split(',').some(part => {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return false;
    if (tokens.length === 1) return matchSimple(node, tokens[0]);
    if (!matchSimple(node, tokens[tokens.length - 1])) return false;
    let idx = tokens.length - 2;
    let ancestor = node.parent;
    while (ancestor && idx >= 0) {
      if (matchSimple(ancestor, tokens[idx])) idx--;
      ancestor = ancestor.parent;
    }
    return idx < 0;
  });
}

class FakeNode {
  constructor(opts = {}) {
    this.tagName = String(opts.tagName || 'div').toUpperCase();
    this.className = opts.className || '';
    this._text = opts.textContent || '';
    this.attrs = opts.attrs || {};
    this.style = opts.style || {};
    this.children = [];
    this.parent = null;
    for (const child of opts.children || []) this.append(child);
  }

  // textContent thật của DOM gộp cả con — fake cũng vậy khi không set tường minh.
  get textContent() {
    if (this._text) return this._text;
    return this.children.map(child => child.textContent).join(' ');
  }

  append(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  getAttribute(name) {
    if (name === 'class') return this.className || null;
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  matches(sel) { return matches(this, sel); }

  closest(sel) {
    let node = this;
    while (node) {
      if (matches(node, sel)) return node;
      node = node.parent;
    }
    return null;
  }

  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }

  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, sel)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  includes() { return false; }
}

function makeDocument({ root = null, h1 = null, bodyText = '', title = 'Doc' } = {}) {
  return {
    title,
    body: { innerText: bodyText, textContent: bodyText },
    querySelector(sel) {
      if (sel === 'h1' || sel === '.o_wslides_course_header h1') return h1;
      return root ? root.querySelector(sel) : null;
    },
    querySelectorAll(sel) {
      return root ? root.querySelectorAll(sel) : [];
    },
  };
}

async function runWithDom(doc, fn) {
  const previous = { document: global.document, window: global.window, location: global.location };
  global.document = doc;
  global.window = { location: { origin: 'https://x' } };
  global.location = { origin: 'https://x' };
  try {
    return await fn();
  } finally {
    global.document = previous.document;
    global.window = previous.window;
    global.location = previous.location;
  }
}

function scannerPage(doc) {
  return {
    goto: async () => {},
    waitForTimeout: async () => {},
    evaluate: (fn) => runWithDom(doc, () => fn()),
  };
}

function lessonLink(href, title, percent) {
  const link = new FakeNode({ tagName: 'a', textContent: title, attrs: { href } });
  const badge = new FakeNode({ tagName: 'span', className: 'badge', textContent: `${percent}%` });
  const li = new FakeNode({ tagName: 'li', children: [link, badge] });
  return { li, link, badge };
}

// ── Fixture sản xuất: Võ Thị Vang / "Cấu tạo và sửa chữa thông thường xe" ──
// Sidebar khóa học có "Đã hoàn thành", danh sách bài có 1 bài 0% → KHÓA VẪN XONG.
function productionFixtureDom() {
  const h1 = new FakeNode({ tagName: 'h1', textContent: 'Cấu tạo và sửa chữa thông thường xe - Cát Tường Minh' });
  const badge = new FakeNode({ tagName: 'span', className: 'badge text-success', textContent: '✔ Đã hoàn thành' });
  const timeInfo = new FakeNode({ tagName: 'div', textContent: 'Thời gian hoàn thành 15 giờ 60 phút' });
  const lessons = new FakeNode({
    tagName: 'ul',
    className: 'o_wslides_slides_list',
    children: [
      lessonLink('/slides/slide/day1-1-101', 'Day 1', 100).li,
      lessonLink('/slides/slide/day1-2-102', 'Day 1', 100).li,
      lessonLink('/slides/slide/day2-1-103', 'Day 2', 100).li,
      lessonLink('/slides/slide/day2-2-104', 'Day 2', 100).li,
      lessonLink('/slides/slide/day3-1-105', 'Day 3', 0).li,
    ],
  });
  const sidebar = new FakeNode({
    tagName: 'aside',
    className: 'o_wslides_course_sidebar',
    children: [badge, timeInfo, lessons],
  });
  const root = new FakeNode({ tagName: 'div', children: [h1, sidebar] });
  return makeDocument({ root, h1, bodyText: 'Thời gian hoàn thành 15 giờ 60 phút' });
}

// ── Fixture REAL PRODUCTION: cấu trúc DOM cấp khóa của Odoo ──
// Badge "Đã hoàn thành" luôn có trong DOM; ở khóa chưa xong nó bị ẩn `d-none`.
// Thanh tiến độ cấp khóa hiển thị aria-valuenow + .o_wslides_progress_percentage.
function productionCompletionDom({ badgeHidden, percent }) {
  const h1 = new FakeNode({
    tagName: 'h1',
    textContent: 'Cấu tạo và sửa chữa thông thường xe - Cát Tường Minh',
  });
  const badge = new FakeNode({
    tagName: 'span',
    className: 'o_wslides_channel_completion_completed badge rounded-pill text-bg-success py-1 px-2 mx-auto'
      + (badgeHidden ? ' d-none' : ''),
    textContent: 'Đã hoàn thành',
  });
  const bar = new FakeNode({
    tagName: 'div',
    className: 'progress-bar',
    attrs: {
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(percent),
    },
    style: { width: `${percent}%` },
  });
  const progress = new FakeNode({ tagName: 'div', className: 'progress flex-grow-1 bg-black-50', children: [bar] });
  const pct = new FakeNode({ tagName: 'span', className: 'o_wslides_progress_percentage', textContent: String(percent) });
  const pctWrap = new FakeNode({ tagName: 'div', className: 'ms-3 small', children: [pct] });
  const wrap = new FakeNode({
    tagName: 'div',
    className: 'o_wslides_channel_completion_progressbar d-flex w-100 align-items-center',
    children: [progress, pctWrap],
  });
  const inner = new FakeNode({
    tagName: 'div',
    className: 'd-flex align-items-center pt-3',
    children: [badge, wrap],
  });
  const top = new FakeNode({
    tagName: 'div',
    className: 'o_wslides_sidebar_top d-flex justify-content-between',
    children: [inner],
  });
  const sidebar = new FakeNode({
    tagName: 'div',
    className: 'o_wslides_course_sidebar bg-white px-3 py-2 py-md-3 mb-3 mb-md-5',
    children: [top],
  });
  const root = new FakeNode({ tagName: 'div', children: [h1, sidebar] });
  return makeDocument({ root, h1 });
}

test('production fixture: sidebar "Đã hoàn thành" → completed dù có bài 0%', async () => {
  const result = await scanCourseDetails(scannerPage(productionFixtureDom()), 'https://x/slides/course-1');

  assert.equal(result.courseCompletionState, 'completed');
  assert.equal(result.courseLevelCompleted, true);
  assert.equal(result.courseCompletionSource, 'course_sidebar_completed_badge');
  assert.equal(result.courseProgressPercent, 100);
  assert.equal(result.actualStudiedMinutes, 960);
  assert.equal(result.allLessons.length, 5);
  assert.equal(result.uncompletedLessons.length, 1);
  assert.equal(result.uncompletedLessons[0].progressPercent, 0);
  assert.equal(result.courseCompletionEvidence.completedMarkerFound, true);
  assert.equal(result.courseCompletionEvidence.resolvedProgressPercent, 100);
  assert.equal(result.courseCompletionEvidence.resolutionSource, 'course_sidebar_completed_badge');
});

test('chỉ có bài 100%, KHÔNG có chỉ báo cấp khóa → UNKNOWN (không tự nhận completed)', async () => {
  const h1 = new FakeNode({ tagName: 'h1', textContent: 'Course A' });
  const lessons = new FakeNode({
    tagName: 'ul',
    className: 'o_wslides_slides_list',
    children: [lessonLink('/slides/slide/a1-101', 'A1', 100).li],
  });
  const root = new FakeNode({ tagName: 'div', children: [h1, lessons] });
  const result = await scanCourseDetails(scannerPage(makeDocument({ root, h1 })), 'https://x/slides/course-a');

  assert.equal(result.courseCompletionState, 'unknown');
  assert.equal(result.courseLevelCompleted, false);
  assert.equal(result.courseProgressPercent, null);
  assert.equal(result.courseCompletionEvidence.completedMarkerFound, false);
});

test('thanh tiến độ cấp khóa tường minh 80% → incomplete', async () => {
  const h1 = new FakeNode({ tagName: 'h1', textContent: 'Course B' });
  const bar = new FakeNode({
    tagName: 'div',
    className: 'o_wslides_progress_bar',
    attrs: { role: 'progressbar', 'aria-valuenow': '80' },
  });
  const sidebar = new FakeNode({ tagName: 'div', className: 'o_wslides_course_sidebar', children: [bar] });
  const root = new FakeNode({ tagName: 'div', children: [h1, sidebar] });
  const result = await scanCourseDetails(scannerPage(makeDocument({ root, h1 })), 'https://x/slides/course-b');

  assert.equal(result.courseCompletionState, 'incomplete');
  assert.equal(result.courseLevelCompleted, false);
  assert.equal(result.courseProgressPercent, 80);
  assert.equal(result.courseCompletionSource, 'aria-valuenow');
});

test('sidebar 17% + class "course completed" ngoài sidebar → KHÔNG được nhận completed', async () => {
  const h1 = new FakeNode({ tagName: 'h1', textContent: 'Course chưa xong' });
  const bar = new FakeNode({ tagName: 'div', className: 'progress', textContent: '17%' });
  const sidebar = new FakeNode({
    tagName: 'aside',
    className: 'o_wslides_course_sidebar',
    children: [bar],
  });
  // Phần tử không liên quan (widget/template Odoo) khớp selector rộng
  // [class*="course"][class*="completed"] — từng gây false positive production.
  const unrelated = new FakeNode({
    tagName: 'div',
    className: 'o_wslides_course_completed widget',
    textContent: 'Completed',
  });
  const root = new FakeNode({ tagName: 'div', children: [h1, sidebar, unrelated] });

  const result = await scanCourseDetails(scannerPage(makeDocument({ root, h1 })), 'https://x/slides/course-d');

  assert.equal(result.courseCompletionState, 'incomplete');
  assert.equal(result.courseLevelCompleted, false);
  assert.equal(result.courseProgressPercent, 17);
  assert.equal(result.courseCompletionEvidence.completedMarkerFound, false);
});

test('lesson 52%/0% KHÔNG thay thế tiến độ cấp khóa 17% trong sidebar', async () => {
  const h1 = new FakeNode({ tagName: 'h1', textContent: 'Course mixed' });
  const bar = new FakeNode({ tagName: 'div', className: 'progress', textContent: '17%' });
  const lessons = new FakeNode({
    tagName: 'ul',
    className: 'o_wslides_slides_list',
    children: [
      lessonLink('/slides/slide/l1-201', 'Lesson 1', 52).li,
      lessonLink('/slides/slide/l2-202', 'Lesson 2', 0).li,
      lessonLink('/slides/slide/l3-203', 'Lesson 3', 0).li,
    ],
  });
  const sidebar = new FakeNode({
    tagName: 'aside',
    className: 'o_wslides_course_sidebar',
    children: [bar, lessons],
  });
  const root = new FakeNode({ tagName: 'div', children: [h1, sidebar] });

  const result = await scanCourseDetails(scannerPage(makeDocument({ root, h1 })), 'https://x/slides/course-e');

  assert.equal(result.courseCompletionState, 'incomplete');
  assert.equal(result.courseProgressPercent, 17);
  assert.equal(result.allLessons.length, 3);
  assert.equal(result.uncompletedLessons.length, 3);
});

test('PRODUCTION THẬT: badge "Đã hoàn thành" có d-none + 17% → incomplete 17', async () => {
  const result = await scanCourseDetails(
    scannerPage(productionCompletionDom({ badgeHidden: true, percent: 17 })),
    'https://x/slides/course-213',
  );

  assert.equal(result.courseLevelCompleted, false);
  assert.equal(result.courseCompletionState, 'incomplete');
  assert.equal(result.courseProgressPercent, 17);
  assert.equal(result.courseCompletionSource, 'course_sidebar_aria-valuenow');
  assert.equal(result.courseCompletionEvidence.completedBadgeFound, true);
  assert.equal(result.courseCompletionEvidence.completedBadgeVisible, false);
  assert.equal(result.courseCompletionEvidence.progressBarVisible, true);
  assert.equal(result.courseCompletionEvidence.progressAriaValueNow, '17');
  assert.equal(result.courseCompletionEvidence.progressText, '17');
  assert.equal(result.courseCompletionEvidence.resolvedProgressPercent, 17);
  assert.equal(result.courseCompletionEvidence.resolutionSource, 'course_sidebar_aria-valuenow');
  assert.equal(result.courseCompletionEvidence.finalState, 'incomplete');
  assert.equal(result.courseCompletionEvidence.completedMarkerFound, false);
});

for (const percent of [52, 98]) {
  test(`PRODUCTION THẬT: badge ẩn + ${percent}% → incomplete ${percent}`, async () => {
    const result = await scanCourseDetails(
      scannerPage(productionCompletionDom({ badgeHidden: true, percent })),
      `https://x/slides/course-${percent}`,
    );
    assert.equal(result.courseCompletionState, 'incomplete');
    assert.equal(result.courseLevelCompleted, false);
    assert.equal(result.courseProgressPercent, percent);
    assert.equal(result.courseCompletionEvidence.completedBadgeVisible, false);
  });
}

test('PRODUCTION THẬT: badge visible (không d-none) → completed 100, không cần % 100', async () => {
  const result = await scanCourseDetails(
    scannerPage(productionCompletionDom({ badgeHidden: false, percent: 17 })),
    'https://x/slides/course-done',
  );

  assert.equal(result.courseLevelCompleted, true);
  assert.equal(result.courseCompletionState, 'completed');
  assert.equal(result.courseProgressPercent, 100);
  assert.equal(result.courseCompletionSource, 'course_completed_badge_visible');
  assert.equal(result.courseCompletionEvidence.completedBadgeVisible, true);
  assert.equal(result.courseCompletionEvidence.finalState, 'completed');
});

test('badge ẩn + generic "course completed" VISIBLE + 17% → vẫn incomplete 17', async () => {
  const h1 = new FakeNode({ tagName: 'h1', textContent: 'Course weak evidence' });
  const bar = new FakeNode({
    tagName: 'div',
    className: 'progress-bar',
    attrs: { role: 'progressbar', 'aria-valuenow': '17' },
  });
  const wrap = new FakeNode({
    tagName: 'div',
    className: 'o_wslides_channel_completion_progressbar d-flex',
    children: [bar],
  });
  const badge = new FakeNode({
    tagName: 'span',
    className: 'o_wslides_channel_completion_completed badge d-none',
    textContent: 'Đã hoàn thành',
  });
  const weak = new FakeNode({
    tagName: 'div',
    className: 'o_wslides_course_completed',
    textContent: 'Completed',
  });
  const sidebar = new FakeNode({
    tagName: 'aside',
    className: 'o_wslides_course_sidebar',
    children: [badge, wrap, weak],
  });
  const root = new FakeNode({ tagName: 'div', children: [h1, sidebar] });

  const result = await scanCourseDetails(scannerPage(makeDocument({ root, h1 })), 'https://x/slides/course-f');

  assert.equal(result.courseCompletionState, 'incomplete');
  assert.equal(result.courseProgressPercent, 17);
  assert.equal(result.courseCompletionEvidence.completedBadgeVisible, false);
});

for (const [hours, minutes, expected] of [[3, 13, 193], [14, 44, 884]]) {
  test(`"Thời gian hoàn thành" ${hours} giờ ${minutes} phút → ${expected} phút`, async () => {
    const h1 = new FakeNode({ tagName: 'h1', textContent: 'Course time' });
    const timeInfo = new FakeNode({ tagName: 'div', textContent: `Thời gian hoàn thành ${hours} giờ ${minutes} phút` });
    const sidebar = new FakeNode({ tagName: 'div', className: 'o_wslides_course_sidebar', children: [timeInfo] });
    const root = new FakeNode({ tagName: 'div', children: [h1, sidebar] });
    const bodyText = `Thời gian hoàn thành ${hours} giờ ${minutes} phút`;

    const result = await scanCourseDetails(
      scannerPage(makeDocument({ root, h1, bodyText })),
      `https://x/slides/course-${expected}`,
    );

    assert.equal(result.actualStudiedMinutes, expected);
    assert.equal(result.actualStudiedText, `${hours} giờ ${minutes} phút`);
  });
}

test('"Thời gian hoàn thành" không bị nhầm thành badge hoàn thành', async () => {
  const h1 = new FakeNode({ tagName: 'h1', textContent: 'Course C' });
  const sidebar = new FakeNode({
    tagName: 'div',
    className: 'o_wslides_course_sidebar',
    children: [new FakeNode({ tagName: 'div', textContent: 'Thời gian hoàn thành 2 giờ 5 phút' })],
  });
  const root = new FakeNode({ tagName: 'div', children: [h1, sidebar] });
  const result = await scanCourseDetails(
    scannerPage(makeDocument({ root, h1, bodyText: 'Thời gian hoàn thành 2 giờ 5 phút' })),
    'https://x/slides/course-c',
  );

  assert.equal(result.courseCompletionState, 'unknown');
  assert.equal(result.actualStudiedMinutes, 125);
});

test('My Courses: thẻ có "Completed" → completed', async () => {
  const h5 = new FakeNode({ tagName: 'h5', textContent: 'Cấu tạo và sửa chữa thông thường xe - Cát Tường Minh' });
  const link = new FakeNode({ tagName: 'a', attrs: { href: '/slides/course-1' }, children: [h5] });
  const badge = new FakeNode({ tagName: 'span', className: 'badge', textContent: '✔ Completed' });
  const card = new FakeNode({ tagName: 'div', className: 'card', children: [link, badge] });
  const root = new FakeNode({ tagName: 'div', children: [card] });

  const results = await scanMyCoursesCompletion(scannerPage(makeDocument({ root })), 'https://x/slides/all?my=1');
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Cấu tạo và sửa chữa thông thường xe - Cát Tường Minh');
  assert.equal(results[0].completed, true);
  assert.equal(results[0].state, 'completed');
  assert.equal(results[0].source, 'my_courses_completed_badge');
  assert.equal(results[0].coursePath, '/slides/course-1');
  assert.equal(results[0].orderIndex, 0);
  assert.equal(results[0].progressPercent, 100);
});

test('My Courses: thẻ KHÔNG có Completed → incomplete, giữ đúng thứ tự website', async () => {
  const mkCard = (title, href, completed) => {
    const h5 = new FakeNode({ tagName: 'h5', textContent: title });
    const link = new FakeNode({ tagName: 'a', attrs: { href }, children: [h5] });
    const children = [link];
    if (completed) children.push(new FakeNode({ tagName: 'span', className: 'badge', textContent: '✔ Completed' }));
    return new FakeNode({ tagName: 'div', className: 'card', children });
  };
  const root = new FakeNode({
    tagName: 'div',
    children: [
      mkCard('Khóa A', '/slides/course-a', true),
      mkCard('Khóa B', '/slides/course-b', false),
      mkCard('Khóa C', '/slides/course-c', false),
    ],
  });

  const results = await scanMyCoursesCompletion(scannerPage(makeDocument({ root })), 'https://x/slides/all?my=1');
  assert.equal(results.length, 3);
  assert.deepEqual(results.map(r => r.orderIndex), [0, 1, 2]);
  assert.deepEqual(results.map(r => r.coursePath), ['/slides/course-a', '/slides/course-b', '/slides/course-c']);
  assert.deepEqual(results.map(r => r.state), ['completed', 'incomplete', 'incomplete']);
  assert.equal(results[1].source, 'my_courses_listed_incomplete');
});

test('My Courses incomplete cards do not invent numeric progress', async () => {
  const h5 = new FakeNode({ tagName: 'h5', textContent: 'Course incomplete 98%' });
  const link = new FakeNode({ tagName: 'a', attrs: { href: '/slides/course-incomplete' }, children: [h5] });
  const card = new FakeNode({ tagName: 'div', className: 'card', children: [link] });
  const root = new FakeNode({ tagName: 'div', children: [card] });

  const results = await scanMyCoursesCompletion(scannerPage(makeDocument({ root })), 'https://x/slides/all?my=1');
  assert.equal(results[0].completed, false);
  assert.equal(results[0].progressPercent, null);
  assert.equal(results[0].state, 'incomplete');
});
