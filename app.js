import { parseBannerTextPages, parseBannerLines, minutesFromTime, formatMinutes, displayTime } from './banner-parser.js';

let pdfjsLib;
async function loadPdfJs() {
  if (pdfjsLib) return pdfjsLib;
  const urls = [
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.149/pdf.min.mjs',
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.149/build/pdf.min.mjs'
  ];
  let lastError;
  for (const url of urls) {
    try {
      pdfjsLib = await import(url);
      pdfjsLib.GlobalWorkerOptions.workerSrc = url.includes('cdnjs')
        ? 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.149/pdf.worker.min.mjs'
        : 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.149/build/pdf.worker.min.mjs';
      return pdfjsLib;
    } catch (error) { lastError = error; }
  }
  throw new Error(`PDF.js could not be loaded. Check your internet connection and try again. ${lastError?.message || ''}`);
}

const els = {
  input: document.querySelector('#pdfInput'),
  dropZone: document.querySelector('#dropZone'),
  status: document.querySelector('#status'),
  output: document.querySelector('#output'),
  timetable: document.querySelector('#timetable'),
  sourceLabel: document.querySelector('#sourceLabel'),
  parseMessage: document.querySelector('#parseMessage'),
  studentName: document.querySelector('#studentName'),
  termName: document.querySelector('#termName'),
  metrics: document.querySelector('#metrics'),
  calendar: document.querySelector('#calendar'),
  dayNav: document.querySelector('#dayNav'),
  palette: document.querySelector('#palette'),
  print: document.querySelector('#printButton'),
  errorPanel: document.querySelector('#errorPanel'),
  errorText: document.querySelector('#errorText'),
  diagnostics: document.querySelector('#diagnostics')
};

const DAY_ORDER = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = { Sunday: 'Sun', Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat' };

const PALETTES = {
  blue:   { label: 'Blue', hues: [198, 226, 254, 282, 310, 178, 238, 270] },
  pink:   { label: 'Pink', hues: [306, 334, 358, 20, 342, 318, 10, 286] },
  yellow: { label: 'Yellow', hues: [24, 48, 72, 96, 34, 60, 86, 112] },
  green:  { label: 'Green', hues: [104, 132, 160, 188, 116, 146, 174, 202] },
  rainbow:{ label: 'Rainbow', hues: [198, 248, 294, 338, 24, 72, 126, 174] }
};
let activePalette = 'blue';
let activeMobileDay = null;

async function extractPdf(file) {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  let pdf;
  try {
    pdf = await pdfjs.getDocument({ data, useWorkerFetch: true, isEvalSupported: true }).promise;
  } catch (error) {
    if (/password/i.test(error?.name || '') || /password/i.test(error?.message || '')) {
      throw new Error('This PDF is password-protected. Please export an unprotected Banner schedule PDF.');
    }
    throw new Error(`PDF.js could not open this PDF: ${error?.message || 'unknown PDF error'}`);
  }

  const pageData = [];
  let totalTextItems = 0;
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
    totalTextItems += content.items.length;
    const lines = parseBannerLines(content.items);
    pageData.push({ pageNo, lines, text: lines.map(l => l.text).join('\n') });
  }
  if (totalTextItems === 0) throw new Error('This PDF contains no selectable text. V1 supports text-based Banner PDFs only, not scanned/image PDFs.');
  return pageData;
}

function parseBanner(pageData) {
  return parseBannerTextPages(pageData);
}

function formatDateRange(start, end) { return `${start} – ${end}`; }

function courseFamilyKey(courseCode) {
  // Banner commonly uses trailing L/R codes for labs/recitations belonging to the
  // same parent course (e.g. CMP 220L → CMP 220). Keep repeated days as one course.
  return String(courseCode || '').replace(/(\s\d{3,4})[LR]$/i, '$1').toUpperCase();
}

function uniqueCourseCount(records) {
  return new Set(records.map(r => courseFamilyKey(r.courseCode))).size;
}

