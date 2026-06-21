import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetObservers } from "./setup.js";

// ── Mock registry + data factories ────────────────────────────────────────────
// `vi.hoisted` runs before the `vi.mock` factories below, so the registry it
// returns is reachable from inside those factories. Every mocked collaborator
// records its instances here so tests can inspect constructor args and calls.
const { reg, makePdf, makePage, makeDeferred } = vi.hoisted(() => {
  const makeDeferred = () => {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const makePage = (n) => ({ pageNumber: n });
  const makePdf = (numPages = 3) => ({
    numPages,
    getPage: vi.fn((n) => Promise.resolve(makePage(n))),
    getDestination: vi.fn(() => Promise.resolve(null)),
    getPageIndex: vi.fn(() => Promise.resolve(0)),
  });
  const reg = {
    pageRenderers: [],
    toolbars: [],
    searches: [],
    thumbnails: [],
    loadings: [],
    linkServices: [],
    loadingTasks: [],
    manual: false, // when true, getDocument tasks must be resolved by the test
    nextPdf: null, // override the resolved pdf
    numPages: 3, // default pdf size when nextPdf is null
  };
  return { reg, makePdf, makePage, makeDeferred };
});

vi.mock("../src/worker.js", () => ({ PDF_ASSET_URLS: { __assets: true } }));

vi.mock("pdfjs-dist", () => ({
  getDocument: vi.fn((src) => {
    const d = makeDeferred();
    const task = {
      src,
      promise: d.promise,
      onProgress: null,
      destroy: vi.fn(() => Promise.resolve()),
      _resolve: d.resolve,
      _reject: d.reject,
    };
    reg.loadingTasks.push(task);
    if (!reg.manual) {
      Promise.resolve().then(() => d.resolve(reg.nextPdf ?? makePdf(reg.numPages)));
    }
    return task;
  }),
}));

vi.mock("../src/pageRenderer.js", () => {
  class PageRenderer {
    constructor(page, options = {}) {
      this.page = page;
      this.pageNumber = page.pageNumber;
      this.options = options;
      this.wrapper = document.createElement("div");
      this.wrapper.dataset.pageNumber = String(this.pageNumber);
      this._rendered = false;
      this._intendedScale = null;
      this._intendedRotation = 0;
      this.setSize = vi.fn(({ scale, rotation } = {}) => {
        this._intendedScale = scale;
        this._intendedRotation = rotation;
      });
      this.render = vi.fn(() => {
        this._rendered = true;
        return Promise.resolve();
      });
      this.cancel = vi.fn(() => Promise.resolve());
      this.discard = vi.fn(() => {
        this._rendered = false;
      });
      this.setCustomAnnotations = vi.fn();
      this.nativeWidthFor = vi.fn(() => 600);
      this.nativeHeightFor = vi.fn(() => 800);
      reg.pageRenderers.push(this);
    }
    get isRendered() {
      return this._rendered;
    }
  }
  return { PageRenderer };
});

vi.mock("../src/linkService.js", () => ({
  createLinkService: vi.fn((pdf, opts = {}) => {
    const ls = { pdf, onNavigate: opts.onNavigate };
    reg.linkServices.push(ls);
    return ls;
  }),
}));

vi.mock("../src/toolbar.js", () => {
  class PdfToolbar {
    constructor(host, options) {
      this.host = host;
      this.options = options;
      for (const m of [
        "updateZoom",
        "updateNav",
        "updateSearch",
        "updateFitWidth",
        "updateFitPage",
        "updateThumbnails",
        "focusSearch",
        "clearSearch",
        "destroy",
      ]) {
        this[m] = vi.fn();
      }
      this.isSearchFocused = vi.fn(() => false);
      reg.toolbars.push(this);
    }
  }
  return { PdfToolbar };
});

vi.mock("../src/search.js", () => {
  class PdfSearch {
    constructor(renderers, options) {
      this.renderers = renderers;
      this.options = options;
      this.search = vi.fn(() => Promise.resolve());
      this.nextMatch = vi.fn(() => Promise.resolve());
      this.prevMatch = vi.fn(() => Promise.resolve());
      this.applyToPage = vi.fn();
      this.setScrollBehavior = vi.fn();
      this.destroy = vi.fn();
      reg.searches.push(this);
    }
  }
  return { PdfSearch };
});

vi.mock("../src/thumbnails.js", () => {
  class PdfThumbnails {
    constructor(renderers, options) {
      this.renderers = renderers;
      this.options = options;
      this.panel = document.createElement("div");
      this.show = vi.fn();
      this.hide = vi.fn();
      this.setRotation = vi.fn();
      this.updateCurrentPage = vi.fn();
      this.destroy = vi.fn();
      reg.thumbnails.push(this);
    }
  }
  return { PdfThumbnails };
});

vi.mock("../src/loading.js", () => {
  class PdfLoading {
    constructor(host) {
      this.host = host;
      this.destroyed = false;
      this.update = vi.fn();
      this.destroy = vi.fn(() => {
        this.destroyed = true;
      });
      reg.loadings.push(this);
    }
  }
  return { PdfLoading };
});

// Import AFTER the mocks are registered (hoisting guarantees order).
import { PdfViewer } from "../src/viewer.js";

// ── Mount helpers ─────────────────────────────────────────────────────────────
const mounted = [];

function mountViewer(opts = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const viewer = new PdfViewer(host, opts);
  mounted.push(viewer);
  return { viewer, host };
}

async function loadViewer(opts = {}, { numPages = 3 } = {}) {
  reg.numPages = numPages;
  const m = mountViewer(opts);
  await m.viewer.load("doc.pdf");
  return m;
}

const pageNumbers = (viewer) => viewer.renderers.map((r) => r.pageNumber);

beforeEach(() => {
  for (const k of [
    "pageRenderers",
    "toolbars",
    "searches",
    "thumbnails",
    "loadings",
    "linkServices",
    "loadingTasks",
  ]) {
    reg[k].length = 0;
  }
  reg.manual = false;
  reg.nextPdf = null;
  reg.numPages = 3;
  resetObservers();
  document.body.innerHTML = "";
  document.getElementById("pdf-viewer-selection-style")?.remove();
});

afterEach(async () => {
  // Destroy mounted viewers so their window keydown listeners don't leak across
  // tests (the wheel/keydown listeners are removed in _unload).
  await Promise.all(mounted.splice(0).map((v) => v.destroy().catch(() => {})));
  vi.restoreAllMocks();
});

// ── Construction / options ────────────────────────────────────────────────────
describe("construction & option defaults", () => {
  it("uses fit-width / scale 1.5 / smooth / page 1 by default", () => {
    const { viewer } = mountViewer();
    expect(viewer.getZoom()).toEqual({ mode: "fit-width", scale: 1.5 });
    expect(viewer.getRotation()).toBe(0);
    expect(viewer.getScrollBehavior()).toBe("smooth");
    expect(viewer.getCurrentPage()).toBe(1);
    expect(viewer.getPageCount()).toBe(0);
  });

  it("honors explicit sizing + scale", () => {
    const { viewer } = mountViewer({ sizing: "explicit", scale: 2 });
    expect(viewer.getZoom()).toEqual({ mode: "explicit", scale: 2 });
  });

  it("normalizes scrollBehavior (instant kept, unknown -> smooth)", () => {
    expect(mountViewer({ scrollBehavior: "instant" }).viewer.getScrollBehavior()).toBe("instant");
    expect(mountViewer({ scrollBehavior: "nope" }).viewer.getScrollBehavior()).toBe("smooth");
  });

  it("injects the text-selection <style> once by default and skips it when disabled", () => {
    mountViewer();
    expect(document.querySelectorAll("#pdf-viewer-selection-style")).toHaveLength(1);
    mountViewer(); // idempotent — still one
    expect(document.querySelectorAll("#pdf-viewer-selection-style")).toHaveLength(1);

    document.getElementById("pdf-viewer-selection-style")?.remove();
    mountViewer({ nativeTextSelection: false });
    expect(document.getElementById("pdf-viewer-selection-style")).toBeNull();
  });
});

// ── load() ────────────────────────────────────────────────────────────────────
describe("load()", () => {
  it("builds renderers and reports page count", async () => {
    const { viewer } = await loadViewer({}, { numPages: 4 });
    expect(viewer.getPageCount()).toBe(4);
    expect(reg.pageRenderers).toHaveLength(4);
    expect(pageNumbers(viewer)).toEqual([1, 2, 3, 4]);
  });

  it("shapes the getDocument source for string and Uint8Array inputs", async () => {
    const pdfjs = await import("pdfjs-dist");
    await loadViewer();
    expect(pdfjs.getDocument).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: "doc.pdf", __assets: true })
    );

    const bytes = new Uint8Array([1, 2, 3]);
    const { viewer } = mountViewer();
    await viewer.load(bytes);
    expect(pdfjs.getDocument).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: bytes, __assets: true })
    );
  });

  it("creates the toolbar only when zoomControls !== false", async () => {
    await loadViewer();
    expect(reg.toolbars).toHaveLength(1);

    reg.toolbars.length = 0;
    await loadViewer({ zoomControls: false });
    expect(reg.toolbars).toHaveLength(0);
  });

  it("shows a loading overlay unless useCustomProgress is set, and removes it", async () => {
    await loadViewer();
    expect(reg.loadings).toHaveLength(1);
    expect(reg.loadings[0].destroyed).toBe(true);

    reg.loadings.length = 0;
    await loadViewer({ useCustomProgress: true });
    expect(reg.loadings).toHaveLength(0);
  });

  it("forwards progress to the onProgress callback and the overlay", async () => {
    reg.manual = true;
    const onProgress = vi.fn();
    const { viewer } = mountViewer();
    const p = viewer.load("doc.pdf", { onProgress });
    const task = reg.loadingTasks[0];
    expect(task.onProgress).toBeTypeOf("function");

    task.onProgress({ loaded: 50, total: 100 });
    expect(onProgress).toHaveBeenCalledWith({ loaded: 50, total: 100 });
    expect(reg.loadings[0].update).toHaveBeenCalledWith({ loaded: 50, total: 100 });

    task._resolve(makePdf(3));
    await p;
  });

  it("wires page + lazy + discard observers in normal mode", async () => {
    await loadViewer();
    expect(globalThis.__observers.intersection).toHaveLength(3);
    expect(globalThis.__observers.resize).toHaveLength(1);
  });

  it("renders every page and skips lazy/discard observers in cacheFullPdf mode", async () => {
    const { viewer } = await loadViewer({ cacheFullPdf: true }, { numPages: 3 });
    expect(globalThis.__observers.intersection).toHaveLength(1); // page observer only
    for (const pr of viewer.renderers) expect(pr.render).toHaveBeenCalled();
  });
});

