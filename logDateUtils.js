const VN_TIME_ZONE = 'Asia/Ho_Chi_Minh';

function vnDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: VN_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { day: values.day, month: values.month, year: values.year };
}

function vnDateStr(date = new Date()) {
  const { day, month, year } = vnDateParts(date);
  return `${year}-${month}-${day}`;
}

function vnDateDDMMYYYY(date = new Date()) {
  const { day, month, year } = vnDateParts(date);
  return `${day}-${month}-${year}`;
}

function formatToDDMMYYYY(value) {
  if (!value) return '';
  const cleaned = String(value).trim();
  if (/^\d{2}-\d{2}-\d{4}$/.test(cleaned)) return cleaned;
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    const [year, month, day] = cleaned.split('-');
    return `${day}-${month}-${year}`;
  }
  return '';
}

function filterLogsForDate(entries, targetDate, includeUndated = true) {
  const normalizedTarget = formatToDDMMYYYY(targetDate);
  if (!normalizedTarget || !Array.isArray(entries)) return [];
  return entries.filter(entry => {
    const entryDate = formatToDDMMYYYY(entry && entry.date);
    return entryDate ? entryDate === normalizedTarget : includeUndated;
  });
}

module.exports = {
  VN_TIME_ZONE,
  vnDateStr,
  vnDateDDMMYYYY,
  formatToDDMMYYYY,
  filterLogsForDate,
};