function renderMetrics(parsed) {
  const meetings = parsed.records.flatMap(r => r.days.map(day => ({ day, start: minutesFromTime(r.startTime), end: minutesFromTime(r.endTime) })));
  const days = [...new Set(meetings.map(m => m.day))].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
  const earliest = Math.min(...meetings.map(m => m.start));
  const latest = Math.max(...meetings.map(m => m.end));
  const credits = parsed.registeredCredits ?? parsed.calculatedCredits;
  const metrics = [
    ['credits', String(Number.isInteger(credits) ? credits : Number(credits).toFixed(1)), 'Credits'],
    ['courses', String(uniqueCourseCount(parsed.records)), 'Courses'],
    ['days', String(days.length), 'Days']
  ];
  els.metrics.innerHTML = metrics.map(([_, value, label]) =>
    `<div class="metric"><div class="metric-value">${escapeHtml(value)}</div><div class="metric-label">${escapeHtml(label)}</div></div>`
  ).join('');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

function formatRoom(event) {
  let building = String(event.building || '').trim();
  let room = String(event.room || '').trim().replace(/\s*-\s*/g, ' - ');

  // Banner location text is verbose. Keep the useful building abbreviation and
  // room while removing campus-level prose from the visible card.
  building = building
    .replace(/^Main Campus,\s*/i, '')
    .replace(/^Main Campus\s*/i, '')
    .trim();

  const buildingAliases = [
    [/^Engineering Building Left$/i, 'ELB'],
    [/^Engineering Building$/i, 'EB'],
    [/^Engineering Science Building$/i, 'ESB'],
    [/^Chemistry Building$/i, 'CHM'],
    [/^Science Building$/i, 'SB']
  ];
  for (const [pattern, alias] of buildingAliases) {
    if (pattern.test(building)) { building = alias; break; }
  }

  return [building, room].filter(Boolean).join(' ').trim() || 'Location not listed';
}

function colorForIndex(index, count) {
  const palette = PALETTES[activePalette] || PALETTES.blue;
  const hues = palette.hues || PALETTES.blue.hues;
  if (count <= hues.length) return hues[index % hues.length];

  // For unusually large schedules, keep the palette family but distribute any
  // extra courses using a deterministic golden-angle step.
  return (hues[index % hues.length] + Math.floor(index / hues.length) * 29) % 360;
}

function courseColors(records) {
  const families = [...new Set(records.map(r => courseFamilyKey(r.courseCode)))].sort();
  return new Map(families.map((family, index) => [family, colorForIndex(index, families.length)]));
}

function overlapLayout(events) {
  const sorted = [...events].sort((a, b) => a.start - b.start || b.end - a.end);
  const groups = [];
  let current = [];
  let groupEnd = -Infinity;
  for (const event of sorted) {
    if (current.length && event.start >= groupEnd) {
      groups.push(current);
      current = [];
      groupEnd = -Infinity;
    }
    current.push(event);
    groupEnd = Math.max(groupEnd, event.end);
  }
  if (current.length) groups.push(current);

  for (const group of groups) {
    const columns = [];
    for (const event of group) {
      let col = columns.findIndex(end => end <= event.start);
      if (col === -1) { col = columns.length; columns.push(event.end); }
      else columns[col] = event.end;
      event.column = col;
    }
    group.forEach(event => event.columns = columns.length || 1);
  }
  return sorted;
}

function renderDayNav(activeDays) {
  els.dayNav.innerHTML = '';
  if (!activeDays.length) return;
  if (!activeMobileDay || !activeDays.includes(activeMobileDay)) activeMobileDay = activeDays[0];
  for (const day of activeDays) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `day-tab${day === activeMobileDay ? ' active' : ''}`;
    button.textContent = DAY_SHORT[day];
    button.setAttribute('aria-pressed', String(day === activeMobileDay));
    button.addEventListener('click', () => {
      activeMobileDay = day;
      document.querySelectorAll('.day-tab').forEach(tab => {
        const isActive = tab.dataset.day === day;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-pressed', String(isActive));
      });
      document.querySelectorAll('.day-column').forEach(column => {
        column.classList.toggle('mobile-active', column.dataset.day === day);
      });
    });
    button.dataset.day = day;
    els.dayNav.appendChild(button);
  }
}

