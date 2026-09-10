# Banner Timetable

A static, deterministic browser tool developed by Samir Daadouch that converts a Banner schedule PDF into a polished weekly timetable.

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

Created by Samir Daadouch, email: b00110561@aus.edu for any bugs/feedback
