const DAY_TO_ICAL = {
  Sunday: 'SU',
  Monday: 'MO',
  Tuesday: 'TU',
  Wednesday: 'WE',
  Thursday: 'TH',
  Friday: 'FR',
  Saturday: 'SA'
};

function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseBannerDate(value) {
  const match = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day, weekday: date.getUTCDay() };
}

function formatDate(date) {
  return `${date.year}${pad2(date.month)}${pad2(date.day)}`;
}

function formatDateTime(date, minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${formatDate(date)}T${pad2(hour)}${pad2(minute)}00`;
}

// Banner schedules are published in UAE local time. Keep DTSTART/DTEND tied to
// Asia/Dubai so calendar applications such as Google Calendar do not reinterpret
// the timetable using the device's current timezone.
function formatUtcDateTime(date, minutes) {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day, Math.floor(minutes / 60), minutes % 60));
  value.setUTCMinutes(value.getUTCMinutes() - 240); // UAE is UTC+04:00 year-round.
  return `${value.getUTCFullYear()}${pad2(value.getUTCMonth() + 1)}${pad2(value.getUTCDate())}T${pad2(value.getUTCHours())}${pad2(value.getUTCMinutes())}00Z`;
}

function parseTimeMinutes(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})\s*([AP])\.?M\.?$/i);
  if (match) {
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 1 || hour > 12 || minute > 59) return NaN;
    if (match[3].toUpperCase() === 'A') hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
    return hour * 60 + minute;
  }
  const twentyFour = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!twentyFour) return NaN;
  const hour = Number(twentyFour[1]);
  const minute = Number(twentyFour[2]);
  return hour >= 0 && hour <= 23 && minute <= 59 ? hour * 60 + minute : NaN;
}

function addDays(date, days) {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
    weekday: value.getUTCDay()
  };
}

function escapeIcsText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function firstMeetingDate(startDate, dayName) {
  const start = parseBannerDate(startDate);
  const targetDay = DAY_TO_ICAL[dayName];
  if (!start || !targetDay) return null;
  const targetIndex = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'].indexOf(targetDay);
  const delta = (targetIndex - start.weekday + 7) % 7;
  return addDays(start, delta);
}

function makeUid(record, day, index) {
  const crn = String(record.crn || 'course').replace(/[^A-Za-z0-9]/g, '');
  const code = String(record.courseCode || 'class').replace(/[^A-Za-z0-9]/g, '');
  return `banner-${code}-${crn}-${day}-${index}@banner-timetable`;
}

export function generateIcs(parsed) {
  const records = Array.isArray(parsed?.records) ? parsed.records : [];
  if (!records.length) throw new Error('No parsed timetable is available.');

  const allDates = records.flatMap(record => [record.startDate, record.endDate].filter(Boolean));
  const parsedStart = allDates.map(parseBannerDate).filter(Boolean).sort((a, b) => formatDate(a).localeCompare(formatDate(b)))[0];
  const parsedEnd = allDates.map(parseBannerDate).filter(Boolean).sort((a, b) => formatDate(b).localeCompare(formatDate(a)))[0];
  if (!parsedStart || !parsedEnd) throw new Error('The timetable does not contain a valid semester date range.');

  const now = new Date();
  const dtstamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}Z`;
  const events = [];
  let index = 0;

  for (const record of records) {
    const start = parseTimeMinutes(record.startTime);
    const end = parseTimeMinutes(record.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

    const location = [record.building, record.room].map(value => String(value || '').trim()).filter(Boolean).join(' ').replace(/\s*[-–]\s*/g, ' - ');
    const description = location || 'Location not listed';

    for (const day of record.days || []) {
      const firstDate = firstMeetingDate(record.startDate, day);
      if (!firstDate || formatDate(firstDate) > formatDate(parsedEnd)) continue;
      index += 1;
      events.push([
        'BEGIN:VEVENT',
        `UID:${makeUid(record, day, index)}`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;TZID=Asia/Dubai:${formatDateTime(firstDate, start)}`,
        `DTEND;TZID=Asia/Dubai:${formatDateTime(firstDate, end)}`,
        `RRULE:FREQ=WEEKLY;UNTIL=${formatUtcDateTime(parsedEnd, end)}`,
        `SUMMARY:${escapeIcsText(record.courseCode)}`,
        `DESCRIPTION:${escapeIcsText(description)}`,
        'END:VEVENT'
      ].join('\r\n'));
    }
  }

  if (!events.length) throw new Error('No valid class meetings were available for calendar export.');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Banner Timetable//Calendar Export//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Dubai',
    'X-LIC-LOCATION:Asia/Dubai',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0400',
    'TZOFFSETTO:+0400',
    'TZNAME:GST',
    'END:STANDARD',
    'END:VTIMEZONE',
    ...events,
    'END:VCALENDAR',
    ''
  ].join('\r\n');
}
