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
  image: document.querySelector('#imageButton'),
  compress: document.querySelector('#compressButton'),
  theme: document.querySelector('#themeButton'),
  errorPanel: document.querySelector('#errorPanel'),
  errorText: document.querySelector('#errorText'),
  diagnostics: document.querySelector('#diagnostics')
};

const DAY_ORDER = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = { Sunday: 'Sun', Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat' };

const PALETTES = {
  blue:   { label: 'Blue', hues: [202, 218, 234, 250, 266, 194, 226, 242] },
  pink:   { label: 'Pink', hues: [318, 338, 356, 8, 326, 346, 16, 302] },
  yellow: { label: 'Yellow', hues: [25, 38, 50, 62, 72, 30, 45, 57] },
  green:  { label: 'Green', hues: [98, 112, 126, 140, 150, 104, 120, 132] },
  rainbow:{ label: 'Rainbow', hues: [198, 248, 294, 338, 24, 72, 126, 174] },
  oldBanner: { label: 'Old Banner', oldBanner: true, hues: [] }
};
let activePalette = 'blue';
let activeMobileDay = null;
let darkMode = false;

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
  // same parent course (e.g. trailing lab/recitation variants → parent course). Keep repeated days as one course.
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

function shortProfessor(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 2) return parts.join(' ');
  return `${parts[0]} ${parts[parts.length - 1]}`;
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
  const mobileWidth = window.matchMedia('(max-width: 600px)').matches;
  const tabletWidth = window.matchMedia('(max-width: 900px)').matches;
  const compressed = els.timetable.classList.contains('compressed');
  const hourHeight = compressed || mobileWidth ? Math.max(38, Math.min(48, 420 / hourCount))
    : tabletWidth ? Math.max(48, Math.min(60, 520 / hourCount))
    : Math.max(58, Math.min(76, 640 / hourCount));
  const gridHeight = hourCount * hourHeight;
  const colors = courseColors(records);

  els.calendar.style.setProperty('--day-count', activeDays.length);
  els.calendar.style.setProperty('--hour-height', `${hourHeight}px`);
  els.calendar.style.setProperty('--hour-count', hourCount);
  els.calendar.style.setProperty('--grid-height', `${gridHeight}px`);
  els.calendar.dataset.mobileDay = activeMobileDay || activeDays[0];
  document.body.classList.toggle('old-banner-design', activePalette === 'oldBanner');
  els.timetable.classList.toggle('old-banner', activePalette === 'oldBanner');
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
      const professor = (event.end - event.start) < 60 ? '' : shortProfessor(event.instructor);
      const professorTitle = professor ? `title="${escapeHtml(professor)}"` : '';
      const location = formatRoom(event);

      card.className = 'class-card' + (duration < 70 ? ' compact' : '');
      const top = ((event.start - gridStart) / 60) * hourHeight;
      const minimumCardHeight = compressed || mobileWidth ? 34 : tabletWidth ? 46 : 62;
      const height = Math.max(minimumCardHeight, (duration / 60) * hourHeight - (compressed || mobileWidth ? 4 : 8));
      const columnWidth = 100 / event.columns;
      const edgeToEdgeOldBanner = activePalette === 'oldBanner';
      const inset = edgeToEdgeOldBanner ? 0 : (event.columns > 1 ? 3 : 5);
      const visibleWidth = edgeToEdgeOldBanner ? columnWidth : Math.max(58, columnWidth - inset * 2);
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
let html2canvasLib;
let jsPdfLib;
async function loadHtml2Canvas() {
  if (html2canvasLib) return html2canvasLib;
  html2canvasLib = await import('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/+esm');
  return html2canvasLib.default || html2canvasLib;
}

async function loadJsPdf() {
  if (jsPdfLib) return jsPdfLib;
  const mod = await import('https://cdn.jsdelivr.net/npm/jspdf@3.0.1/+esm');
  jsPdfLib = mod.jsPDF || mod.default?.jsPDF || mod.default;
  return jsPdfLib;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function captureTimetable() {
  const html2canvas = await loadHtml2Canvas();
  return html2canvas(els.timetable, {
    scale: Math.min(3, Math.max(2, window.devicePixelRatio || 1)),
    backgroundColor: getComputedStyle(els.timetable).backgroundColor || '#ffffff',
    useCORS: true,
    logging: false,
    imageTimeout: 10000
  });
}

els.image.addEventListener('click', async () => {
  if (!window.__lastParsed) return;
  const originalText = els.image.textContent;
  els.image.disabled = true;
  els.image.textContent = 'Preparing image…';
  try {
    const canvas = await captureTimetable();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not create the PNG image.');
    const term = String(window.__lastParsed.term || 'timetable').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'timetable';
    downloadBlob(blob, `banner-timetable-${term}.png`);
  } catch (error) {
    els.status.textContent = `Image export failed: ${error?.message || 'unknown error'}`;
  } finally {
    els.image.disabled = false;
    els.image.textContent = originalText;
  }
});

els.compress.addEventListener('click', () => {
  const compressed = els.timetable.classList.toggle('compressed');
  els.compress.classList.toggle('active', compressed);
  els.compress.setAttribute('aria-pressed', String(compressed));
  els.compress.textContent = compressed ? 'Expand' : 'Compress';
  if (window.__lastParsed) renderCalendar(window.__lastParsed.records);
});

els.theme.addEventListener('click', () => {
  darkMode = !darkMode;
  els.timetable.classList.toggle('calendar-dark', darkMode);
  els.theme.classList.toggle('active', darkMode);
  els.theme.setAttribute('aria-pressed', String(darkMode));
  els.theme.textContent = darkMode ? 'Light' : 'Dark';
});

els.print.addEventListener('click', async () => {
  if (!window.__lastParsed) return;
  const originalText = els.print.textContent;
  els.print.disabled = true;
  els.print.textContent = 'Preparing PDF…';
  try {
    const [html2canvas, jsPDF] = await Promise.all([loadHtml2Canvas(), loadJsPdf()]);
    const canvas = await captureTimetable();
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
    const pageWidth = 297;
    const pageHeight = 210;
    const margin = 7;
    const maxWidth = pageWidth - margin * 2;
    const maxHeight = pageHeight - margin * 2;
    const ratio = Math.min(maxWidth / canvas.width, maxHeight / canvas.height);
    const width = canvas.width * ratio;
    const height = canvas.height * ratio;
    const x = (pageWidth - width) / 2;
    const y = (pageHeight - height) / 2;
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', x, y, width, height, undefined, 'FAST');
    const term = String(window.__lastParsed.term || 'timetable').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'timetable';
    pdf.save(`banner-timetable-${term}.pdf`);
  } catch (error) {
    els.status.textContent = `PDF export failed: ${error?.message || 'unknown error'}`;
  } finally {
    els.print.disabled = false;
    els.print.textContent = originalText;
  }
});

// Small, non-disruptive help/legal panels.
const tutorialButton = document.querySelector('#tutorialButton');
const legalButton = document.querySelector('#legalButton');
const tutorialPanel = document.querySelector('#tutorialPanel');
const legalPanel = document.querySelector('#legalPanel');
const closeTutorial = document.querySelector('#closeTutorial');
const closeLegal = document.querySelector('#closeLegal');
function toggleInfoPanel(panel, other) {
  other.classList.add('hidden');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
tutorialButton.addEventListener('click', () => toggleInfoPanel(tutorialPanel, legalPanel));
legalButton.addEventListener('click', () => toggleInfoPanel(legalPanel, tutorialPanel));
closeTutorial.addEventListener('click', () => tutorialPanel.classList.add('hidden'));
closeLegal.addEventListener('click', () => legalPanel.classList.add('hidden'));
