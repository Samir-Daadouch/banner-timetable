import { parseBannerTextPages, parseBannerLines, minutesFromTime, formatMinutes, displayTime } from './banner-parser.js';
import { generateIcs } from './calendar-export.js';

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
  calendarExport: document.querySelector('#calendarExportButton'),
  compress: document.querySelector('#compressButton'),
  superCompress: document.querySelector('#superCompressButton'),
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
let currentParsed = null;
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
  let campus = String(event.campus || '').trim();
  let building = String(event.building || '').trim();
  let room = String(event.room || '').trim().replace(/\s*-\s*/g, ' - ');

  // Banner location text is verbose. Keep the useful building abbreviation and
  // room while removing campus-level prose for normal universities. Khalifa
  // University is the exception: keep the campus/building context when present.
  const includeCampus = Boolean(currentParsed?.isKhalifaUniversity);
  building = building
    .replace(/^Main Campus,\s*/i, '')
    .replace(/^Main Campus\s*/i, '')
    .trim();
  if (includeCampus && campus) {
    // Keep Khalifa campus context, while still presenting the normalized
    // building name and room.
    campus = campus.trim();
  } else {
    campus = '';
  }

  const buildingAliases = [
    [/^Engineering Building Left$/i, 'ELB'],
    [/^Engineering Building Right$/i, 'EB2'],
    [/^Engineering Building$/i, 'EB'],
    [/^Engineering Science Building$/i, 'ESB'],
    [/^Chemistry Building$/i, 'CHM'],
    [/^Science Building$/i, 'SB'],
    [/^School of Business Administrtn$/i, 'SBA'],
    [/^Language Building$/i, 'LAN'],
    [/^Physics Building$/i, 'PHY']
  ];
  for (const [pattern, alias] of buildingAliases) {
    if (pattern.test(building)) { building = alias; break; }
  }

  // Some room numbers already carry the building code (e.g. "EB2-109"), which
  // would otherwise duplicate the abbreviation we just prefixed.
  if (building && new RegExp(`^${building}[\\s-]`, 'i').test(room)) building = '';

  return [campus, building, room].filter(Boolean).join(' ').trim() || 'Location not listed';
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
  const superCompressed = els.timetable.classList.contains('super-compressed');
  const hourHeight = compressed || superCompressed || mobileWidth ? Math.max(38, Math.min(48, 400 / hourCount))
    : tabletWidth ? Math.max(48, Math.min(60, 520 / hourCount))
    : Math.max(58, Math.min(76, 640 / hourCount));
  const gridHeight = hourCount * hourHeight;
  const colors = courseColors(records);

  els.calendar.style.setProperty('--day-count', activeDays.length);
  els.calendar.style.setProperty('--hour-height', `${hourHeight}px`);
  els.calendar.style.setProperty('--hour-count', hourCount);
  els.calendar.style.setProperty('--grid-height', `${gridHeight}px`);
  els.calendar.dataset.mobileDay = activeMobileDay || activeDays[0];
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
      if (h === 0) label.classList.add('time-label-first');
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
      const professor = (mobileWidth && (event.end - event.start) < 60) ? '' : shortProfessor(event.instructor);
      const professorTitle = professor ? `title="${escapeHtml(professor)}"` : '';
      const location = formatRoom(event);
      const hideRoomInSuper = superCompressed && duration < 50;

      card.className = 'class-card' + (duration < 70 ? ' compact' : '');
      const top = ((event.start - gridStart) / 60) * hourHeight;
      const minimumCardHeight = compressed || superCompressed || mobileWidth ? 34 : tabletWidth ? 46 : 62;
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
          ${hideRoomInSuper ? '' : `<span class="class-room" title="${escapeHtml(location)}">${escapeHtml(location)}</span>`}
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
  document.querySelector('#tutorialPanel')?.classList.add('hidden');
  if (!file || (!/application\/pdf/i.test(file.type) && !/\.pdf$/i.test(file.name))) {
    showError('This file does not appear to be a PDF. Please upload your Banner schedule PDF.');
    return;
  }
  els.status.textContent = 'Reading PDF locally…';
  els.output.classList.add('hidden');
  els.errorPanel.classList.add('hidden');
  try {
    const pages = await extractPdf(file);
    const parsed = parseBanner(pages);
  currentParsed = parsed;
    if (parsed.records.length !== 8) {
      els.status.textContent = `Parsed ${parsed.records.length} validated course blocks. Review the timetable before printing.`;
    } else {
      els.status.textContent = '';
    }
    render(parsed, file);
  } catch (error) {
    console.error('Banner PDF parsing failed', error);
    showError('The parser could not read this PDF. Please make sure it is the official Banner schedule PDF.');
  }
}