// ── load() re-entrancy (locks in the overlay-leak fix) ────────────────────────
describe("load() re-entrancy", () => {
  it("supersedes an in-flight load without orphaning overlays or double-building", async () => {
    reg.manual = true;
    const { viewer } = mountViewer();

    const p1 = viewer.load("a.pdf");
    const p2 = viewer.load("b.pdf");
    expect(reg.loadingTasks).toHaveLength(2);

    // Resolve the stale (first) load last to provoke the race.
    reg.loadingTasks[0]._resolve(makePdf(3));
    reg.loadingTasks[1]._resolve(makePdf(3));
    await Promise.all([p1, p2]);

    // Only one build happened, and both overlays were cleaned up.
    expect(viewer.getPageCount()).toBe(3);
    expect(reg.pageRenderers).toHaveLength(3);
    expect(reg.loadings).toHaveLength(2);
    expect(reg.loadings.every((l) => l.destroyed)).toBe(true);
  });

  it("destroy() during an in-flight load aborts it cleanly", async () => {
    reg.manual = true;
    const { viewer, host } = mountViewer();
    const p = viewer.load("a.pdf");
    await viewer.destroy();
    reg.loadingTasks[0]._resolve(makePdf(3));
    await p;

    expect(viewer.getPageCount()).toBe(0);
    expect(host.children).toHaveLength(0);
    expect(reg.loadings[0].destroyed).toBe(true);
  });
});

