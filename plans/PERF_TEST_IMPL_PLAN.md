# Plan: Performance Test Harness (PERF_TEST_PLAN)

## Context

The demo app supports two viewers side-by-side: the new custom `src/` viewer and the off-the-shelf Mozilla PDF.js viewer (loaded in an iframe via `?pdf_mode=mozilla`). The goal is an automated Playwright benchmark that runs a standardized matrix of 4 configs × 3 PDF sizes × 10 iterations, collects timing/memory/smoothness metrics, and produces a markdown + PDF report comparing the two viewers.

All config values from the plan's "Fill these in" section are confirmed:
- `BASE_URL` = `http://localhost:3000/demo`
- Custom viewer param = `?pdf_mode=custom` (default, no param needed)
- Mozilla viewer param = `?pdf_mode=mozilla`
- Full cache param = `&full_pdf_cache=on`
- Cache clear mechanism = `window.viewer.clearCache()` (just implemented)
- Test PDFs already at `demo/sample_1.pdf` (~1MB), `demo/sample_2.pdf` (~4.8MB), `demo/sample.pdf` (~12MB)

---

## Step 1: Add `performance.mark` instrumentation to the custom viewer

**File: `src/viewer.js`**

Three marks, placed around existing awaits — no new async paths needed:

| Mark | Where | Code |
|------|--------|------|
| `pdf-load-start` | Top of `load()`, before `_loadInternal` | `performance.mark('pdf-load-start')` |
| `first-page-rendered` | In `_buildVisiblePages`, after `await this.renderers[0].render()` (line ~343) | `performance.mark('first-page-rendered')` |
| `document-ready` | In `_buildVisiblePages`, after `_startRenderPipeline()` (the viewer is interactive at this point) | `performance.mark('document-ready')` |

Also add `performance.measure` calls immediately after the marks:
```js
performance.measure('time-to-first-page', 'pdf-load-start', 'first-page-rendered');
performance.measure('time-to-document-ready', 'pdf-load-start', 'document-ready');
```

For the Mozilla iframe viewer — we cannot modify its source. The harness will use a `MutationObserver` watching the iframe's `contentDocument` for the first `<canvas>` element paint, recorded via `performance.now()` relative to navigation start, as a proxy for `first-page-rendered`.

---

## Step 2: Set up the `perf-test/` project