function renderCalendar(records) {
  const allMeetings = records.flatMap((r, recordIndex) => r.days.map(day => ({ ...r, day, recordIndex })));
  if (!allMeetings.length) return;

  const activeDays = [...new Set(allMeetings.map(m => m.day))].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
  renderDayNav(activeDays);

  const starts = allMeetings.map(m => minutesFromTime(m.startTime)).filter(Number.isFinite);
  const ends = allMeetings.map(m => minutesFromTime(m.endTime)).filter(Number.isFinite);
  const minStart = Math.min(...starts);
  const maxEnd = Math.max(...ends);

  // Keep at least a one-hour breathing room before the first class while retaining
  // clean hourly labels. Give the bottom of the schedule the same visual breathing room.
  const gridStart = Math.max(0, Math.floor((minStart - 60) / 60) * 60);
  const gridEnd = Math.min(24 * 60, Math.ceil((maxEnd + 60) / 60) * 60);
  const hourCount = Math.max(1, (gridEnd - gridStart) / 60);
  const hourHeight = Math.max(58, Math.min(76, 640 / hourCount));
  const gridHeight = hourCount * hourHeight;
  const colors = courseColors(records);

  els.calendar.style.setProperty('--day-count', activeDays.length);
  els.calendar.style.setProperty('--hour-height', `${hourHeight}px`);
  els.calendar.style.setProperty('--hour-count', hourCount);
  els.calendar.style.setProperty('--grid-height', `${gridHeight}px`);
  els.calendar.dataset.mobileDay = activeMobileDay || activeDays[0];
  els.calendar.innerHTML = '';

  const timeColumn = document.createElement('div');
  timeColumn.className = 'time-column';
  const timeHeader = document.createElement('div');
  timeHeader.className = 'time-header';
  timeColumn.appendChild(timeHeader);
  const timeGrid = document.createElement('div');
  timeGrid.className = 'time-grid';
  for (let h = 0; h <= hourCount; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * hourHeight}px`;
    timeGrid.appendChild(line);
    if (h < hourCount) {
      const label = document.createElement('div');
      label.className = 'time-label';
      label.style.top = `${h * hourHeight}px`;
      label.textContent = formatMinutes(gridStart + h * 60);
      timeGrid.appendChild(label);
    }
  }
  timeColumn.appendChild(timeGrid);
  els.calendar.appendChild(timeColumn);

  for (const day of activeDays) {
    const dayColumn = document.createElement('div');
    dayColumn.className = `day-column${day === activeMobileDay ? ' mobile-active' : ''}`;
    dayColumn.dataset.day = day;
    const header = document.createElement('div');
    header.className = 'day-header';
    header.innerHTML = `<span>${DAY_SHORT[day]}</span>`;
    dayColumn.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'day-grid';
    for (let h = 0; h <= hourCount; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * hourHeight}px`;
      grid.appendChild(line);
    }

    const events = allMeetings.filter(m => m.day === day).map(m => ({
      ...m,
      start: minutesFromTime(m.startTime),
      end: minutesFromTime(m.endTime)
    }));
    const laidOut = overlapLayout(events);

    for (const event of laidOut) {
      const card = document.createElement('div');
      const duration = event.end - event.start;
      const family = courseFamilyKey(event.courseCode);
      const hue = colors.get(family) ?? 210;
      const shortCode = `${event.courseCode} · ${event.section}`;
      const professor = event.instructor ? event.instructor : '';
      const professorTitle = professor ? `title="${escapeHtml(professor)}"` : '';
      const location = formatRoom(event);

      card.className = 'class-card' + (duration < 70 ? ' compact' : '');
      const top = ((event.start - gridStart) / 60) * hourHeight;
      const height = Math.max(62, (duration / 60) * hourHeight - 8);
      const columnWidth = 100 / event.columns;
      const inset = event.columns > 1 ? 3 : 5;
      const visibleWidth = Math.max(58, columnWidth - inset * 2);
      card.style.top = `${top}px`;
      card.style.height = `${height}px`;
      card.style.left = `calc(${event.column * columnWidth}% + ${inset}px)`;
      card.style.width = `calc(${visibleWidth}% )`;
      card.style.setProperty('--course-hue', hue);
      card.setAttribute('title', `${event.title} · ${shortCode} · CRN ${event.crn}`);
      card.setAttribute('aria-label', `${event.title}, ${shortCode}, ${displayTime(event.startTime)} to ${displayTime(event.endTime)}, ${location}${professor ? `, ${professor}` : ''}`);
      card.innerHTML = `
        <div class="class-code">${escapeHtml(shortCode)}</div>
        <div class="class-time">${escapeHtml(displayTime(event.startTime))} – ${escapeHtml(displayTime(event.endTime))}</div>
        <div class="class-details${professor ? '' : ' solo'}">
          <span class="class-room" title="${escapeHtml(location)}">${escapeHtml(location)}</span>
          ${professor ? `<span class="class-meta" ${professorTitle}>${escapeHtml(professor)}</span>` : ''}
        </div>
      `;
      grid.appendChild(card);
    }
    dayColumn.appendChild(grid);
    els.calendar.appendChild(dayColumn);
  }
}

