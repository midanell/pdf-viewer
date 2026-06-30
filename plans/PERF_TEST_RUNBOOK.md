# Perf Test Runbook — Running, Analyzing & Assembling Results

A standalone, repeatable procedure for re-running the PDF viewer performance benchmark.
Assumes the harness in `perf-test/` is already built (see `plans/PERF_TEST_IMPL_PLAN.md` for what
each file does). This document is just the operational steps to produce a fresh report.

---

## What the benchmark does

Runs a matrix of **4 configs × 3 PDFs × 10 iterations** (120 measured runs + 4×3 discarded warmups)
and produces median/IQR aggregates, charts, and a `REPORT.md`.

| # | Config label | Viewer | Full cache | Cache state |
|---|--------------|--------|-----------|-------------|
| 1 | `baseline` | Mozilla (iframe) | n/a | n/a |
| 2 | `new-no-cache` | Custom | off | n/a |
| 3 | `new-cache-cold` | Custom | on | cold (HTTP cache bypassed + `clearCache()`) |
| 4 | `new-cache-warm` | Custom | on | warm (shared context, primed once) |

PDFs: `sample_1.pdf` (~1 MB, small), `sample_2.pdf` (~5 MB, medium), `sample.pdf` (~12 MB, large).

---

## Prerequisites (one-time)

```bash
cd perf-test
npm install
npm run install:browsers     # downloads Playwright Chromium
```

Confirm the test PDFs exist in `demo/`: `sample.pdf`, `sample_1.pdf`, `sample_2.pdf`.

---

## Step 1 — Start the dev server

The harness drives a real browser against the demo over HTTP. From the **project root**:

```bash
npx serve . -p 3000
```

Verify it responds (note the **trailing slash** — without it the demo's relative
`./main.js` resolves to the wrong path):

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/demo/
# expect: 200
```

Leave this running in its own terminal for the duration of the benchmark.

---

## Step 2 — (Optional) Validate one run before the full matrix

Sanity-check a single run per viewer/cache path before committing to ~30–45 min:

```bash
cd perf-test
node harness/runSingle.js custom  sample_1.pdf false        # custom, no cache
node harness/runSingle.js custom  sample_1.pdf true  cold   # custom, cold cache
node harness/runSingle.js custom  sample_1.pdf true  warm   # custom, warm cache
node harness/runSingle.js mozilla sample_1.pdf false        # Mozilla baseline
```

Each prints a JSON result. **Expect**: non-null `timeToFirstPage` and heap numbers, and
roughly `mozilla > custom-no-cache > custom-cold > custom-warm` on time-to-first-page.

---

## Step 3 — Run the matrix

Two profiles. Pick based on whether you need the headline report or just fast feedback.

### Full profile (headline report)

```bash
cd perf-test
npm run run          # = node harness/runMatrix.js
```

- 4 configs × 3 PDFs × 10 iterations (+ 1 discarded warmup per cell) = 120 measured runs.
- Streams every run to `results/raw.json` as NDJSON.
- Full-document scroll-through on every run.
- **Takes ~2–2.5 h.** Wall time scales with page count, so the large 200-page PDF dominates
  (~75% of total). Measured per-run cost: small ~10 s, medium ~42 s, large ~145 s.

### Quick profile (fast iteration)

```bash
cd perf-test
npm run run:quick    # = node harness/runMatrix.js --quick
```

- 4 configs × 2 PDFs (large skipped) × 5 iterations = 40 measured runs.
- Scroll **capped to ~40 steps** so the long doc doesn't dominate.
- Writes to **`results/quick/`** — never clobbers a full-run dataset in `results/`.
- **Takes ~15 min.** Use it to validate harness changes or get a directional read; use the
  full profile for any numbers you publish.

> ⚠️ **Never run the two profiles (or two matrices) concurrently.** A second browser contends for
> CPU and corrupts both runs' timing/memory/frame measurements. The harness is sequential by design.

**Fairness (both profiles)**: viewport fixed at 1440×900, identical scroll cadence (300 ms pause /
500 px step) across all configs. Run plugged in, no other heavy apps. Note machine specs + browser version.

To change iteration counts, scroll cap, or the config/PDF lists, edit the constants at the top of
`harness/runMatrix.js` (`ITERATIONS`, `DISCARD_FIRST`, `MAX_SCROLL_STEPS`, `CONFIGS`, `PDFS`).

---

## Step 4 — Aggregate, chart, and write the report

Match the analyze command to the profile you ran — the `--quick` variant reads from and writes to
`results/quick/`:

```bash
cd perf-test
npm run analyze          # full  → reads/writes results/
npm run analyze:quick    # quick → reads/writes results/quick/
```

Produces (under `results/` or `results/quick/` accordingly):
- `summary.json` and `summary.csv` — median + IQR per (config × PDF × metric)
- `charts/*.svg` — bar charts (median bars + IQR rules), faceted by PDF size
- `REPORT.md` — environment (labeled with the profile), headline deltas, summary tables, embedded charts, caveats

Run the steps individually if a stage fails (append `--quick` for the quick dataset):
```bash
node analyze/aggregate.js
node analyze/charts.js
node analyze/report.js
```

---

## Step 5 — (Optional) Export REPORT.md to PDF

The report is Markdown with embedded SVG charts. To produce a shareable PDF, render
`results/REPORT.md` (e.g. via a Markdown-to-PDF tool or the editor's print-to-PDF). Ensure the
`charts/` SVGs sit alongside the report so the relative image paths resolve.

---

## Sanity checks before trusting results

- **Cold > warm**: `new-cache-cold` time-to-first-page should exceed `new-cache-warm`.
  If not, HTTP-cache control or context sharing is broken.
- **Leak check**: `heapAfterScrollBack` should return near `heapAfterFirstPage`. If heap climbs
  indefinitely across the scroll, flag a leak.
- **Lazy-rendering win**: on the large PDF, the custom viewer's peak heap (`heapBottom`) should be
  substantially below the Mozilla baseline. If not, lazy rendering/discarding may be misbehaving.
- **Tight spread**: IQR within a cell should be small relative to the median. Wide spread = noise;
  close other apps and re-run.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `Timed out waiting for performance mark "pdf-load-start"` | Dev server URL missing trailing slash, or server not running. Use `http://localhost:3000/demo/`. |
| `404 main.js` in page console | Same trailing-slash issue (`BASE_URL` in `harness/runSingle.js`). |
| Mozilla run: `Execution context was destroyed` | Iframe navigation race — the harness uses `frameLocator("#mozilla-frame")`; confirm the demo still uses iframe id `mozilla-frame`. |
| Charts fail to render | `aggregate.js` must run first (charts read `summary.json`). On render failure the script falls back to writing `*.vl.json` specs. |
| Warm == cold timings | Warm context not shared. `runMatrix` must create one `sharedContext` per warm cell and reuse it across the prime + iterations. |

---

## Caveats baked into the report
- The custom viewer renders **lazily**; `timeToDocumentReady` reflects when the render pipeline starts,
  not when all pages are rendered. Do not compare "time to render all pages" across viewers.
