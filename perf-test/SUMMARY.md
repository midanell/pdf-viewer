# PDF Viewer Performance — Executive Summary

## Overview

A custom PDF viewer was built on Mozilla's PDF.js rendering engine to replace the
off-the-shelf Mozilla viewer. To validate the work, an automated benchmark was run
that compares the new custom viewer against the stock Mozilla viewer across a range
of document sizes, measuring load speed, memory footprint, and main-thread
responsiveness.

This document summarises **what was done**, **the methodology**, and **the results**.

---

## What Was Done

- Setup of a testing app, which integrates both the custom PDF viewer using PDF.js (v6) with lazy, on-demand page
  rendering and an LRU canvas cache for revisited pages as well as the stock Mozilla viewer (v6).
- Built a repeatable, automated performance harness that drives a real browser
  (Playwright/Chromium) against both viewers under identical conditions.
- Ran a full benchmark matrix and produced aggregated statistics and charts.

---

## Methodology

The benchmark exercises a matrix of **4 configurations × 3 PDFs × 10 iterations**
(120 measured runs), with the first iteration of each cell discarded as a warmup.

**Configurations compared:**

| Configuration | Description |
|---------------|-------------|
| Mozilla (baseline) | The stock off-the-shelf PDF.js viewer |
| Custom, no cache | New viewer with the canvas cache disabled |
| Custom, cache cold | New viewer, cache enabled but starting empty (HTTP + in-memory cache cleared) |
| Custom, cache warm | New viewer, cache pre-primed by a discarded load |

**Document sizes:** small (~1 MB), medium (~5 MB), and large (~12 MB / ~200 pages).

**Fairness controls:** fixed 1440×900 viewport, identical scroll cadence (500 px
steps with 300 ms pauses, top → bottom → top) across every configuration, and the
same start-of-load → first-page-painted measurement window for both viewers so the
comparison is apples-to-apples.

**Metrics captured:** time to first page, peak heap during scroll, heap after
document ready, and total long-task (main-thread blocking) time.

---

## Results

### Load speed (time to first page)

The custom viewer matches or beats the Mozilla baseline on medium and large
documents, and with a warm cache is fastest across the board. On the small document
the no-cache path is marginally slower than Mozilla, but the warm cache recovers
this and pulls ahead.

| PDF | Mozilla baseline | Custom (warm cache) | Improvement vs baseline |
|-----|------------------|---------------------|-------------------------|
| Small | 279 ms | 273 ms | ~2% faster |
| Medium | 525 ms | 403 ms | ~23% faster |
| Large | 558 ms | 473 ms | ~15% faster |

The cache delivers a consistent ~10% speedup from cold to warm on every document size.

### Memory footprint

Thanks to lazy rendering, the custom viewer holds a **lower peak heap** than the
Mozilla baseline, most notably on the small document (7.9 MB vs 11.5 MB) and the
large document (7.8 MB vs 9.9 MB). Memory after document-ready is comparable or
better across all sizes, with no evidence of leaks across the scroll cycle.

> **Note:** The memory figures reflect peak heap observed during a normal scroll
> pass. The footprint of the canvas cache at **full capacity** (the LRU cache
> fully saturated with the maximum number of retained pages) was not measured as a
> separate, dedicated metric. The reported peaks should therefore be read as
> representative of typical use rather than a worst-case ceiling on cache memory.

### Main-thread responsiveness

**Total Long Task Time** measures the cumulative duration of "long tasks" —
uninterrupted blocks of JavaScript that occupy the browser's main thread for more
than 50 ms. While a long task runs, the page cannot respond to scrolling, clicks, or
repaints, so this metric is a direct proxy for perceived stutter or "jank": the lower
the number, the smoother the experience.

Long-task time is negligible for the custom viewer — effectively 0 ms across all
document sizes — indicating smooth scrolling without main-thread stalls. By
comparison, the Mozilla baseline incurs a measurable stall on the small document
(111 ms), reflecting its eager, all-at-once rendering versus the custom viewer's
incremental, lazy approach.

---

## Conclusion

The custom viewer is **faster to first page on real-world (medium and large)
documents**, uses **less peak memory** through lazy rendering, and keeps the main
thread responsive during scrolling. The canvas cache provides a reliable additional
speedup on revisited content. Overall, the new viewer meets or exceeds the
off-the-shelf baseline on every headline metric while giving us full control over
the rendering pipeline.

*Full per-metric tables, charts, and methodology details are available in the
accompanying performance report.*
