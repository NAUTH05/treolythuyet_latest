// Hiển thị tiến độ cấp khóa của một khóa Auto-Scan trên Dashboard.
// Tách khỏi component React để unit-test bằng Node (dynamic import).
//
// Nguồn chân lý hiển thị:
//   hoàn thành  → websiteCourseCompleted / websiteCourseCompletionState
//   phần trăm   → websiteCourseProgressPercent
//   thời gian   → websiteRecordedMinutes ("Thời gian hoàn thành" của website)
//
// `websiteRecordedMinutes` CHỈ là metadata hiển thị — KHÔNG dùng để suy ra
// hoàn thành. null (chưa biết) hiển thị "--"; 0 (đã biết) hiển thị "0m".

export function formatMinutes(mins) {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

// null/undefined/'' → null (CHƯA BIẾT), khác hẳn 0 (đã biết là 0).
function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Thời gian hoàn thành website: số phút là nguồn bền vững, không parse lại text.
export function websiteRecordedLabel(cp) {
  const minutes = nullableNumber(cp && cp.websiteRecordedMinutes);
  if (minutes == null || minutes < 0) return '--';
  return formatMinutes(minutes);
}

export function courseRowDisplay(cp) {
  const progress = cp || {};
  const websiteFieldsPresent =
    Object.prototype.hasOwnProperty.call(progress, 'websiteCourseCompleted')
    || Object.prototype.hasOwnProperty.call(progress, 'websiteCourseCompletionState')
    || Object.prototype.hasOwnProperty.call(progress, 'websiteCourseProgressPercent')
    || Object.prototype.hasOwnProperty.call(progress, 'websiteRecordedMinutes')
    || Object.prototype.hasOwnProperty.call(progress, 'websiteRecordedText');

  const websiteCompleted = progress.websiteCourseCompleted === true
    || progress.websiteCourseCompletionState === 'completed';

  const websitePercent = nullableNumber(progress.websiteCourseProgressPercent);
  const knownWebsitePercent = websitePercent == null
    ? null
    : Math.max(0, Math.min(100, websitePercent));

  const target = Number(progress.targetMinutes) || 0;
  const studied = Number(progress.studiedMinutes) || 0;
  const legacyCompleted = progress.completed === true;

  const pct = websiteFieldsPresent
    ? (websiteCompleted ? 100 : (knownWebsitePercent ?? 0))
    : (legacyCompleted ? 100 : target > 0 ? Math.min(100, (studied / target) * 100) : 0);

  const completionLabel = websiteCompleted
    ? 'Completed'
    : (knownWebsitePercent == null ? 'In Progress' : `${Math.round(knownWebsitePercent)}%`);

  const label = websiteFieldsPresent
    ? `${completionLabel} · ${websiteRecordedLabel(progress)}`
    : (legacyCompleted ? 'Đã đạt mục tiêu' : `${formatMinutes(studied)} / ${formatMinutes(target)}`);

  const done = websiteFieldsPresent ? websiteCompleted : legacyCompleted;

  return { websiteFieldsPresent, websiteCompleted, pct, label, done };
}
