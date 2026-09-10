/*
 * Deterministic Banner parser.
 *
 * The renderer knows nothing about Banner's PDF layout. This module accepts
 * PDF.js text items, reconstructs visual rows, finds course-header anchors,
 * then parses only the bounded corridor belonging to each course.
 */

const DAY_ORDER = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_ALIASES = new Map([
  ['sunday', 'Sunday'], ['sun', 'Sunday'],
  ['monday', 'Monday'], ['mon', 'Monday'],
  ['tuesday', 'Tuesday'], ['tue', 'Tuesday'], ['tues', 'Tuesday'],
  ['wednesday', 'Wednesday'], ['wed', 'Wednesday'],
  ['thursday', 'Thursday'], ['thu', 'Thursday'], ['thur', 'Thursday'], ['thurs', 'Thursday'],
  ['friday', 'Friday'], ['fri', 'Friday'],
  ['saturday', 'Saturday'], ['sat', 'Saturday']
]);

// Banner's summary table uses: SUBJECT NUMBER SECTION CREDITS CRN DATE-RANGE.
// Keep the course-code grammar deliberately broad enough for common Banner
// suffixes such as 101L / 211R without accepting arbitrary prose.
const COURSE_RE = /\b([A-Z][A-Z0-9]{1,9})\s+(\d{3,4}[A-Z]?)\s+([A-Z0-9]{1,10})\b/i;
const DATE_RE = /\b(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:-|–|—|to)\s*(\d{1,2}\/\d{1,2}\/\d{4})\b/i;
const TIME_RE = /\b(\d{1,2}\s*:\s*\d{2}\s*(?:A\.?\s*M\.?|P\.?\s*M\.?))\s*(?:-|–|—|to)\s*(\d{1,2}\s*:\s*\d{2}\s*(?:A\.?\s*M\.?|P\.?\s*M\.?))\b/i;
const DAY_WORD_RE = /^(?:Sunday|Sun|Monday|Mon|Tuesday|Tue|Tues|Wednesday|Wed|Thursday|Thu|Thur|Thurs|Friday|Fri|Saturday|Sat)$/i;
const DAY_LINE_RE = /^(?:(?:Sunday|Sun|Monday|Mon|Tuesday|Tue|Tues|Wednesday|Wed|Thursday|Thu|Thur|Thurs|Friday|Fri|Saturday|Sat)(?:\s*[,/&]\s*|\s+and\s+|\s*)?)+$/i;
const LOCATION_START_RE = /^(?:Main Campus\s*,|(?:Online|Virtual|Remote)(?:\s+|$))/i;
const REGISTERED_RE = /Registered\s*:\s*(\d+(?:\.\d+)?)/i;
const TERM_RE = /([^\n]+?)\s+((?:Spring|Summer|Fall|Winter)\s+\d{4})\s+Schedule/i;

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeDash(value) {
  return clean(value).replace(/[–—−]/g, '-');
}

