/**
 * report.js — generates results/REPORT.md from summary.json.
 * Run with: node analyze/report.js
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { isQuick, resultsDir } from "../harness/paths.js";

const RESULTS_DIR = resultsDir();
const SUMMARY_JSON = join(RESULTS_DIR, "summary.json");
const REPORT_MD = join(RESULTS_DIR, "REPORT.md");
const CHARTS_DIR = join(RESULTS_DIR, "charts");

const summary = JSON.parse(readFileSync(SUMMARY_JSON, "utf8"));

// Environment details
const date = new Date().toISOString().slice(0, 10);
let browserVersion = "unknown";
try {
  // playwright prints the version to stderr; capture from chromium --version
  browserVersion = execSync("npx playwright --version 2>&1 || true").toString().trim();
} catch (_) {}
const platform = process.platform + " " + process.arch;
const QUICK = isQuick();
const profileNote = QUICK
  ? "**quick** (5 iterations, scroll capped to ~40 steps, large PDF skipped) — for fast iteration, not the headline report"
  : "**full** (10 iterations, full-document scroll, all 3 PDFs)";

// Helper: find a cell's median value
function cell(label, pdf, metric) {
  const row = summary.find((r) => r.label === label && r.pdf === pdf);
  return row?.[`${metric}_median`] ?? null;
}

function ms(v) {
  return v != null ? `${Math.round(v)}ms` : "n/a";
}
function mb(v) {
  return v != null ? `${(v / 1024 / 1024).toFixed(1)} MB` : "n/a";
}
function pct(a, b) {
  if (a == null || b == null || b === 0) return "n/a";
  return `${Math.round(((b - a) / a) * 100)}%`;
}

// Summary table header
const pdfs = ["sample_1.pdf", "sample_2.pdf", "sample.pdf"];
const pdfLabels = { "sample_1.pdf": "Small", "sample_2.pdf": "Medium", "sample.pdf": "Large" };
const configs = ["baseline", "new-no-cache", "new-cache-cold", "new-cache-warm"];
const configLabels = {
  baseline: "Mozilla (baseline)",
  "new-no-cache": "Custom, no cache",
  "new-cache-cold": "Custom, cache cold",
  "new-cache-warm": "Custom, cache warm",
};

function summaryTable(metric, fmt) {
  const cols = pdfs.map((p) => pdfLabels[p]);
  const header = `| Config | ${cols.join(" | ")} |`;
  const sep = `|--------|${cols.map(() => "-------").join("|")}|`;
  const rows = configs.map((label) => {
    const cells = pdfs.map((pdf) => fmt(cell(label, pdf, metric)));
    return `| ${configLabels[label]} | ${cells.join(" | ")} |`;
  });
  return [header, sep, ...rows].join("\n");
}

// Chart image refs
let chartSection = "";
const chartFiles = (() => {
  try { return readdirSync(CHARTS_DIR); } catch { return []; }
})();
if (chartFiles.length > 0) {
  chartSection = chartFiles
    .filter((f) => f.endsWith(".svg"))
    .map((f) => `![${f}](charts/${f})`)
    .join("\n\n");
} else {
  chartSection = "_Charts not available — run `node analyze/charts.js` first._";
}

// Headline deltas
const headlineRows = pdfs.map((pdf) => {
  const mozillaFirst = cell("baseline", pdf, "timeToFirstPage");
  const newFirst = cell("new-no-cache", pdf, "timeToFirstPage");
  const newWarmFirst = cell("new-cache-warm", pdf, "timeToFirstPage");
  const newColdFirst = cell("new-cache-cold", pdf, "timeToFirstPage");
  return `| ${pdfLabels[pdf]} | ${ms(mozillaFirst)} | ${ms(newFirst)} | ${pct(mozillaFirst, newFirst)} | ${ms(newColdFirst)} → ${ms(newWarmFirst)} (warm speedup: ${pct(newColdFirst, newWarmFirst)}) |`;
}).join("\n");

const report = `# PDF Viewer Performance Report

## Environment

| Field | Value |
|-------|-------|
| Date | ${date} |
| Profile | ${profileNote} |
| Platform | ${platform} |
| Browser | ${browserVersion} |
| Viewport | 1440×900 |
| Iterations | ${QUICK ? 5 : 10} (first discarded as warmup) |
| PDFs | ${QUICK ? "sample_1.pdf (~1 MB), sample_2.pdf (~5 MB)" : "sample_1.pdf (~1 MB), sample_2.pdf (~5 MB), sample.pdf (~12 MB)"} |

---

## Headline Deltas (Time to First Page)

| PDF | Mozilla baseline | Custom no-cache | vs Baseline | Cold → Warm (cache speedup) |
|-----|-----------------|-----------------|-------------|------------------------------|
${headlineRows}

---

## Time to First Page (ms)

${summaryTable("timeToFirstPage", ms)}

## Peak Heap During Scroll

${summaryTable("heapBottom", mb)}

## Heap After Document Ready

${summaryTable("heapAfterDocReady", mb)}

## Total Long Task Time (ms)

${summaryTable("longTaskTotalMs", ms)}

---

## Charts

${chartSection}

---

## Methodology & Caveats

- **Custom viewer marks**: \`performance.mark\` at \`pdf-load-start\` (top of \`load()\`), \`first-page-rendered\` (after \`renderers[0].render()\`), \`document-ready\` (after \`_startRenderPipeline\`).
- **Mozilla viewer**: instrumented directly in \`viewer.mjs\` with the same marks as the custom viewer — \`pdf-load-start\` (top of \`open()\`, immediately before \`getDocument\`) and \`first-page-rendered\` (page 1's canvas finished drawing), with \`timeToFirstPage\` = the \`time-to-first-page\` measure between them. This is the same load-start → first-page-painted window the custom viewer reports, so the comparison is apples-to-apples (no DOM/MutationObserver proxy, and Mozilla's bundle-bootstrap time is excluded just as the custom viewer's module-load time is).
- **Cold runs**: HTTP cache bypassed via \`Cache-Control: no-store\` header; \`viewer.clearCache()\` called to discard in-memory canvas cache.
- **Warm runs**: one priming load performed and discarded before the ${QUICK ? 5 : 10} measured iterations.
- **Scroll pattern**: top → bottom in 500px steps with 300ms pauses → back to top. Identical across all configs.
- The new viewer renders lazily by design; its "time to document ready" reflects the first render pipeline start, not all-pages rendered.
`;

writeFileSync(REPORT_MD, report);
console.log(`Report written to ${REPORT_MD}`);
