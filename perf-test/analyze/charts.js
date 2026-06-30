/**
 * charts.js — generates bar charts from results/summary.json using vega-lite.
 * Saves SVG files to results/charts/.
 *
 * Run with: node analyze/charts.js
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { compile } from "vega-lite";
import { View, parse } from "vega";
import { resultsDir } from "../harness/paths.js";

const RESULTS_DIR = resultsDir();
const CHARTS_DIR = join(RESULTS_DIR, "charts");
const SUMMARY_JSON = join(RESULTS_DIR, "summary.json");

mkdirSync(CHARTS_DIR, { recursive: true });

const summary = JSON.parse(readFileSync(SUMMARY_JSON, "utf8"));

const LABEL_ORDER = ["baseline", "new-no-cache", "new-cache-cold", "new-cache-warm"];
const PDF_ORDER = ["sample_1.pdf", "sample_2.pdf", "sample.pdf"];
const PDF_LABELS = {
  "sample_1.pdf": "Small (~1MB)",
  "sample_2.pdf": "Medium (~5MB)",
  "sample.pdf": "Large (~12MB)",
};

const CHART_DEFS = [
  {
    metric: "timeToFirstPage",
    title: "Time to First Page (ms)",
    file: "time_to_first_page.svg",
    unit: "ms",
  },
  {
    metric: "heapAfterDocReady",
    title: "Heap After Document Ready (bytes)",
    file: "heap_doc_ready.svg",
    unit: "bytes",
  },
  {
    metric: "heapBottom",
    title: "Peak Heap During Scroll (bytes)",
    file: "heap_peak.svg",
    unit: "bytes",
  },
  {
    metric: "longTaskTotalMs",
    title: "Total Long Task Time (ms)",
    file: "long_tasks.svg",
    unit: "ms",
  },
];

for (const def of CHART_DEFS) {
  const data = summary
    .filter((row) => row[`${def.metric}_median`] != null)
    .map((row) => ({
      label: row.label,
      pdf: PDF_LABELS[row.pdf] ?? row.pdf,
      median: row[`${def.metric}_median`],
      iqrLow: row[`${def.metric}_median`] - row[`${def.metric}_iqr`] / 2,
      iqrHigh: row[`${def.metric}_median`] + row[`${def.metric}_iqr`] / 2,
    }));

  if (data.length === 0) {
    console.log(`Skipping ${def.file} — no data`);
    continue;
  }

  const spec = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    title: def.title,
    width: 200,
    data: { values: data },
    facet: {
      column: {
        field: "pdf",
        type: "ordinal",
        sort: PDF_ORDER.map((p) => PDF_LABELS[p] ?? p),
        header: { title: "PDF Size" },
      },
    },
    spec: {
      layer: [
        {
          mark: "bar",
          encoding: {
            x: {
              field: "label",
              type: "ordinal",
              sort: LABEL_ORDER,
              axis: { labelAngle: -30, title: null },
            },
            y: {
              field: "median",
              type: "quantitative",
              title: def.unit === "bytes" ? "Heap (MB)" : "ms",
              scale: { zero: true },
            },
            color: {
              field: "label",
              type: "nominal",
              sort: LABEL_ORDER,
              legend: { title: "Config" },
            },
          },
        },
        {
          mark: { type: "rule", strokeWidth: 2, color: "black" },
          encoding: {
            x: {
              field: "label",
              type: "ordinal",
              sort: LABEL_ORDER,
            },
            y: { field: "iqrLow", type: "quantitative" },
            y2: { field: "iqrHigh" },
          },
        },
      ],
    },
    resolve: { scale: { y: "shared" } },
  };

  // vega-lite compile to vega, then render to SVG
  try {
    const vegaSpec = compile(spec).spec;
    const view = new View(parse(vegaSpec), { renderer: "none" });
    await view.runAsync();
    const svg = await view.toSVG();

    const outPath = join(CHARTS_DIR, def.file);
    writeFileSync(outPath, svg);
    console.log(`Chart written: ${outPath}`);
  } catch (err) {
    // Vega rendering requires native canvas in some environments.
    // Fall back to writing the spec as JSON for manual rendering.
    const outPath = join(CHARTS_DIR, def.file.replace(".svg", ".vl.json"));
    writeFileSync(outPath, JSON.stringify(spec, null, 2));
    console.warn(`Chart render failed (${err.message}); wrote spec to ${outPath}`);
  }
}