function showError(message) {
  els.output.classList.add('hidden');
  els.errorPanel.classList.remove('hidden');
  els.errorText.textContent = String(message);
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
function getHtml2Canvas() {
  if (typeof window.html2canvas === 'function') return window.html2canvas;
  throw new Error('Image export library could not be loaded. Please check your internet connection and reload the page.');
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

function copyComputedTextStyles(source, target) {
  const cs = getComputedStyle(source);
  const properties = [
    'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch',
    'line-height', 'letter-spacing', 'text-transform', 'text-align',
    'text-decoration', 'text-overflow', 'white-space', 'color',
    'background-color', 'background-image', 'background-size', 'background-position',
    'background-repeat', 'border-top', 'border-right', 'border-bottom', 'border-left',
    'border-radius', 'box-shadow', 'opacity', 'overflow', 'box-sizing'
  ];
  for (const property of properties) {
    target.style.setProperty(property, cs.getPropertyValue(property));
  }
}

function flattenElementForCapture(source, target, sourceRootRect) {
  const rect = source.getBoundingClientRect();
  const left = rect.left - sourceRootRect.left;
  const top = rect.top - sourceRootRect.top;

  target.style.position = 'absolute';
  target.style.left = `${left}px`;
  target.style.top = `${top}px`;
  target.style.width = `${Math.max(0, rect.width)}px`;
  target.style.height = `${Math.max(0, rect.height)}px`;
  target.style.margin = '0';
  target.style.inset = 'auto';
  target.style.transform = 'none';
  target.style.flex = 'none';
  target.style.gridArea = 'auto';
  target.style.alignSelf = 'auto';
  target.style.justifySelf = 'auto';
  target.style.contain = 'none';
  copyComputedTextStyles(source, target);
}

async function captureTimetable() {
  const html2canvas = getHtml2Canvas();
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (document.fonts?.ready) await document.fonts.ready;

  const source = els.timetable;
  const sourceRootRect = source.getBoundingClientRect();
  const width = Math.max(1, sourceRootRect.width);
  const height = Math.max(1, sourceRootRect.height);

  // html2canvas does not reliably reproduce CSS Grid layout in every browser.
  // For PDF export, freeze the already-rendered screen geometry into absolute
  // coordinates first. This makes the export a pixel-faithful snapshot of what
  // the user is actually seeing, including compressed card details and padding.
  const stage = document.createElement('div');
  stage.setAttribute('aria-hidden', 'true');
  Object.assign(stage.style, {
    position: 'absolute',
    left: '-100000px',
    top: '0',
    width: `${width}px`,
    height: `${height}px`,
    overflow: 'hidden',
    pointerEvents: 'none',
    zIndex: '-1'
  });

  const clone = source.cloneNode(true);
  clone.removeAttribute('id');
  Object.assign(clone.style, {
    position: 'absolute',
    left: '0px',
    top: '0px',
    width: `${width}px`,
    height: `${height}px`,
    minWidth: `${width}px`,
    minHeight: `${height}px`,
    maxWidth: `${width}px`,
    maxHeight: `${height}px`,
    margin: '0',
    overflow: 'hidden'
  });
  copyComputedTextStyles(source, clone);
  stage.appendChild(clone);
  document.body.appendChild(stage);

  const sourceNodes = [source, ...source.querySelectorAll('*')];
  const cloneNodes = [clone, ...clone.querySelectorAll('*')];
  const count = Math.min(sourceNodes.length, cloneNodes.length);
  for (let i = 0; i < count; i++) {
    flattenElementForCapture(sourceNodes[i], cloneNodes[i], sourceRootRect);
  }

  try {
    const deviceScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const scale = Math.min(6, Math.max(2, deviceScale * 3));
    return await html2canvas(clone, {
      scale,
      width,
      height,
      backgroundColor: getComputedStyle(source).backgroundColor || '#ffffff',
      useCORS: true,
      logging: false,
      imageTimeout: 10000,
      removeContainer: true
    });
  } finally {
    stage.remove();
  }
}

let printExportInProgress = false;
let printFrame = null;

function cleanupPrintSnapshot() {
  if (printFrame) {
    printFrame.remove();
    printFrame = null;
  }
  printExportInProgress = false;
  els.print.disabled = false;
  els.print.textContent = 'Export PDF';
}

async function exportPdfOnePage() {
  if (!els.timetable) throw new Error('Timetable is not available for PDF export.');
  const canvas = await captureTimetable();
  const dataUrl = canvas.toDataURL('image/png');

  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, {
    position: 'fixed',
    width: '1px',
    height: '1px',
    right: '0',
    bottom: '0',
    border: '0',
    opacity: '0',
    pointerEvents: 'none'
  });
  document.body.appendChild(frame);
  printFrame = frame;

  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>Banner Timetable</title>
<style>
@page { size: A4 landscape; margin: 0; }
html, body { width: 297mm; height: 210mm; margin: 0; padding: 0; overflow: hidden; background: #fff; }
body { display: flex; align-items: center; justify-content: center; }
img { display: block; width: 297mm; height: 210mm; max-width: 297mm; max-height: 210mm; object-fit: contain; object-position: center; margin: 0; padding: 0; border: 0; }
</style></head><body><img id="print-image" alt="Timetable"></body></html>`);
  doc.close();
  const image = doc.getElementById('print-image');
  frame.contentWindow.addEventListener('afterprint', cleanupPrintSnapshot, { once: true });
  image.src = dataUrl;
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('Could not prepare the PDF snapshot.'));
  });
  printExportInProgress = true;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  frame.contentWindow.focus();
  frame.contentWindow.print();
}

els.print.addEventListener('click', async () => {
  if (!window.__lastParsed || printExportInProgress) return;
  const originalText = els.print.textContent;
  els.print.disabled = true;
  els.print.textContent = 'Preparing PDF…';
  try {
    await exportPdfOnePage();
  } catch (error) {
    console.error('PDF export failed', error);
    els.status.textContent = `PDF export failed: ${error?.message || 'unknown error'}`;
    cleanupPrintSnapshot();
    els.print.textContent = originalText;
  }
});

window.addEventListener('afterprint', cleanupPrintSnapshot);

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

const tutorialVideo = document.querySelector('#tutorialVideo');
const loadTutorialVideo = document.querySelector('#loadTutorialVideo');
loadTutorialVideo?.addEventListener('click', () => {
  if (!tutorialVideo || tutorialVideo.querySelector('iframe')) return;
  const videoId = tutorialVideo.dataset.videoId;
  const iframe = document.createElement('iframe');
  iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?rel=0&modestbranding=1`;
  iframe.title = 'Banner Timetable tutorial';
  iframe.loading = 'lazy';
  iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
  iframe.allowFullscreen = true;
  tutorialVideo.replaceChildren(iframe);
});


// Single site-wide dark mode toggle: also drives the timetable/calendar appearance
// so there is no seam between a dark page and a light calendar.
const siteThemeToggle = document.querySelector('#siteThemeToggle');
const SITE_THEME_KEY = 'bannerTimetableSiteTheme';
function applySiteTheme(isDark) {
  document.documentElement.classList.toggle('site-dark', isDark);
  document.body.classList.toggle('site-dark', isDark);
  els.timetable.classList.toggle('calendar-dark', isDark);
  siteThemeToggle.setAttribute('aria-checked', String(isDark));
}
const storedSiteTheme = localStorage.getItem(SITE_THEME_KEY);
const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
applySiteTheme(storedSiteTheme ? storedSiteTheme === 'dark' : prefersDark);
siteThemeToggle.addEventListener('click', () => {
  const isDark = !document.body.classList.contains('site-dark');
  applySiteTheme(isDark);
  localStorage.setItem(SITE_THEME_KEY, isDark ? 'dark' : 'light');
});
