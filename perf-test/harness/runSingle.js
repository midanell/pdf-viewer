/**
 * runSingle.js — runs one benchmark iteration.
 *
 * Usage (CLI validation):
 *   node harness/runSingle.js [viewer] [pdf] [cacheFullPdf] [cacheState]
 *
 * viewer     = "custom" | "mozilla"   (default: "custom")
 * pdf        = filename in demo/      (default: "sample_1.pdf")
 * cacheFullPdf = "true" | "false"    (default: "false")
 * cacheState = "cold" | "warm" | ""  (default: "")
 */

import { chromium } from "playwright";
import { instrumentScript } from "./instrument.js";
import { waitForMark, waitForFrameMeasure, clearViewerCache, verifyCacheEmpty } from "./cacheControl.js";
import { standardScroll, mozillaScroll } from "./scrollPattern.js";

const BASE_URL = "http://localhost:3000/demo/";
const VIEWPORT = { width: 1440, height: 900 };

// How long to wait for marks before giving up.
const MARK_TIMEOUT_MS = 90_000;

export async function runSingle({
  viewer,
  pdf,
  cacheFullPdf,
  cacheState,
  browser,
  sharedContext = null,
  maxScrollSteps = null,
}) {
  const isMozilla = viewer === "mozilla";

  const params = new URLSearchParams();
  if (isMozilla) {
    params.set("pdf_mode", "mozilla");
  }
  if (cacheFullPdf) {
    params.set("full_pdf_cache", "on");
  }
  if (pdf) {
    params.set("pdf", pdf);
  }
  const url = `${BASE_URL}?${params}`;

  // Warm runs reuse a shared context so the HTTP cache (PDF bytes + pdf.js
  // worker/wasm assets) persists across the prime and measured iterations. Cold
  // and one-shot runs get a fresh context with the HTTP cache bypassed.
  const ownContext = !sharedContext;
  const context =
    sharedContext ??
    (await browser.newContext({ viewport: VIEWPORT }));

  // Bypass HTTP cache for cold runs so we actually measure from-network cost.
  if (cacheState === "cold") {
    await context.setExtraHTTPHeaders({ "Cache-Control": "no-store" });
  }

  const page = await context.newPage();

  // Inject performance observer + rAF tracker before any script runs.
  await page.addInitScript(instrumentScript);

  await page.goto(url, { waitUntil: "domcontentloaded" });

  let mozillaTTFP = null;
  if (isMozilla) {
    // The Mozilla viewer (viewer.mjs) is instrumented with the same marks as the
    // custom viewer: "pdf-load-start" (top of open(), before getDocument) and
    // "first-page-rendered" (page 1's canvas finished drawing), plus a
    // "time-to-first-page" measure between them. Those entries live in the
    // iframe's own performance timeline, so read the measure from the frame —
    // this is the same load-start → first-page window the custom viewer reports,
    // not the old "first <canvas> attached to DOM" proxy.
    mozillaTTFP = await waitForFrameMeasure(
      page,
      "/pdfjs-6.0.227-dist/web/viewer",
      "time-to-first-page",
      MARK_TIMEOUT_MS
    );
    if (mozillaTTFP == null) {
      // Instrumentation missing/failed — fall back to the canvas-attached proxy
      // so a run still produces a (less accurate) number rather than crashing.
      await page
        .frameLocator("#mozilla-frame")
        .locator("canvas")
        .first()
        .waitFor({ state: "attached", timeout: MARK_TIMEOUT_MS });
      mozillaTTFP = await page.evaluate(() => performance.now());
      console.warn(
        "  WARNING: mozilla 'time-to-first-page' measure not found — using canvas proxy (check viewer.mjs instrumentation)"
      );
    }
  }

  // Wait for the custom viewer's marks (mozilla falls back to canvas proxy above).
  const heapInitial = await page.evaluate(() => window.__sampleMemory());

  if (!isMozilla) {
    await waitForMark(page, "pdf-load-start", MARK_TIMEOUT_MS);
    await waitForMark(page, "first-page-rendered", MARK_TIMEOUT_MS);
    const heapAfterFirstPage = await page.evaluate(() => window.__sampleMemory());
    await waitForMark(page, "document-ready", MARK_TIMEOUT_MS);
    const heapAfterDocReady = await page.evaluate(() => window.__sampleMemory());

    // Clear viewer cache if cold run (after first page is shown).
    if (cacheState === "cold") {
      await clearViewerCache(page);
      const empty = await verifyCacheEmpty(page);
      if (!empty) {
        console.warn("  WARNING: cache clear verification failed — cold numbers may be warm");
      }
    }

    // Standard scroll.
    await standardScroll(page, { maxSteps: maxScrollSteps });
    const heapBottom = await page.evaluate(() => window.__sampleMemory());
    await page.evaluate(() => {
      const root = window.viewer?._scrollRoot ?? document.documentElement;
      root.scrollTop = 0;
    });
    await page.waitForTimeout(500);
    const heapAfterScrollBack = await page.evaluate(() => window.__sampleMemory());

    const metrics = await page.evaluate(() => window.__collectMetrics());

    await page.close();
    if (ownContext) await context.close();

    return {
      viewer,
      pdf,
      cacheFullPdf,
      cacheState,
      timeToFirstPage: metrics.measures["time-to-first-page"] ?? null,
      timeToDocumentReady: metrics.measures["time-to-document-ready"] ?? null,
      heapInitial: heapInitial?.usedJSHeapSize ?? null,
      heapAfterFirstPage: heapAfterFirstPage?.usedJSHeapSize ?? null,
      heapAfterDocReady: heapAfterDocReady?.usedJSHeapSize ?? null,
      heapBottom: heapBottom?.usedJSHeapSize ?? null,
      heapAfterScrollBack: heapAfterScrollBack?.usedJSHeapSize ?? null,
      longTaskCount: metrics.longTaskCount,
      longTaskTotalMs: metrics.longTaskTotalMs,
      droppedFrames: metrics.droppedFrames,
    };
  } else {
    // Mozilla: first canvas already appeared above. Let the initial viewport
    // settle, then sample heap.
    await page.waitForTimeout(500);
    const heapAfterDocReady = await page.evaluate(() => window.__sampleMemory());

    // Scroll inside the Mozilla viewer's own container (#viewerContainer), using
    // the same step/pause pattern as standardScroll for fairness.
    await mozillaScroll(page, { maxSteps: maxScrollSteps });
    const heapBottom = await page.evaluate(() => window.__sampleMemory());
    await page.frameLocator("#mozilla-frame").locator("#viewerContainer").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(500);
    const heapAfterScrollBack = await page.evaluate(() => window.__sampleMemory());

    const metrics = await page.evaluate(() => window.__collectMetrics());
    await page.close();
    if (ownContext) await context.close();

    return {
      viewer: "mozilla",
      pdf,
      cacheFullPdf: false,
      cacheState: null,
      timeToFirstPage: mozillaTTFP,
      timeToDocumentReady: null,
      heapInitial: heapInitial?.usedJSHeapSize ?? null,
      heapAfterFirstPage: null,
      heapAfterDocReady: heapAfterDocReady?.usedJSHeapSize ?? null,
      heapBottom: heapBottom?.usedJSHeapSize ?? null,
      heapAfterScrollBack: heapAfterScrollBack?.usedJSHeapSize ?? null,
      longTaskCount: metrics.longTaskCount,
      longTaskTotalMs: metrics.longTaskTotalMs,
      droppedFrames: metrics.droppedFrames,
    };
  }
}

// ── CLI entry point ────────────────────────────────────────────────────────────

if (process.argv[1].endsWith("runSingle.js")) {
  const [, , viewer = "custom", pdf = "sample_1.pdf", cacheStr = "false", cacheState = ""] = process.argv;
  const cacheFullPdf = cacheStr === "true";

  const browser = await chromium.launch({
    args: ["--enable-precise-memory-info"],
  });

  try {
    console.log(`Running single: viewer=${viewer} pdf=${pdf} cache=${cacheFullPdf} state=${cacheState || "n/a"}`);
    const result = await runSingle({ viewer, pdf, cacheFullPdf, cacheState: cacheState || null, browser });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}
