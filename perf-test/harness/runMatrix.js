/**
 * runMatrix.js — orchestrates the benchmark matrix.
 *
 * Profiles:
 *   (default)  full  — 4 configs × 3 PDFs × 10 iterations, full-document scroll.
 *   --quick          — 4 configs × 2 PDFs × 5 iterations, scroll capped to ~40
 *                      steps. Writes to results/quick/ so it never clobbers a
 *                      full-run dataset. ~15 min instead of ~2.5 h.
 *
 * Results stream to <resultsDir>/raw.json (NDJSON, one object per line).
 * Run with: node harness/runMatrix.js [--quick]
 */

import { chromium } from "playwright";
import { createWriteStream } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { runSingle } from "./runSingle.js";
import { isQuick, resultsDir } from "./paths.js";

const QUICK = isQuick();
const RESULTS_DIR = resultsDir();
const RAW_JSON = join(RESULTS_DIR, "raw.json");

const ITERATIONS = QUICK ? 5 : 10;
const DISCARD_FIRST = 1;
// Quick: cap forward scroll so the 200-page doc doesn't dominate wall time.
// null = scroll the whole document (full profile).
const MAX_SCROLL_STEPS = QUICK ? 40 : null;

const CONFIGS = [
  { viewer: "mozilla", cacheFullPdf: false, cacheState: null,   label: "baseline" },
  { viewer: "custom",  cacheFullPdf: false, cacheState: null,   label: "new-no-cache" },
  { viewer: "custom",  cacheFullPdf: true,  cacheState: "cold", label: "new-cache-cold" },
  { viewer: "custom",  cacheFullPdf: true,  cacheState: "warm", label: "new-cache-warm" },
];

// Quick profile skips the large PDF (the dominant cost ~75% of full-run time).
const PDFS = QUICK
  ? ["sample_1.pdf", "sample_2.pdf"]
  : ["sample_1.pdf", "sample_2.pdf", "sample.pdf"];

await mkdir(RESULTS_DIR, { recursive: true });
const stream = createWriteStream(RAW_JSON, { flags: "w" });

const browser = await chromium.launch({
  args: ["--enable-precise-memory-info"],
  headless: true,
});

let totalRuns = 0;
const totalExpected = CONFIGS.length * PDFS.length * ITERATIONS;
console.log(`Starting matrix [${QUICK ? "quick" : "full"}]: ${CONFIGS.length} configs × ${PDFS.length} PDFs × ${ITERATIONS} iterations = ${totalExpected} measured runs`);
console.log(`Output: ${RAW_JSON}\n`);

for (const config of CONFIGS) {
  for (const pdf of PDFS) {
    console.log(`\n[${config.label}] ${pdf}`);

    // Warm cells reuse one context across the whole cell so the HTTP cache
    // (PDF bytes + pdf.js assets) persists. The discarded warmup run primes it.
    const sharedContext =
      config.cacheState === "warm"
        ? await browser.newContext({ viewport: { width: 1440, height: 900 } })
        : null;

    for (let i = 0; i < ITERATIONS + DISCARD_FIRST; i++) {
      const isDiscard = i < DISCARD_FIRST;
      process.stdout.write(isDiscard ? "  warmup/prime run... " : `  run ${i - DISCARD_FIRST + 1}/${ITERATIONS}... `);

      try {
        const result = await runSingle({
          viewer: config.viewer,
          pdf,
          cacheFullPdf: config.cacheFullPdf,
          cacheState: config.cacheState,
          browser,
          sharedContext,
          maxScrollSteps: MAX_SCROLL_STEPS,
        });

        result.label = config.label;
        result.iteration = i - DISCARD_FIRST;
        result.discarded = isDiscard;
        result.timestamp = new Date().toISOString();

        stream.write(JSON.stringify(result) + "\n");

        if (!isDiscard) {
          totalRuns++;
          const ttfp = result.timeToFirstPage != null ? `${Math.round(result.timeToFirstPage)}ms` : "n/a";
          console.log(`ttfp=${ttfp} heap=${mb(result.heapAfterDocReady)}`);
        } else {
          console.log("done");
        }
      } catch (err) {
        console.error(`\n  ERROR: ${err.message}`);
        stream.write(JSON.stringify({ label: config.label, pdf, error: err.message, timestamp: new Date().toISOString() }) + "\n");
      }
    }

    if (sharedContext) await sharedContext.close();
  }
}

stream.end();
await browser.close();

console.log(`\nDone. ${totalRuns}/${totalExpected} runs recorded to ${RAW_JSON}`);

function mb(bytes) {
  if (bytes == null) return "n/a";
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