// ── destroy() ─────────────────────────────────────────────────────────────────
describe("destroy()", () => {
  it("tears down content and collaborators", async () => {
    const { viewer, host } = await loadViewer();
    const [toolbar] = reg.toolbars;
    const [search] = reg.searches;
    const [thumbs] = reg.thumbnails;
    const renderers = viewer.renderers.slice();

    await viewer.destroy();

    expect(viewer.getPageCount()).toBe(0);
    expect(host.children).toHaveLength(0);
    expect(toolbar.destroy).toHaveBeenCalled();
    expect(search.destroy).toHaveBeenCalled();
    expect(thumbs.destroy).toHaveBeenCalled();
    for (const pr of renderers) expect(pr.cancel).toHaveBeenCalled();
  });

  it("is safe to call when nothing is loaded", async () => {
    const { viewer } = mountViewer();
    await expect(viewer.destroy()).resolves.toBeUndefined();
    expect(viewer.getPageCount()).toBe(0);
  });
});

// ── Zoom ──────────────────────────────────────────────────────────────────────
describe("zoom", () => {
  it("setZoom switches modes and updates the toolbar", async () => {
    const { viewer } = await loadViewer();

    await viewer.setZoom(2);
    expect(viewer.getZoom()).toEqual({ mode: "explicit", scale: 2 });
    for (const pr of viewer.renderers) {
      expect(pr.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ scale: 2 }));
    }
    expect(reg.toolbars[0].updateZoom).toHaveBeenCalled();
    expect(reg.toolbars[0].updateFitWidth).toHaveBeenLastCalledWith(false);
    expect(reg.toolbars[0].updateFitPage).toHaveBeenLastCalledWith(false);

    await viewer.setZoom("fit-page");
    expect(viewer.getZoom().mode).toBe("fit-page");
    await viewer.setZoom("fit-width");
    expect(viewer.getZoom().mode).toBe("fit-width");
  });

  it("a superseded zoom pass yields to the latest (no stale reflow)", async () => {
    const { viewer } = await loadViewer();
    const restoreSpy = vi.spyOn(viewer, "_restoreScrollAnchor");

    // Two rapid zooms without awaiting the first (mirrors the toolbar / keyboard
    // zoom callers, which don't await). The older pass must bail.
    const first = viewer.setZoom(2.0);
    const second = viewer.setZoom(3.0);
    await Promise.all([first, second]);

    // Only the winning (latest) pass restores the scroll anchor.
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(viewer.getZoom().scale).toBe(3.0);
    for (const pr of viewer.renderers) {
      expect(pr.setSize).toHaveBeenLastCalledWith(
        expect.objectContaining({ scale: 3.0 })
      );
    }
  });

  it("zoomIn / zoomOut walk the zoom steps and clamp at the ends", async () => {
    const { viewer } = await loadViewer();

    await viewer.setZoom(1.5);
    await viewer.zoomIn();
    expect(viewer.getZoom().scale).toBe(2.0);
    await viewer.zoomOut();
    expect(viewer.getZoom().scale).toBe(1.5);

    await viewer.setZoom(4.0);
    expect(viewer.zoomIn()).toBeUndefined(); // already at max
    expect(viewer.getZoom().scale).toBe(4.0);

    await viewer.setZoom(0.5);
    expect(viewer.zoomOut()).toBeUndefined(); // already at min
    expect(viewer.getZoom().scale).toBe(0.5);
  });

  it("Ctrl/Cmd+wheel zooms (throttled); a plain wheel does not", async () => {
    const { viewer } = await loadViewer();
    const inSpy = vi.spyOn(viewer, "zoomIn");
    const outSpy = vi.spyOn(viewer, "zoomOut");

    viewer._scrollRoot.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -1, ctrlKey: true, cancelable: true })
    );
    expect(inSpy).toHaveBeenCalledTimes(1);

    // Second event within the 100ms window is throttled.
    viewer._scrollRoot.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -1, ctrlKey: true, cancelable: true })
    );
    expect(inSpy).toHaveBeenCalledTimes(1);

    viewer._scrollRoot.dispatchEvent(new WheelEvent("wheel", { deltaY: 5, cancelable: true }));
    expect(outSpy).not.toHaveBeenCalled();
  });
});

