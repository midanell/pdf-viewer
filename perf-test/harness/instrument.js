// Injected into every page via page.addInitScript().
// Sets up long-task and dropped-frame tracking, exposes __collectMetrics().

const instrumentScript = `
(function () {
  window.__perf = { longTasks: [], droppedFrames: 0 };

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__perf.longTasks.push({
          start: entry.startTime,
          duration: entry.duration,
        });
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch (_) {
    // longtask not supported in this context
  }

  let lastRaf = null;
  function rafLoop(ts) {
    if (lastRaf !== null && ts - lastRaf > 32) {
      window.__perf.droppedFrames++;
    }
    lastRaf = ts;
    requestAnimationFrame(rafLoop);
  }
  requestAnimationFrame(rafLoop);

  window.__collectMetrics = function () {
    const marks = {};
    for (const e of performance.getEntriesByType("mark")) {
      marks[e.name] = e.startTime;
    }
    const measures = {};
    for (const e of performance.getEntriesByType("measure")) {
      measures[e.name] = e.duration;
    }
    const mem = performance.memory
      ? {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
        }
      : null;
    return {
      marks,
      measures,
      memory: mem,
      longTaskCount: window.__perf.longTasks.length,
      longTaskTotalMs: window.__perf.longTasks.reduce((s, t) => s + t.duration, 0),
      droppedFrames: window.__perf.droppedFrames,
    };
  };

  window.__sampleMemory = function () {
    return performance.memory
      ? {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
        }
      : null;
  };
})();
`;

export { instrumentScript };
