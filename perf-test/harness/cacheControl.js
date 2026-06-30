// Controls viewer cache state between cold and warm runs.

export async function clearViewerCache(page) {
  await page.evaluate(() => window.viewer?.clearCache());
}

export async function verifyCacheEmpty(page) {
  return page.evaluate(() => {
    if (!window.viewer?.renderers?.length) return true;
    return window.viewer.renderers.every((r) => !r.isRendered);
  });
}

// Poll until a performance mark appears in the page, with a timeout.
export async function waitForMark(page, markName, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evaluate(
      (name) => performance.getEntriesByName(name, "mark").length > 0,
      markName
    );
    if (found) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`Timed out waiting for performance mark "${markName}"`);
}

// Poll a child frame (located by URL substring) until a performance *measure*
// of the given name exists, then return its duration. Used to read the Mozilla
// viewer's instrumented "time-to-first-page" measure, which lives in the iframe's
// own performance timeline rather than the top page. Returns null on timeout.
export async function waitForFrameMeasure(
  page,
  urlSubstring,
  measureName,
  timeoutMs = 60_000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frames().find((f) => f.url().includes(urlSubstring));
    if (frame) {
      const val = await frame
        .evaluate((name) => {
          const e = performance.getEntriesByName(name, "measure");
          return e.length ? e[0].duration : null;
        }, measureName)
        .catch(() => null); // frame may be mid-navigation/detached — retry
      if (val != null) return val;
    }
    await page.waitForTimeout(50);
  }
  return null;
}
