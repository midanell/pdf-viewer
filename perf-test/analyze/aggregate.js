/**
 * aggregate.js — reads results/raw.json, computes median + IQR per cell,
 * and writes results/summary.csv.
 *
 * Run with: node analyze/aggregate.js
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { resultsDir } from "../harness/paths.js";

const RESULTS_DIR = resultsDir();
const RAW_JSON = join(RESULTS_DIR, "raw.json");
const SUMMARY_CSV = join(RESULTS_DIR, "summary.csv");
const SUMMARY_JSON = join(RESULTS_DIR, "summary.json");

const METRICS = [
  "timeToFirstPage",
  "timeToDocumentReady",
  "heapAfterFirstPage",
  "heapAfterDocReady",
  "heapBottom",
  "heapAfterScrollBack",
  "longTaskCount",
  "longTaskTotalMs",
  "droppedFrames",
];

const rawLines = readFileSync(RAW_JSON, "utf8").trim().split("\n");
const runs = rawLines.map((l) => JSON.parse(l)).filter((r) => !r.discarded && !r.error);

// Group by label × pdf
const cells = {};
for (const run of runs) {
  const key = `${run.label}|||${run.pdf}`;
  cells[key] ??= [];
  cells[key].push(run);
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function iqr(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  return q3 - q1;
}

const summary = [];

for (const [key, cellRuns] of Object.entries(cells)) {
  const [label, pdf] = key.split("|||");
  const row = { label, pdf, n: cellRuns.length };

  for (const metric of METRICS) {
    const values = cellRuns.map((r) => r[metric]).filter((v) => v != null && Number.isFinite(v));
    if (values.length === 0) {
      row[`${metric}_median`] = null;
      row[`${metric}_iqr`] = null;
    } else {
      row[`${metric}_median`] = Math.round(median(values));
      row[`${metric}_iqr`] = Math.round(iqr(values));
    }
  }

  summary.push(row);
}

// Sort for readability
summary.sort((a, b) => {
  const labelOrder = ["baseline", "new-no-cache", "new-cache-cold", "new-cache-warm"];
  return (labelOrder.indexOf(a.label) - labelOrder.indexOf(b.label)) || a.pdf.localeCompare(b.pdf);
});

// Write JSON (used by chart and report scripts)
writeFileSync(SUMMARY_JSON, JSON.stringify(summary, null, 2));

// Write CSV
const headers = ["label", "pdf", "n", ...METRICS.flatMap((m) => [`${m}_median`, `${m}_iqr`])];
const csvLines = [
  headers.join(","),
  ...summary.map((row) => headers.map((h) => row[h] ?? "").join(",")),
];
writeFileSync(SUMMARY_CSV, csvLines.join("\n") + "\n");

console.log(`Aggregated ${runs.length} runs into ${summary.length} cells → ${SUMMARY_CSV}`);
