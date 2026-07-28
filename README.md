# GitHub Actions Metrics Table

Chrome extension that turns a repo's **Actions list page** into an experiment dashboard.

For every workflow run visible on `github.com/<owner>/<repo>/actions`, it fetches the run's
page (using your existing GitHub session — no token needed) and extracts step-summary tables
matching the contract:

| param | value |        | metric | value |
|-------|-------|--------|--------|-------|
| …     | …     |        | …      | …     |

i.e. any two-column table whose header is `param | value` or `metric | value` (as produced by
e.g. a `summarize.py >> $GITHUB_STEP_SUMMARY` step). All runs are aggregated into a single
sortable comparison table injected above the run list.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this directory
4. Visit a repo's Actions page: `https://github.com/<owner>/<repo>/actions`

## Features

- One row per run styled like GitHub's own workflow list: status octicon + bold title
  (links to the run), branch chip, run date/time, then one column per param/metric;
  sticky run column and header; click a column header to sort (asc → desc → off).
- **avg** column: per-run mean of the *shown* numeric metric columns — hiding/showing
  columns via the toggles, filter, or dropdown changes what's averaged.
- **headline only** (default on): keeps only metrics marked as headline in the summary,
  i.e. rows written in **bold** (`**…**`). If a repo's summaries bold nothing, falls back to
  a heuristic: keys with ≤2 dotted segments or where the first two segments repeat
  (`mmlu.mmlu.acc,none` stays, `mmlu.mmlu_anatomy.…` hidden).
- **numeric only** (default on): hides columns where no run has a numeric value
  (e.g. `alias`/`name` string fields).
- **filter box**: regex (falls back to substring) matched against *all* metric keys,
  overriding both toggles — pull in any column on demand.
- **columns dropdown**: searchable checkbox list of every column — the fixed
  branch/date/avg columns, params, and metrics — sorted included-first then by name.
  Per-column show/hide overrides win over the toggles/filter and persist;
  "reset overrides" clears them.
- Completed runs are cached in `chrome.storage.local` (summaries are immutable);
  in-progress runs are re-fetched. **↻ refresh** bypasses the cache.
- Settings (toggles, filter, sort, collapsed state) persist per repo.
- Works on any repo: pages whose runs have no matching summary tables just show status-only rows.
