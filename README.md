# Banner Timetable

A static, deterministic browser tool that converts a Banner schedule PDF into a polished weekly timetable.

## V1 scope

- Input: Banner schedule PDF only
- Text extraction: PDF.js in the browser
- Parsing: deterministic JavaScript, no AI/OCR
- Rendering: independent HTML/CSS calendar
- Privacy: the PDF is read locally and never uploaded to an application server
- Hosting: GitHub Pages compatible

## Files

- `index.html` — UI shell
- `styles.css` — screen + print styling
- `app.js` — PDF.js loading, file handling, metrics, and calendar renderer
- `banner-parser.js` — pure Banner parsing/normalization layer
- `package.json` — optional local-server/test commands
- `tests/banner-fixture.json` — exact PDF.js text-item fixture from the supplied AUS Banner PDF
- `tests/parser-test.mjs` — deterministic parser regression tests

## Parser reliability

The parser is intentionally independent from the renderer.

1. PDF.js produces text items.
2. `parseBannerLines()` reconstructs visual rows from PDF coordinates.
3. A course header is identified using a **course-code + section + date-range anchor**, not a fixed row number.
4. Each header owns the corridor up to the next header, so one course cannot borrow another course's meeting fields.
5. Credits and CRN are read from the normalized header text; `0.0` is valid and retained.
6. Days, time, location, and instructor are recognized by semantic patterns rather than fixed offsets.
7. Records are validated before rendering and deduplicated deterministically.
8. A flattened-text fallback is retained for extraction variants where coordinate rows cannot be reconstructed.

One important bug fixed from the previous version was an escaped newline in `app.js` (`'\\n'` instead of `'\n'`). That prevented the fallback text parser and student/term extraction from seeing real line boundaries.

Another subtle failure mode was fixed in the parser: matching against whitespace-normalized text and then slicing the original, unnormalized PDF text. With Banner's large column spacing, that could shift the slice back into the course number and turn values such as `3.0` into `221`. Header extraction now uses the same normalized string for both operations.

## Supplied PDF regression

The supplied AUS Fall 2026 PDF is expected to produce:

- Student: Samir Daadouch
- Term: Fall 2026
- Meetings: 8
- Credits: 16
- Teaching days: Monday through Thursday
- Earliest: 9:30 AM
- Latest: 5:50 PM
- Both 0-credit meetings retained

The fixture was built from the PDF.js text-item structure of the supplied PDF. The source schedule itself shows the eight course rows, including the 0-credit NGN 211R and CMP 220L meetings. fileciteturn0file0L6-L46

## Local run on macOS

Node is **not** required to run the website.

```bash
cd Banner-Timetable-Tool
python3 -m http.server 4173
```

Open `http://localhost:4173` and upload the Banner PDF.

For the parser regression suite, Node 18+ is recommended:

```bash
node tests/parser-test.mjs
```

Expected output contains five `PASS` lines.

## Test checklist

With the supplied PDF, verify:

- 8 class entries appear
- Total credits is 16
- Monday–Thursday are the only displayed teaching days
- Earliest class is 9:30 AM
- Latest class is 5:50 PM
- NGN 211R (0 credits) appears Thursday 5:00–5:50 PM
- CMP 220L (0 credits) appears Monday 2:00–3:50 PM
- Instructor names and rooms are visible directly on cards
- Export PDF opens the browser print dialog with an A4 landscape timetable print layout; it forces the full weekly view even when the app is being viewed on a phone
- No PDF data is uploaded by the application

The supplied PDF's first page contains the authoritative course table; its second page is Banner's visual weekly overview. The parser deliberately uses the structured course table rather than trying to infer data from the graphical weekly page. fileciteturn0file0L6-L10 fileciteturn0file0L50-L84

## GitHub Pages

1. Create a GitHub repository.
2. Put these project files in the repository root.
3. Push the files to the `main` branch.
4. Open **Settings → Pages**.
5. Choose **Deploy from a branch**.
6. Select `main` and `/(root)`.
7. Save.

The site will be available at `https://YOUR-USERNAME.github.io/REPOSITORY/`. If the repository itself is named `YOUR-USERNAME.github.io`, the site is served at the root domain `https://YOUR-USERNAME.github.io/`.

A `.nojekyll` file is included so GitHub Pages serves this plain static project directly. No backend or build step is required.

PDF.js is loaded from free public CDNs at runtime. The PDF bytes themselves are read in the browser and are not sent to the timetable application.


## Output UI

- Repeated weekday meetings remain one course; the Courses metric counts unique course families (trailing Banner L/R lab/recitation variants are grouped with the parent course).
- Class cards prioritize course code + section, time, compact building/room, and optional instructor. CRN, full title, and 0-credit badges are kept out of the dense card layout.
- Five preset palettes are available: Blue, Pink, Yellow, Green, and Rainbow. The same course family keeps the same color across repeated meetings.
- The timetable adds at least one hour of breathing room before the earliest class.
- On small screens, the timetable switches to one day at a time with day tabs instead of forcing a wide horizontal calendar. The upload card, toolbar, metrics, and class cards also reflow down to narrow phone widths.
- Professor names are placed in a compact bottom-right metadata slot; rooms stay bottom-left.
- Export / Save PDF intentionally reuses the timetable geometry and palette rather than the old condensed print typography, then asks the browser to save it as an A4 landscape PDF.
- The drop zone is also tap/click accessible, so mobile users can use either the large drop area or the file button.

## Hosting options

**Recommended: GitHub Pages.** This project is already structured as plain static HTML/CSS/JS, so GitHub Pages is the simplest free host. GitHub currently supports publishing a public repository on GitHub Free from a selected branch and folder. See the GitHub Pages setup instructions for the current UI.

**Alternative: Cloudflare Pages.** Cloudflare Pages also supports static HTML sites and has a free plan; its current limits include up to 500 builds/month. It is useful if you later want a custom domain or Cloudflare tooling, but it is unnecessary for V1.
