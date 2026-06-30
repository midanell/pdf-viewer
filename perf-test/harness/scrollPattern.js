// Standardized scroll pattern — identical across all configs for fair comparison.
// Scrolls from top to bottom in fixed increments, then back to top.
//
// `maxSteps` (optional) caps how many forward steps are taken before turning
// back. Used by the --quick profile to avoid scrolling the entire 200-page doc
// (which dominates wall time). null = scroll the whole document.

const STEP_PX = 500;
const PAUSE_MS = 300;

export async function standardScroll(
  page,
  { scrollSelector = ".scroll-wrapper", maxSteps = null } = {}
) {
  await page.evaluate(
    async ({ selector, step, pause, maxSteps }) => {
      const el = document.querySelector(selector) ?? document.documentElement;
      el.scrollTop = 0;

      const totalHeight = el.scrollHeight - el.clientHeight;
      let pos = 0;
      let steps = 0;

      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      while (pos < totalHeight && (maxSteps == null || steps < maxSteps)) {
        pos = Math.min(pos + step, totalHeight);
        el.scrollTop = pos;
        steps++;
        await sleep(pause);
      }

      // Scroll back to top
      el.scrollTop = 0;
      await sleep(pause);
    },
    { selector: scrollSelector, step: STEP_PX, pause: PAUSE_MS, maxSteps }
  );
}

// Same scroll pattern, but driven inside the Mozilla viewer iframe's
// #viewerContainer (its own scroll root).
export async function mozillaScroll(
  page,
  { frameSelector = "#mozilla-frame", maxSteps = null } = {}
) {
  await page
    .frameLocator(frameSelector)
    .locator("#viewerContainer")
    .evaluate(
      async (el, { step, pause, maxSteps }) => {
        el.scrollTop = 0;
        const totalHeight = el.scrollHeight - el.clientHeight;
        let pos = 0;
        let steps = 0;
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        while (pos < totalHeight && (maxSteps == null || steps < maxSteps)) {
          pos = Math.min(pos + step, totalHeight);
          el.scrollTop = pos;
          steps++;
          await sleep(pause);
        }
        el.scrollTop = 0;
        await sleep(pause);
      },
      { step: STEP_PX, pause: PAUSE_MS, maxSteps }
    );
}