Create `perf-test/package.json` as a separate Node project (so its deps don't pollute the root):
```json
{
  "name": "pdf-viewer-perf-test",
  "type": "module",
  "scripts": {
    "install:browsers": "playwright install chromium",
    "run": "node harness/runMatrix.js",
    "analyze": "node analyze/aggregate.js && node analyze/charts.js"
  },
  "dependencies": {
    "@playwright/test": "^1.48.0",
    "playwright": "^1.48.0",
    "vega-lite": "^5.20.0",
    "vega": "^5.30.0",
    "canvas": "^2.11.0",
    "vega-node-canvas": "^1.0.0"
  }
}
```

---

## Step 3: Build the harness files

### `perf-test/harness/instrument.js`
Script injected into the page via `page.addInitScript()`. Sets up:
- `PerformanceObserver` for `longtask` entries (tasks > 50ms)
- rAF loop to detect dropped frames (delta > 32ms = dropped)
- Exposes `window.__perf = { longTasks: [], droppedFrames: 0 }`
- Helper `window.__collectMetrics()` that returns marks + measures + memory + long task count

### `perf-test/harness/scrollPattern.js`
Exports a `standardScroll(page, scrollContainer)` function:
- Scrolls from top to bottom in 500px increments with 300ms pauses between steps
- Then scrolls back to top
- Uses `page.evaluate` to drive `scrollContainer.scrollTop`
- Identical across all configs

### `perf-test/harness/cacheControl.js`
Exports:
- `clearViewerCache(page)` → `page.evaluate(() => window.viewer?.clearCache())`
- `verifyCacheEmpty(page)` → checks `window.viewer?.renderers.every(r => !r.isRendered)` (post-discard all renderers should be unrendered)
- `primeCacheWarm(page, runSingle)` → runs one priming load, waits for `document-ready`, discards result

### `perf-test/harness/runSingle.js`
Core runner. Accepts `{ viewer, cacheFullPdf, cacheState, pdf, viewport }`:
1. Creates a fresh browser context with `--enable-precise-memory-info`; for cold runs creates a new context to bust HTTP cache; for warm runs reuses the same context
2. Sets viewport to 1440×900
3. Adds `instrument.js` as init script
4. For mozilla: injects a MutationObserver on the iframe `contentDocument` to capture first-canvas timing
5. Navigates to `BASE_URL?pdf_mode=<viewer>&full_pdf_cache=<on|off>&pdf=<filename>` (needs demo/main.js to accept a `?pdf=` param — see Step 4)
6. Waits for `pdf-load-start` mark (polls `performance.getEntriesByName` every 50ms, timeout 30s)
7. Waits for `document-ready` mark (same polling, timeout 60s)
8. Samples `performance.memory` at: before load, after first-page, after document-ready
9. Runs `standardScroll()`
10. Samples memory again (bottom of scroll, back at top)
11. Calls `window.__collectMetrics()` and returns the result object

### `perf-test/harness/runMatrix.js`
Orchestrates the full 4 × 3 × 10 matrix:
```
configs = [
  { viewer: 'mozilla', cacheFullPdf: false, cacheState: null,  label: 'baseline' },
  { viewer: 'custom',  cacheFullPdf: false, cacheState: null,  label: 'new-no-cache' },
  { viewer: 'custom',  cacheFullPdf: true,  cacheState: 'cold', label: 'new-cache-cold' },
  { viewer: 'custom',  cacheFullPdf: true,  cacheState: 'warm', label: 'new-cache-warm' },
]
pdfs = ['sample_1.pdf', 'sample_2.pdf', 'sample.pdf']
ITERATIONS = 10
DISCARD_FIRST = 1
```
For each (config × pdf):
1. If warm: run one priming load first (discarded)
2. Run ITERATIONS + DISCARD_FIRST iterations, discard first
3. Write each run's raw result to `results/raw.json` (appended as it runs)

---

## Step 4: Patch `demo/main.js` to accept `?pdf=` param

The harness needs to load different PDFs per run. Currently `rebuild()` hardcodes `./sample.pdf`. Add URL param support:

```js
// in rebuild(), replace the hardcoded filename:
const pdfParam = new URLSearchParams(location.search).get('pdf') ?? 'sample.pdf';
await viewer.load(`./${pdfParam}`);
```

This is the only change to the demo — it does not break any existing behavior.

---

## Step 5: Build the analysis files

### `perf-test/analyze/aggregate.js`
Reads `results/raw.json`, groups by `(config × pdf × metric)`, computes **median and IQR** for each group. Writes `results/summary.csv`.

### `perf-test/analyze/charts.js`
Uses `vega-lite` to generate bar charts (median + IQR error bars):
- One chart per headline metric (`time-to-first-page`, `peak-heap`, `warm-vs-cold-speedup`)
- Grouped by config, faceted by PDF size
- Saves as SVG in `results/charts/`

### `perf-test/analyze/report.js`
Writes `results/REPORT.md` with:
- Environment details (machine, browser version, date)
- Summary table (inline)
- Embedded chart images
- Headline delta numbers
- Short narrative section (template with placeholders filled from aggregated data)

---

## Execution order

1. `cd perf-test && npm install && npm run install:browsers`
2. Start the dev server: `npm run dev` (from project root, `npx serve .` on port 3000)
3. Validate one run manually: `node harness/runSingle.js` (add a quick CLI entry point for this)
4. Verify cold vs warm cache control works (`verifyCacheEmpty` passes)
5. Run full matrix: `npm run run` (writes to `results/raw.json`)
6. Analyze: `npm run analyze` (writes `summary.csv`, charts, `REPORT.md`)

---

## Verification

- After Step 1: open demo in browser, load a PDF, open DevTools > Performance > User Timings — confirm `pdf-load-start`, `first-page-rendered`, `document-ready` marks appear
- After a single `runSingle.js` call: confirm the returned JSON has non-zero `timeToFirstPage`, `timeToDocumentReady`, and `heapAfterFirstPage`
- Sanity check (per the plan): cold `timeToFirstPage` > warm `timeToFirstPage` for cache config; peak memory for new viewer on large PDF < Mozilla baseline; IQR within a cell is tight

## Files to create/modify

| Path | Action |
|------|--------|
| `src/viewer.js` | Add 3 `performance.mark` + 2 `performance.measure` calls |
| `demo/main.js` | Add `?pdf=` URL param support in `rebuild()` |
| `perf-test/package.json` | New |
| `perf-test/harness/instrument.js` | New |
| `perf-test/harness/scrollPattern.js` | New |
| `perf-test/harness/cacheControl.js` | New |
| `perf-test/harness/runSingle.js` | New |
| `perf-test/harness/runMatrix.js` | New |
| `perf-test/analyze/aggregate.js` | New |
| `perf-test/analyze/charts.js` | New |
| `perf-test/analyze/report.js` | New |
| `perf-test/results/` | Created at runtime by harness |