// ── Rotation ──────────────────────────────────────────────────────────────────
describe("rotation", () => {
  it("rotates clockwise through 360 and propagates to renderers + thumbnails", async () => {
    const { viewer } = await loadViewer();
    for (const expected of [90, 180, 270, 0]) {
      await viewer.rotateClockwise();
      expect(viewer.getRotation()).toBe(expected);
    }
    expect(reg.thumbnails[0].setRotation).toHaveBeenLastCalledWith(0);
    expect(viewer.renderers[0].setSize).toHaveBeenLastCalledWith(
      expect.objectContaining({ rotation: 0 })
    );
  });

  it("rotates counter-clockwise", async () => {
    const { viewer } = await loadViewer();
    await viewer.rotateCounterclockwise();
    expect(viewer.getRotation()).toBe(270);
  });
});

// ── Navigation ────────────────────────────────────────────────────────────────
describe("navigation", () => {
  it("goToPage clamps, floors, scrolls, and updates current page", async () => {
    const { viewer } = await loadViewer({}, { numPages: 3 });

    viewer.goToPage(2);
    expect(viewer.getCurrentPage()).toBe(2);
    expect(viewer.renderers[1].wrapper.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
    expect(reg.toolbars[0].updateNav).toHaveBeenLastCalledWith(2, 3);
    expect(reg.thumbnails[0].updateCurrentPage).toHaveBeenLastCalledWith(2);

    viewer.goToPage(99);
    expect(viewer.getCurrentPage()).toBe(3);
    viewer.goToPage(0);
    expect(viewer.getCurrentPage()).toBe(1);
    viewer.goToPage(2.7);
    expect(viewer.getCurrentPage()).toBe(2);
  });

  it("goToPage is a no-op when nothing is loaded", () => {
    const { viewer } = mountViewer();
    expect(() => viewer.goToPage(2)).not.toThrow();
    expect(viewer.getCurrentPage()).toBe(1);
  });

  it("scroll detection follows the highest intersection ratio (unless scrolling)", async () => {
    const { viewer } = await loadViewer({}, { numPages: 3 });
    const pageObs = globalThis.__observers.intersection[0];
    const entries = viewer.renderers.map((pr, i) => ({
      target: pr.wrapper,
      intersectionRatio: i === 1 ? 0.9 : 0.1,
    }));

    pageObs.fire(entries);
    expect(viewer.getCurrentPage()).toBe(2);

    // While a programmatic scroll is in progress, observer updates are ignored.
    viewer.goToPage(1);
    pageObs.fire(entries);
    expect(viewer.getCurrentPage()).toBe(1);
  });
});

// ── Page ordering ─────────────────────────────────────────────────────────────
describe("page ordering", () => {
  it("promotes ordered pages, then appends the rest in natural order", async () => {
    const { viewer } = await loadViewer({ pageOrder: [3, 1] }, { numPages: 5 });
    expect(pageNumbers(viewer)).toEqual([3, 1, 2, 4, 5]);
  });

  it("dedupes and filters out-of-range entries", async () => {
    const { viewer } = await loadViewer({ pageOrder: [3, 3, 99, 0, 2] }, { numPages: 3 });
    expect(pageNumbers(viewer)).toEqual([3, 2, 1]);
  });

  it("setPageOrder rebuilds, and hideUnordered shows only the listed pages", async () => {
    const { viewer } = await loadViewer({}, { numPages: 5 });
    await viewer.setPageOrder([4, 2]);
    expect(pageNumbers(viewer)).toEqual([4, 2, 1, 3, 5]);

    await viewer.setPageOrder([4, 2], { hideUnordered: true });
    expect(pageNumbers(viewer)).toEqual([4, 2]);
    expect(viewer.getPageCount()).toBe(2);
  });

  it("setPageOrder before load resolves without throwing", async () => {
    const { viewer } = mountViewer();
    await expect(viewer.setPageOrder([2, 1])).resolves.toBeUndefined();
  });

  it("reordering reuses existing PageRenderer instances without re-rendering", async () => {
    const { viewer } = await loadViewer({}, { numPages: 3 });
    const originalRenderers = [...viewer.renderers];
    const rendererCountBefore = reg.pageRenderers.length;
    for (const pr of viewer.renderers) pr.render.mockClear();

    await viewer.setPageOrder([3, 1, 2]);

    // No new PageRenderer instances were created — the originals are reused.
    expect(reg.pageRenderers.length).toBe(rendererCountBefore);
    expect(viewer.renderers[0]).toBe(originalRenderers[2]); // page 3
    expect(viewer.renderers[1]).toBe(originalRenderers[0]); // page 1
    expect(viewer.renderers[2]).toBe(originalRenderers[1]); // page 2
    // In lazy mode the pipeline does not call render() — no re-rendering.
    for (const pr of originalRenderers) expect(pr.render).not.toHaveBeenCalled();
    expect(pageNumbers(viewer)).toEqual([3, 1, 2]);
  });

  it("an in-flight load is superseded by setPageOrder (no duplicate collaborators)", async () => {
    // Gate pdf.getPage so _buildVisiblePages is suspended in _instantiateRenderers
    // when setPageOrder bumps _buildGen. Without the guard the bailed build would
    // resume and create a second search/thumbnails instance.
    reg.manual = true;
    const { viewer } = mountViewer();

    const pdf = makePdf(4);
    let release;
    const gate = new Promise((r) => (release = r));
    const realGetPage = pdf.getPage;
    pdf.getPage = vi.fn(async (n) => { await gate; return realGetPage(n); });

    const searchesBefore = reg.searches.length;
    const thumbsBefore = reg.thumbnails.length;

    const loadPromise = viewer.load("doc.pdf");
    reg.loadingTasks[0]._resolve(pdf);
    // Tick 1: _openDocument resolves, _buildVisiblePages starts, awaits _teardownPages.
    // Tick 2: _teardownPages completes, _instantiateRenderers hits the gated getPage.
    await Promise.resolve();
    await Promise.resolve();

    // setPageOrder bumps _buildGen — the stale _buildVisiblePages will bail.
    const orderPromise = viewer.setPageOrder([3, 1, 2]);
    release();
    await Promise.all([loadPromise, orderPromise]);

    expect(reg.searches.length - searchesBefore).toBe(1);
    expect(reg.thumbnails.length - thumbsBefore).toBe(1);
    expect(pageNumbers(viewer)).toEqual([3, 1, 2, 4]);
    expect(viewer._pagesCol.children.length).toBe(viewer.renderers.length);
  });
});

// ── Custom annotations ────────────────────────────────────────────────────────
describe("custom annotations", () => {
  it("distributes only the matching page subset to each renderer", async () => {
    const { viewer } = await loadViewer({}, { numPages: 3 });
    for (const pr of viewer.renderers) pr.setCustomAnnotations.mockClear();

    const annos = [
      { page: 1, x: 0 },
      { page: 2, x: 1 },
      { page: 1, x: 2 },
      { x: 3 }, // no page -> defaults to page 1
    ];
    viewer.setCustomAnnotations(annos);

    expect(viewer.renderers[0].setCustomAnnotations).toHaveBeenLastCalledWith([
      { page: 1, x: 0 },
      { page: 1, x: 2 },
      { x: 3 },
    ]);
    expect(viewer.renderers[1].setCustomAnnotations).toHaveBeenLastCalledWith([{ page: 2, x: 1 }]);
    expect(viewer.renderers[2].setCustomAnnotations).toHaveBeenLastCalledWith([]);
  });

  it("tolerates a non-array argument", async () => {
    const { viewer } = await loadViewer();
    expect(() => viewer.setCustomAnnotations(null)).not.toThrow();
    for (const pr of viewer.renderers) {
      expect(pr.setCustomAnnotations).toHaveBeenLastCalledWith([]);
    }
  });
});

// ── Search ────────────────────────────────────────────────────────────────────
describe("search", () => {
  it("delegates search / nextMatch / prevMatch to PdfSearch", async () => {
    const { viewer } = await loadViewer();
    const [search] = reg.searches;

    viewer.search("foo", { matchCase: true });
    expect(search.search).toHaveBeenCalledWith("foo", { matchCase: true });

    viewer.nextMatch();
    expect(search.nextMatch).toHaveBeenCalled();
    viewer.prevMatch();
    expect(search.prevMatch).toHaveBeenCalled();
  });

  it("wires the toolbar onSearch callback to viewer.search", async () => {
    const { viewer } = await loadViewer();
    reg.toolbars[0].options.onSearch({ query: "bar", matchCase: false, wholeWord: true });
    expect(reg.searches[0].search).toHaveBeenCalledWith("bar", {
      matchCase: false,
      wholeWord: true,
    });
  });
});

// ── Thumbnails ────────────────────────────────────────────────────────────────
describe("thumbnails", () => {
  it("toggles the panel and notifies the toolbar", async () => {
    const { viewer } = await loadViewer();
    const [thumbs, toolbar] = [reg.thumbnails[0], reg.toolbars[0]];

    viewer.toggleThumbnails();
    expect(thumbs.show).toHaveBeenCalled();
    expect(toolbar.updateThumbnails).toHaveBeenLastCalledWith(true);

    viewer.toggleThumbnails();
    expect(thumbs.hide).toHaveBeenCalled();
    expect(toolbar.updateThumbnails).toHaveBeenLastCalledWith(false);
  });
});

// ── Scroll behavior ───────────────────────────────────────────────────────────
describe("scroll behavior", () => {
  it("normalizes the value and propagates it to search", async () => {
    const { viewer } = await loadViewer();

    viewer.setScrollBehavior("instant");
    expect(viewer.getScrollBehavior()).toBe("instant");
    expect(reg.searches[0].setScrollBehavior).toHaveBeenLastCalledWith("instant");

    viewer.setScrollBehavior("bogus");
    expect(viewer.getScrollBehavior()).toBe("smooth");
  });

  it("is safe to call before load", () => {
    const { viewer } = mountViewer();
    expect(() => viewer.setScrollBehavior("instant")).not.toThrow();
    expect(viewer.getScrollBehavior()).toBe("instant");
  });
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
describe("keyboard shortcuts", () => {
  it("Ctrl/Cmd+F focuses search only when focus is inside the host", async () => {
    const { viewer, host } = await loadViewer();

    // Focus outside the host -> ignored.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true }));
    expect(reg.toolbars[0].focusSearch).not.toHaveBeenCalled();

    viewer._scrollRoot.focus();
    expect(host.contains(document.activeElement)).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true }));
    expect(reg.toolbars[0].focusSearch).toHaveBeenCalled();
  });

  it("Ctrl/Cmd +/- zoom when focus is inside the host", async () => {
    const { viewer } = await loadViewer();
    const inSpy = vi.spyOn(viewer, "zoomIn");
    const outSpy = vi.spyOn(viewer, "zoomOut");
    viewer._scrollRoot.focus();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "=", ctrlKey: true, cancelable: true }));
    expect(inSpy).toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "-", ctrlKey: true, cancelable: true }));
    expect(outSpy).toHaveBeenCalled();
  });

  it("Escape clears search while the search box is focused", async () => {
    const { viewer } = await loadViewer();
    reg.toolbars[0].isSearchFocused.mockReturnValue(true);
    const searchSpy = vi.spyOn(viewer, "search");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(reg.toolbars[0].clearSearch).toHaveBeenCalled();
    expect(searchSpy).toHaveBeenCalledWith("");
  });
});

// ── Link service navigation ───────────────────────────────────────────────────
describe("link service navigation", () => {
  it("maps a PDF page number to the right visible page (respecting order)", async () => {
    const { viewer } = await loadViewer({ pageOrder: [3, 1] }, { numPages: 5 });
    expect(pageNumbers(viewer)).toEqual([3, 1, 2, 4, 5]);

    // onNavigate(2) -> PDF page 2 sits at visible index 3 -> current page 3.
    reg.linkServices.at(-1).onNavigate(2);
    expect(viewer.getCurrentPage()).toBe(3);
  });
});
