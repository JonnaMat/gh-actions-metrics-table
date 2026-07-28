# GitHub Actions Metrics Table

Chrome extension: on a repo's Actions list page, aggregates each run's
step-summary tables (any two-column table headed `param | value` or
`metric | value`) into one sortable comparison table above the run list —
runs from all list pages (up to 20, respecting active filters). Uses your
GitHub session — no token.

## Install

`chrome://extensions` → Developer mode → Load unpacked → this directory.

## Features

- One row per run (status octicon, title, branch chip, date, avg), one
  column per param/metric; sticky run column; click headers to sort
  (asc → desc → off).
- **headline only** (default on): metrics whose summary row is `**bold**`;
  falls back to task-level keys when nothing is bolded.
- **numeric only** (default on): hides columns with no numeric values.
- **avg**: per-run mean of the shown metric columns.
- **columns ▾**: searchable show/hide per column (basic / params / metrics
  sections, included first); overrides win over toggles and filter.
- **filter box**: regex over all metric keys, overrides the toggles.
- Completed runs cached in `chrome.storage.local`; settings persist per repo.