export function normalizeTime(value) {
  const m = clean(value).match(/^([0-9]{1,2})\s*:\s*([0-9]{2})\s*([AP])\.?\s*M\.?$/i);
  if (!m) return clean(value).toUpperCase();
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]} ${m[3].toUpperCase()}M`;
}

export function minutesFromTime(value) {
  const m = clean(value).match(/^([0-9]{1,2})\s*:\s*([0-9]{2})\s*([AP])\.?\s*M\.?$/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (m[3].toUpperCase() === 'A') hour = hour === 12 ? 0 : hour;
  else hour = hour === 12 ? 12 : hour + 12;
  return hour * 60 + minute;
}

export function formatMinutes(total) {
  let hour = Math.floor(total / 60);
  const minute = total % 60;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${hour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

export function displayTime(value) {
  const minutes = minutesFromTime(value);
  return minutes == null ? clean(value) : formatMinutes(minutes);
}

function parseDays(value) {
  const text = clean(value).replace(/\s*&\s*/g, ',');
  const tokens = text.split(/[,/] |[,/]|\s+and\s+/i).map(clean).filter(Boolean);
  const found = [];
  for (const token of tokens) {
    const day = DAY_ALIASES.get(token.toLowerCase());
    if (day && !found.includes(day)) found.push(day);
  }
  return found.sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
}

function parseDateRange(value) {
  const m = clean(value).match(DATE_RE);
  return m ? { startDate: m[1], endDate: m[2] } : null;
}

function toTextItem(item) {
  const x = Number(item.transform?.[4]);
  const y = Number(item.transform?.[5]);
  return {
    text: clean(item.str),
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    width: Number(item.width) || 0,
    height: Math.abs(Number(item.transform?.[3])) || 10
  };
}

/**
 * Reconstruct visual rows from PDF.js items. The nearest existing y-row is
 * selected instead of the first matching row; this prevents accidental row
 * merges when a PDF has several close baselines.
 */
export function parseBannerLines(items) {
  const positioned = (items || [])
    .filter(item => clean(item.str) && Array.isArray(item.transform) && item.transform.length >= 6)
    .map(toTextItem)
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const rows = [];
  for (const item of positioned) {
    const tolerance = Math.max(2.5, Math.min(4.5, item.height * 0.32));
    let best = null;
    let bestDistance = Infinity;
    for (const row of rows) {
      const distance = Math.abs(row.y - item.y);
      if (distance <= tolerance && distance < bestDistance) {
        best = row;
        bestDistance = distance;
      }
    }
    if (!best) {
      best = { y: item.y, items: [] };
      rows.push(best);
    }
    best.items.push(item);
    // Keep the representative baseline stable while allowing tiny font-baseline drift.
    best.y = best.items.reduce((sum, part) => sum + part.y, 0) / best.items.length;
  }

  return rows
    .map(row => {
      row.items.sort((a, b) => a.x - b.x);
      const minX = row.items[0]?.x ?? 0;
      const maxX = Math.max(...row.items.map(item => item.x + item.width), minX);
      return {
        y: row.y,
        items: row.items,
        text: clean(row.items.map(item => item.text).join(' ')),
        minX,
        maxX
      };
    })
    .sort((a, b) => b.y - a.y);
}

function lineHasDate(line) { return DATE_RE.test(line?.text || ''); }
function lineHasTime(line) { return TIME_RE.test(line?.text || ''); }
function lineHasDays(line) { return DAY_LINE_RE.test(clean(line?.text)); }
function lineHasLocation(line) {
  const text = clean(line?.text);
  if (!text || lineHasDays(line) || lineHasTime(line) || lineHasDate(line)) return false;
  return LOCATION_START_RE.test(text) || /^(?:[A-Z][^,]+),\s*[^,]+$/i.test(text);
}

function isHeaderCandidate(line, nearbyLines = []) {
  if (!line?.text) return false;
  if (!COURSE_RE.test(line.text)) return false;

  // Normally Banner keeps the date range on the course row. Some PDF producers
  // wrap the header across lines, so allow a short adjacent header corridor.
  const headerText = [line.text, ...nearbyLines.slice(0, 2).map(item => item.text)].join(' ');
  return DATE_RE.test(headerText);
}

function extractCourseTitle(line, match) {
  const normalizedLine = clean(line.text);
  const matchIndex = match.index ?? 0;
  let title = clean(normalizedLine.slice(0, matchIndex));

  // PDF text order is not guaranteed. If the title was emitted after the code,
  // use the x-coordinate boundary of the code column instead.
  if (!title && line.items?.length) {
    const codeToken = match[1];
    const codeItem = line.items.find(item => clean(item.text).toUpperCase() === codeToken.toUpperCase());
    if (codeItem) {
      title = clean(line.items.filter(item => item.x < codeItem.x).map(item => item.text).join(' '));
    }
  }

  // Remove accidental table-header fragments if a producer merged rows.
  return title.replace(/^(?:Title\s+)?$/i, '').trim();
}

function extractHeaderFields(line, match, nearbyLines = []) {
  const normalizedLine = clean(line.text);
  const matchEnd = (match.index ?? 0) + match[0].length;
  const afterCode = clean(normalizedLine.slice(matchEnd));
  const parts = afterCode.split(/\s+/).filter(Boolean);

  let creditIndex = parts.findIndex(part => /^\d+(?:\.\d+)?$/.test(part));
  let credits = creditIndex >= 0 ? Number(parts[creditIndex]) : null;
  let crn = creditIndex >= 0
    ? parts.slice(creditIndex + 1).find(part => /^\d{4,8}$/.test(part)) || ''
    : '';

  const headerText = [afterCode, ...nearbyLines.slice(0, 2).map(item => clean(item.text))].join(' ');
  if (credits == null) {
    const creditMatch = headerText.match(/(?:^|\s)(\d+(?:\.\d+)?)(?=\s|$)/);
    credits = creditMatch ? Number(creditMatch[1]) : null;
  }
  if (!crn) {
    const crnMatch = headerText.match(/\b(\d{4,8})\b/);
    crn = crnMatch ? crnMatch[1] : '';
  }

  const date = parseDateRange([line.text, ...nearbyLines.slice(0, 2).map(item => item.text)].join(' '));
  return { credits, crn, date };
}

function findHeaderAnchor(line, nearbyLines = []) {
  const match = clean(line.text).match(COURSE_RE);
  if (!match || !isHeaderCandidate(line, nearbyLines)) return null;
  const fields = extractHeaderFields(line, match, nearbyLines);
  return {
    code: `${match[1].toUpperCase()} ${match[2].toUpperCase()}`,
    section: match[3].toUpperCase(),
    title: extractCourseTitle(line, match),
    credits: fields.credits,
    crn: fields.crn,
    startDate: fields.date?.startDate || '',
    endDate: fields.date?.endDate || ''
  };
}

function lineDistance(a, b) {
  return Math.abs((a?.y ?? 0) - (b?.y ?? 0));
}

function boundedBlock(lines, headerIndex, nextHeaderIndex) {
  const start = headerIndex + 1;
  const end = nextHeaderIndex == null ? lines.length : nextHeaderIndex;
  return lines.slice(start, end);
}

function parseLocation(text) {
  const value = clean(text);
  if (!value) return { building: '', room: '' };
  const parts = value.split(',').map(clean).filter(Boolean);
  if (parts.length === 1) return { building: '', room: parts[0] };
  return { building: parts.slice(0, -1).join(', '), room: parts.at(-1) };
}

function looksLikeInstructor(line) {
  const text = clean(line?.text);
  if (!text || lineHasDays(line) || lineHasTime(line) || lineHasDate(line) || lineHasLocation(line)) return false;
  if (/^(?:Title|Course|Details|Credit|Hours|CRN|Meeting|Times)$/i.test(text)) return false;
  if (/^Total Hours\b/i.test(text)) return false;
  // Instructor names are generally alphabetic, with support for apostrophes,
  // hyphens, periods and initials. This rejects stray numeric/footer content.
  return /^[A-Za-zÀ-ÖØ-öø-ÿ.'’\- ]{2,100}$/.test(text);
}

function chooseNearestLine(lines, predicate, referenceY, maxDistance = 20) {
  return lines
    .filter(predicate)
    .map(line => ({ line, distance: lineDistance(line, { y: referenceY }) }))
    .filter(item => item.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)[0]?.line || null;
}

function parseMeeting(blockLines, anchor) {
  const daysLine = blockLines.find(lineHasDays);
  const timeLine = blockLines.find(lineHasTime);
  const locationLine = blockLines.find(lineHasLocation);
  const timeMatch = timeLine?.text.match(TIME_RE);
  const location = parseLocation(locationLine?.text || '');

  let instructor = '';
  if (locationLine) {
    const instructorLine = chooseNearestLine(
      blockLines,
      looksLikeInstructor,
      locationLine.y,
      24
    );
    if (instructorLine) instructor = instructorLine.text;
  }

  const record = {
    title: anchor.title,
    courseCode: anchor.code,
    section: anchor.section,
    credits: anchor.credits,
    crn: anchor.crn,
    days: daysLine ? parseDays(daysLine.text) : [],
    startTime: timeMatch ? normalizeTime(timeMatch[1]) : '',
    endTime: timeMatch ? normalizeTime(timeMatch[2]) : '',
    building: location.building,
    room: location.room,
    instructor,
    startDate: anchor.startDate,
    endDate: anchor.endDate
  };

  return record;
}

function validateRecord(record) {
  if (!record?.title) return { ok: false, reason: 'missing title' };
  if (!/^[A-Z][A-Z0-9]{1,9} \d{3,4}[A-Z]?$/.test(record.courseCode)) return { ok: false, reason: 'invalid course code' };
  if (!record.section) return { ok: false, reason: 'missing section' };
  if (!Number.isFinite(record.credits) || record.credits < 0) return { ok: false, reason: 'invalid credit hours' };
  if (!/^\d{4,8}$/.test(record.crn)) return { ok: false, reason: 'missing/invalid CRN' };
  if (!record.days.length) return { ok: false, reason: 'missing meeting day' };
  const start = minutesFromTime(record.startTime);
  const end = minutesFromTime(record.endTime);
  if (start == null || end == null || end <= start) return { ok: false, reason: 'invalid meeting time' };
  if (!record.startDate || !record.endDate) return { ok: false, reason: 'missing term date range' };
  return { ok: true };
}

function dedupeRecords(records) {
  const seen = new Set();
  return records.filter(record => {
    const key = [
      record.courseCode, record.section, record.crn,
      record.days.join(','), record.startTime, record.endTime,
      record.building, record.room
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parsePageByRows(lines) {
  const anchors = [];
  for (let i = 0; i < lines.length; i++) {
    const anchor = findHeaderAnchor(lines[i], lines.slice(i + 1, i + 3));
    if (anchor) anchors.push({ index: i, line: lines[i], anchor });
  }

  const diagnostics = {
    dateAnchors: anchors.length,
    candidates: anchors.length,
    failures: []
  };
  const records = [];

  for (let i = 0; i < anchors.length; i++) {
    const current = anchors[i];
    const next = anchors[i + 1];
    const block = boundedBlock(lines, current.index, next?.index);
    const record = parseMeeting(block, current.anchor);
    const validation = validateRecord(record);
    if (validation.ok) records.push(record);
    else diagnostics.failures.push(`${current.anchor.code}-${current.anchor.section} CRN ${current.anchor.crn || '?'}: ${validation.reason}.`);
  }

  return { records: dedupeRecords(records), diagnostics };
}

function flattenedLines(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/\\n/g, '\n') // tolerate older callers that accidentally serialized "\\n"
    .split(/\n+/)
    .map(clean)
    .filter(Boolean);
}

function fallbackParseFromText(text) {
  const lines = flattenedLines(text);
  const anchors = [];
  for (let i = 0; i < lines.length; i++) {
    const pseudoLine = { text: lines[i], y: lines.length - i, items: [] };
    const anchor = findHeaderAnchor(pseudoLine, lines.slice(i + 1, i + 3).map((text, offset) => ({ text, y: lines.length - i - offset - 1, items: [] })));
    if (anchor) anchors.push({ index: i, anchor });
  }

  const records = [];
  for (let i = 0; i < anchors.length; i++) {
    const current = anchors[i];
    const next = anchors[i + 1];
    const block = lines.slice(current.index + 1, next?.index ?? lines.length)
      .map((text, offset) => ({ text, y: lines.length - current.index - offset - 1, items: [] }));
    const record = parseMeeting(block, current.anchor);
    if (validateRecord(record).ok) records.push(record);
  }
  return dedupeRecords(records);
}

function pickSchedulePage(pageData) {
  return pageData.find(page =>
    /Credit\s+Hours/i.test(page.text || '') &&
    /Meeting\s+Times/i.test(page.text || '') &&
    (page.lines || []).some(lineHasDate)
  ) || pageData.find(page => (page.lines || []).some(lineHasDate)) || pageData[0];
}

export function parseBannerTextPages(pageData) {
  if (!Array.isArray(pageData) || !pageData.length) throw new Error('The PDF contains no pages.');

  const first = pickSchedulePage(pageData);
  if (!first?.lines?.length) throw new Error('The PDF contains no selectable Banner text.');

  const parsed = parsePageByRows(first.lines);
  let records = parsed.records;
  if (!records.length) records = fallbackParseFromText(first.text);

  if (!records.length) {
    const sample = first.lines.slice(0, 24).map(line => line.text).join('\n');
    throw new Error([
      'Banner text was extracted, but no valid course meetings could be reconstructed.',
      '',
      `Text lines reconstructed: ${first.lines.length}`,
      `Course/date anchors found: ${parsed.diagnostics.dateAnchors}`,
      parsed.diagnostics.failures.slice(0, 8).join('\n'),
      sample ? `Sample extracted text:\n${sample}` : ''
    ].filter(Boolean).join('\n'));
  }

  const fullText = pageData.map(page => page.text || '').join('\n');
  const header = fullText.match(TERM_RE);
  const studentName = header ? clean(header[1]) : '';
  const term = header ? clean(header[2]) : '';
  const registeredMatch = fullText.match(REGISTERED_RE);
  const registeredCredits = registeredMatch ? Number(registeredMatch[1]) : null;
  const calculatedCredits = records.reduce((sum, record) => sum + Number(record.credits), 0);
  const warnings = [];

  if (registeredCredits != null && Math.abs(registeredCredits - calculatedCredits) > 0.001) {
    warnings.push(`Banner reports ${registeredCredits} registered credits; parsed course credits total ${calculatedCredits}.`);
  }
  if (parsed.diagnostics.dateAnchors !== records.length) {
    warnings.push(`Banner exposed ${parsed.diagnostics.dateAnchors} course rows; ${records.length} valid meetings were reconstructed.`);
  }

  return {
    records,
    studentName,
    term,
    registeredCredits,
    calculatedCredits,
    warnings,
    pageData,
    diagnostics: parsed.diagnostics
  };
}