function renderPaletteControls() {
  els.palette.innerHTML = Object.entries(PALETTES).map(([key, palette]) => `
    <button type="button" class="palette-option${key === activePalette ? ' active' : ''}" data-palette="${key}" aria-pressed="${key === activePalette}">
      <span class="palette-dots" aria-hidden="true">
        <i></i><i></i><i></i>
      </span>
      <span class="palette-name">${escapeHtml(palette.label)}</span>
    </button>
  `).join('');

  els.palette.querySelectorAll('.palette-option').forEach(button => {
    button.addEventListener('click', () => {
      activePalette = button.dataset.palette;
      renderPaletteControls();
      if (!els.output.classList.contains('hidden') && window.__lastParsed) {
        renderCalendar(window.__lastParsed.records);
      }
    });
  });
}

function render(parsed, file) {
  window.__lastParsed = parsed;
  els.studentName.textContent = parsed.studentName || 'Student timetable';
  const dates = parsed.records.map(r => `${r.startDate}|${r.endDate}`);
  const sameDates = dates.length > 0 && dates.every(d => d === dates[0]);
  els.termName.textContent = `${parsed.term || 'Term'}${sameDates ? ` · ${formatDateRange(parsed.records[0].startDate, parsed.records[0].endDate)}` : ''}`;
  els.sourceLabel.textContent = file.name;
  els.parseMessage.textContent = parsed.warnings.length
    ? `${parsed.warnings.join(' ')} Please review before printing.`
    : `Parsed ${parsed.records.length} weekly meetings across ${uniqueCourseCount(parsed.records)} unique course${uniqueCourseCount(parsed.records) === 1 ? '' : 's'}.`;
  renderMetrics(parsed);
  renderCalendar(parsed.records);
  els.output.classList.remove('hidden');
  els.errorPanel.classList.add('hidden');
}

async function handleFile(file) {
  if (!file || (!/application\/pdf/i.test(file.type) && !/\.pdf$/i.test(file.name))) {
    showError('Please choose a Banner PDF file.', `Selected file type: ${file?.type || 'unknown'}`);
    return;
  }
  els.status.textContent = 'Reading PDF locally…';
  els.output.classList.add('hidden');
  els.errorPanel.classList.add('hidden');
  try {
    const pages = await extractPdf(file);
    const parsed = parseBanner(pages);
    if (parsed.records.length !== 8) {
      els.status.textContent = `Parsed ${parsed.records.length} validated course blocks. Review the timetable before printing.`;
    } else {
      els.status.textContent = '';
    }
    render(parsed, file);
  } catch (error) {
    showError(error.message || 'Unknown parsing error.', `${file.name}\n\n${error?.stack || error}`);
  }
}

function showError(message, diagnostics) {
  els.output.classList.add('hidden');
  els.errorPanel.classList.remove('hidden');
  const parts = String(message).split('\n\n');
  els.errorText.textContent = parts[0];
  els.diagnostics.textContent = diagnostics || parts.slice(1).join('\n\n');
  els.status.textContent = '';
}

renderPaletteControls();
els.input.addEventListener('change', e => handleFile(e.target.files[0]));
els.dropZone.addEventListener('click', () => els.input.click());
els.dropZone.setAttribute('role', 'button');
els.dropZone.setAttribute('tabindex', '0');
els.dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.input.click(); }
});
els.dropZone.addEventListener('dragover', e => { e.preventDefault(); els.dropZone.classList.add('dragging'); });
els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('dragging'));
els.dropZone.addEventListener('drop', e => {
  e.preventDefault();
  els.dropZone.classList.remove('dragging');
  handleFile(e.dataTransfer.files[0]);
});
els.print.addEventListener('click', () => {
  document.body.classList.add('exporting');
  window.requestAnimationFrame(() => window.print());
});
window.addEventListener('afterprint', () => document.body.classList.remove('exporting'));
