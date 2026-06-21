import { PDF_ASSET_URLS } from "./worker.js";
import * as pdfjsLib from "pdfjs-dist";
import { PageRenderer } from "./pageRenderer.js";
import { createLinkService } from "./linkService.js";
import { PdfToolbar } from "./toolbar.js";
import { PdfSearch } from "./search.js";
import { PdfThumbnails } from "./thumbnails.js";
import { PdfLoading } from "./loading.js";

// Zoom
const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 4.0];
const ZOOM_EPSILON = 0.01; // tolerance when finding the next/prev zoom step
const MIN_SCALE = 0.1;

// Defaults
const DEFAULT_ZOOM_MODE = "fit-width";
const DEFAULT_SCALE = 1.5;
const DEFAULT_PAGE_MARGIN = "12px";

// Render scheduling
const CACHE_EAGER_RADIUS = 3; // pages each side of the current one to repaint eagerly
const IDLE_RENDER_TIMEOUT_MS = 200;
const LAZY_RENDER_MARGIN = "200px"; // pre-render pages this far before they enter view
const DISCARD_RENDER_MARGIN = "1500px"; // keep pages this far outside view before discarding
const PAGE_VISIBILITY_THRESHOLDS = [0, 0.25, 0.5, 0.75, 1];

// Input / timing
const WHEEL_ZOOM_THROTTLE_MS = 100;
const SCROLL_SUPPRESS_MS = 600; // ignore observer-driven page changes during a programmatic scroll
const RESIZE_DEBOUNCE_MS = 150;

export class PdfViewer {
  constructor(host, options = {}) {
    this.host = host;

    // Zoom / rotation state
    this._defaultZoomMode = options.sizing ?? DEFAULT_ZOOM_MODE;
    this._defaultScale = options.scale ?? DEFAULT_SCALE;
    this._zoomMode = this._defaultZoomMode; // "fit-width" | "fit-page" | "explicit"
    this._explicitScale = this._defaultScale;
    this._rotation = 0;

    // Options
    this._zoomControls = options.zoomControls ?? true;
    this._useCustomProgress = options.useCustomProgress ?? false;
    this._pageOrder = options.pageOrder ?? [];
    this._hideUnordered = options.hideUnorderedPages ?? false;
    this._customAnnotations = options.customAnnotations ?? [];
    this._pageMargin = options.margin ?? DEFAULT_PAGE_MARGIN;
    this._scrollBehavior =
      options.scrollBehavior === "instant" ? "instant" : "smooth";
    this._cacheFullPdf = options.cacheFullPdf === true;
    if (options.nativeTextSelection !== false) PdfViewer._injectSelectionStyle();

    // Document
    this.pdf = null;
    this.linkService = null;
    this._loadingTask = null;
    // Bumped on every load()/destroy() so a superseded in-flight load can detect
    // it is stale and stop (without orphaning its loading overlay).
    this._loadGen = 0;
    // Bumped to cancel an in-flight full-cache render pass.
    this._cacheToken = 0;
    // Bumped to cancel an in-flight non-cache _applyScale() pass so rapid zooms
    // don't overlap and race on each renderer's shared render state.
    this._scaleToken = 0;
    // Bumped on every page (re)build / unload so a superseded _buildVisiblePages
    // (e.g. overlapping setPageOrder calls) bails instead of corrupting state.
    this._buildGen = 0;

    // Renderers + lookup maps
    this.renderers = [];
    this._rendererByWrapper = new Map();
    this._slotByRenderer = new Map();

    // Observers
    this._observer = null; // ResizeObserver
    this._pageObserver = null; // current-page detection
    this._lazyObserver = null; // render-on-approach
    this._discardObserver = null; // discard-when-far

    // Geometry / scroll tracking
    this._lastWidth = 0;
    this._lastHeight = 0;
    this._resizeTimer = null;
    this._currentPage = 1;
    this._pageRatios = new Map();
    this._scrollingTo = false;
    this._scrollingToTimer = null;
    this._lastWheelZoom = 0;

    // Collaborators
    this._toolbar = null;
    this._search = null;
    this._thumbnails = null;
    this._thumbnailsActive = false;
    this._loading = null;

    // Layout DOM refs
    this._bodyRow = null;
    this._scrollWrapper = null;
    this._scrollRoot = null;
    this._contentRow = null;
    this._pagesCol = null;

    // Stored handlers (stable identity so add/removeEventListener pair up)
    this._onWheel = (e) => this._handleWheelZoom(e);
    this._onKeyDown = (e) => this._handleShortcut(e);
  }

  // ── Document lifecycle ──────────────────────────────────────────────────────

  async load(url, options = {}) {
    const gen = ++this._loadGen;
    // A previous load may still be in flight with its overlay showing; clear it
    // so overlays never stack or get orphaned in the host DOM.
    this._loading?.destroy();
    this._loading = null;

    let loading = null;
    if (!this._useCustomProgress) {
      this.host.style.position ||= "relative";
      loading = new PdfLoading(this.host);
      this._loading = loading;
    }
    try {
      return await this._loadInternal(url, options, gen);
    } finally {
      // Always remove THIS call's own overlay (idempotent), and only null the
      // shared field if a newer load hasn't already taken it over.
      loading?.destroy();
      if (this._loading === loading) this._loading = null;
    }
  }

  async _loadInternal(url, options = {}, gen = this._loadGen) {
    if (this.pdf) await this._unload();
    if (gen !== this._loadGen) return;
    this._resetLoadState();

    const pdf = await this._openDocument(
      this._buildDocumentSource(url),
      gen,
      options.onProgress
    );
    if (!pdf) return; // superseded while parsing
    this.pdf = pdf;
    this.linkService = createLinkService(this.pdf, {
      onNavigate: (pdfPageNum) => this._goToPdfPage(pdfPageNum),
    });

    this._buildLayoutDom();

    await this._buildVisiblePages();
    // Superseded while building pages — a newer load() (or destroy()) is now in
    // charge; stop before wiring observers/listeners for this stale document.
    if (gen !== this._loadGen) return;
    this._observe();
    this._attachInputListeners();
  }

  _resetLoadState() {
    this._rotation = 0;
    this._zoomMode = this._defaultZoomMode;
    this._explicitScale = this._defaultScale;
  }

  _buildDocumentSource(url) {
    if (typeof url === "string" || url instanceof URL) {
      return { url, ...PDF_ASSET_URLS };
    }
    if (url instanceof Uint8Array) {
      return { data: url, ...PDF_ASSET_URLS };
    }
    return { ...url, ...PDF_ASSET_URLS };
  }

  // Opens the document and returns the proxy, or null if this load was
  // superseded while parsing (in which case the half-loaded doc is discarded).
  async _openDocument(src, gen, onProgress) {
    const loadingTask = pdfjsLib.getDocument(src);
    this._loadingTask = loadingTask;
    loadingTask.onProgress = ({ loaded, total }) => {
      if (gen !== this._loadGen) return; // a newer load owns the overlay now
      this._loading?.update({ loaded, total });
      onProgress?.({ loaded, total });
    };

    let pdf;
    try {
      pdf = await loadingTask.promise;
    } finally {
      if (this._loadingTask === loadingTask) this._loadingTask = null;
    }

    if (gen !== this._loadGen) {
      await loadingTask.destroy().catch(() => {});
      return null;
    }
    return pdf;
  }

  async destroy() {
    this._loadGen++; // invalidate any in-flight load() so it stops and self-cleans
    this._loading?.destroy();
    this._loading = null;
    await this._unload();
  }

  async _unload() {
    this._buildGen++; // stop any in-flight _buildVisiblePages from mutating state
    (this._scrollRoot ?? window).removeEventListener("wheel", this._onWheel);
    window.removeEventListener("keydown", this._onKeyDown);
    this._observer?.disconnect();
    this._observer = null;
    clearTimeout(this._resizeTimer);
    clearTimeout(this._scrollingToTimer);
    this._toolbar?.destroy();
    this._toolbar = null;

    await this._disposePages();

    this._contentRow?.remove();
    this._contentRow = null;
    this._pagesCol = null;
    this._scrollWrapper?.remove();
    this._scrollWrapper = null;
    this._bodyRow?.remove();
    this._bodyRow = null;
    this._scrollRoot = null;

    const loadingTask = this._loadingTask;
    this._loadingTask = null;
    this.pdf = null;
    await loadingTask?.destroy();
  }

  // ── Layout / chrome ─────────────────────────────────────────────────────────

  _buildLayoutDom() {
    Object.assign(this.host.style, {
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    });
    this._createToolbar();
    this._buildScrollLayout();
    this._lastWidth = this._measureContentWidth();
    this._lastHeight = this._scrollRoot.clientHeight;
  }

  _createToolbar() {
    if (!this._zoomControls) return;
    this._toolbar = new PdfToolbar(this.host, {
      pageCount: this.pdf.numPages,
      currentPage: this._currentPage,
      scale: this._effectiveScale(),
      fitWidthActive: this._zoomMode === "fit-width",
      fitPageActive: this._zoomMode === "fit-page",
      thumbnailsActive: false,
      onPrev: () => this.goToPage(this._currentPage - 1),
      onNext: () => this.goToPage(this._currentPage + 1),
      onGoToPage: (n) => this.goToPage(n),
      onZoomIn: () => this.zoomIn(),
      onZoomOut: () => this.zoomOut(),
      onFitWidth: () => this.setZoom("fit-width"),
      onFitPage: () => this.setZoom("fit-page"),
      onRotateCW: () => this.rotateClockwise(),
      onRotateCCW: () => this.rotateCounterclockwise(),
      onThumbnails: () => this.toggleThumbnails(),
      onSearch: ({ query, matchCase, wholeWord }) =>
        this.search(query, { matchCase, wholeWord }),
      onPrevMatch: () => this.prevMatch(),
      onNextMatch: () => this.nextMatch(),
    });
  }

  _buildScrollLayout() {
    this._bodyRow = document.createElement("div");
    Object.assign(this._bodyRow.style, {
      flex: "1",
      minHeight: "0",
      display: "flex",
      width: "100%",
      padding: this._pageMargin,
    });
    this.host.appendChild(this._bodyRow);

    this._scrollWrapper = document.createElement("div");
    this._scrollWrapper.tabIndex = -1;
    Object.assign(this._scrollWrapper.style, {
      flex: "1",
      minWidth: "0",
      overflow: "auto",
      height: "100%",
      outline: "none",
    });
    this._bodyRow.appendChild(this._scrollWrapper);
    this._scrollRoot = this._scrollWrapper;

    this._contentRow = document.createElement("div");
    Object.assign(this._contentRow.style, {
      display: "flex",
      alignItems: "flex-start",
    });

    this._pagesCol = document.createElement("div");
    Object.assign(this._pagesCol.style, { flex: "1", minWidth: "0" });

    this._contentRow.appendChild(this._pagesCol);
    this._scrollWrapper.appendChild(this._contentRow);
  }

  _attachInputListeners() {
    (this._scrollRoot ?? window).addEventListener("wheel", this._onWheel, {
      passive: false,
    });
    window.addEventListener("keydown", this._onKeyDown);
  }

  // ── Page build & teardown ───────────────────────────────────────────────────

  async _buildVisiblePages() {
    // Tag this build so a newer one (an overlapping setPageOrder, a reload, or
    // destroy) can supersede it: each await below re-checks the generation and
    // bails before mutating shared state the winning build now owns.
    const gen = ++this._buildGen;
    await this._teardownPages();
    if (gen !== this._buildGen) return;

    const newRenderers = await this._instantiateRenderers(this._computeSlots());
    if (gen !== this._buildGen) return;

    this.renderers = newRenderers;
    this._rendererByWrapper = new Map(newRenderers.map((pr) => [pr.wrapper, pr]));
    this._slotByRenderer = new Map(newRenderers.map((pr, i) => [pr, i + 1]));

    this._mountRenderers();
    this._distributeCustomAnnotations();
    this._createSearchAndThumbnails();

    if (this.renderers[0]) {
      await this.renderers[0].render();
    }
    if (gen !== this._buildGen) return;
    this._toolbar?.updateZoom(this._effectiveScale());

    this._startRenderPipeline();

    this._currentPage = 1;
    if (this._scrollRoot) this._scrollRoot.scrollTop = 0;
    this._toolbar?.updateNav(this._currentPage, this.renderers.length);
    this._thumbnails?.updateCurrentPage(this._currentPage);
  }

  async _instantiateRenderers(slots) {
    const pages = await Promise.all(slots.map((n) => this.pdf.getPage(n)));
    return pages.map(
      (page) => new PageRenderer(page, { linkService: this.linkService })
    );
  }

  _mountRenderers() {
    this.renderers.forEach((pr, i, array) => {
      pr.setSize({ scale: this._scaleFor(pr), rotation: this._rotation });
      pr.wrapper.style.marginLeft = "auto";
      pr.wrapper.style.marginRight = "auto";
      pr.wrapper.style.marginBottom =
        i === array.length - 1 ? "0" : this._pageMargin;
      this._pagesCol.appendChild(pr.wrapper);
    });
  }

  _createSearchAndThumbnails() {
    this._search = new PdfSearch(this.renderers, {
      onUpdate: (cur, tot) => this._toolbar?.updateSearch(cur, tot),
      scrollBehavior: this._scrollBehavior,
    });

    this._thumbnails = new PdfThumbnails(this.renderers, {
      onNavigate: (n) => this.goToPage(n),
    });
    this._bodyRow.prepend(this._thumbnails.panel);
    if (this._thumbnailsActive) this._thumbnails.show();
    if (this._rotation !== 0) this._thumbnails.setRotation(this._rotation);
  }

  async _teardownPages() {
    if (!this.renderers.length) return;
    await this._disposePages();
  }

  // Shared renderer/observer/search/thumbnail teardown used by both a page
  // rebuild (_teardownPages) and a full unload (_unload).
  async _disposePages() {
    this._cacheToken++; // cancel any in-flight full-cache render pass
    this._scaleToken++; // cancel any in-flight non-cache _applyScale() pass
    this._pageObserver?.disconnect();
    this._lazyObserver?.disconnect();
    this._discardObserver?.disconnect();
    this._pageObserver = null;
    this._lazyObserver = null;
    this._discardObserver = null;

    this._search?.destroy();
    this._search = null;
    this._thumbnails?.destroy();
    this._thumbnails = null;

    // Capture and clear before the await so concurrent code (_reorderPages, a
    // new load) that reads this.renderers sees an empty list, and the post-await
    // cleanup operates on the right (pre-teardown) set regardless of what
    // concurrent code may have written to this.renderers in the meantime.
    const renderers = this.renderers;
    this.renderers = [];
    this._rendererByWrapper.clear();
    this._slotByRenderer.clear();
    this._pageRatios.clear();

    await Promise.all(renderers.map((pr) => pr.cancel().catch(() => {})));
    for (const pr of renderers) pr.wrapper.remove();
  }

  // ── Render scheduling ───────────────────────────────────────────────────────

  _startRenderPipeline() {
    this._setupPageObserver();
    if (this._cacheFullPdf) {
      // Render and retain every page (no lazy/discard observers); the eager pass
      // owns all rendering so there are no races with the lazy observer.
      this._renderAllCached();
    } else {
      this._setupLazyObserver();
      this._setupDiscardObserver();
    }
  }

  async _renderAllCached() {
    const token = ++this._cacheToken;
    // Render outward from the page in view: the visible window (current ±N)
    // repaints eagerly so zoom feels instant, then the rest fills in only when
    // the main thread is idle so background re-rendering never janks scrolling.
    const center = this._currentPage ?? 1;
    const distOf = (pr) =>
      Math.abs((this._slotByRenderer.get(pr) ?? center) - center);
    const order = [...this.renderers].sort((a, b) => distOf(a) - distOf(b));
    for (const pr of order) {
      if (token !== this._cacheToken || !this.pdf) return;
      if (distOf(pr) > CACHE_EAGER_RADIUS) await this._idleYield();
      if (token !== this._cacheToken || !this.pdf) return;
      try {
        await pr.render({
          scale: this._scaleFor(pr),
          rotation: this._rotation,
        });
      } catch (e) {
        if (e?.name !== "RenderingCancelledException") console.error(e);
        continue;
      }
      if (token !== this._cacheToken) return;
      this._search?.applyToPage(pr);
    }
  }

  // Resolve on the next idle slice (or next tick where unsupported) so queued
  // background page renders yield to user input, scrolling, and paint.
  _idleYield() {
    return new Promise((resolve) => {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => resolve(), { timeout: IDLE_RENDER_TIMEOUT_MS });
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  // Create an IntersectionObserver rooted at the scroll container and observe
  // every page wrapper with it.
  _observePages(callback, options) {
    const observer = new IntersectionObserver(callback, {
      root: this._scrollRoot,
      ...options,
    });
    for (const pr of this.renderers) observer.observe(pr.wrapper);
    return observer;
  }

  _setupPageObserver() {
    this._pageRatios = new Map();
    this._pageObserver = this._observePages(
      (entries) => this._onPageIntersection(entries),
      { threshold: PAGE_VISIBILITY_THRESHOLDS }
    );
  }

  _onPageIntersection(entries) {
    for (const entry of entries) {
      const pr = this._rendererByWrapper.get(entry.target);
      const slot = pr ? this._slotByRenderer.get(pr) : undefined;
      if (slot) this._pageRatios.set(slot, entry.intersectionRatio);
    }
    if (this._scrollingTo) return;

    let bestPage = 1;
    let bestRatio = 0;
    for (const [n, r] of this._pageRatios) {
      if (r > bestRatio) {
        bestRatio = r;
        bestPage = n;
      }
    }
    if (bestPage !== this._currentPage) {
      this._currentPage = bestPage;
      this._toolbar?.updateNav(this._currentPage, this.renderers.length);
      this._thumbnails?.updateCurrentPage(this._currentPage);
    }
  }

  _setupLazyObserver() {
    this._lazyObserver = this._observePages(
      (entries) => this._onLazyIntersection(entries),
      { rootMargin: LAZY_RENDER_MARGIN }
    );
  }

  _onLazyIntersection(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const pr = this._rendererByWrapper.get(entry.target);
      pr?.render()
        .then(() => this._search?.applyToPage(pr))
        .catch((e) => {
          if (e?.name !== "RenderingCancelledException") console.error(e);
        });
    }
  }

  _setupDiscardObserver() {
    this._discardObserver = this._observePages(
      (entries) => this._onDiscardIntersection(entries),
      { rootMargin: DISCARD_RENDER_MARGIN }
    );
  }

  _onDiscardIntersection(entries) {
    for (const entry of entries) {
      if (entry.isIntersecting) continue;
      const pr = this._rendererByWrapper.get(entry.target);
      if (pr?.isRendered) pr.discard();
    }
  }

  // ── Page ordering ───────────────────────────────────────────────────────────

  _computeSlots() {
    const total = this.pdf.numPages;
    const seen = new Set();
    const reorder = [];
    for (const raw of this._pageOrder ?? []) {
      const n = Math.floor(Number(raw));
      if (!Number.isFinite(n) || n < 1 || n > total) continue;
      if (seen.has(n)) continue;
      seen.add(n);
      reorder.push(n);
    }
    if (this._hideUnordered) return reorder;
    const natural = [];
    for (let n = 1; n <= total; n++) {
      if (!seen.has(n)) natural.push(n);
    }
    return [...reorder, ...natural];
  }

  // Fast reorder: reuse existing PageRenderer instances so already-rendered
  // canvases are preserved — no spinners for pages that were already painted.
  async _reorderPages() {
    const gen = ++this._buildGen;

    // Cancel in-flight render passes; do not destroy rendered canvases.
    this._cacheToken++;
    this._scaleToken++;
    this._pageObserver?.disconnect();
    this._lazyObserver?.disconnect();
    this._discardObserver?.disconnect();
    this._pageObserver = null;
    this._lazyObserver = null;
    this._discardObserver = null;

    const newSlots = this._computeSlots();
    const prevRenderers = this.renderers;
    const existingByPage = new Map(prevRenderers.map((pr) => [pr.pageNumber, pr]));

    // Clear shared state before any await so concurrent code sees a clean slate.
    this.renderers = [];
    this._rendererByWrapper.clear();
    this._slotByRenderer.clear();
    this._pageRatios.clear();

    // Fetch only pages not already instantiated.
    const neededNew = newSlots.filter((n) => !existingByPage.has(n));
    if (neededNew.length) {
      const pages = await Promise.all(neededNew.map((n) => this.pdf.getPage(n)));
      if (gen !== this._buildGen) return;
      for (let i = 0; i < neededNew.length; i++) {
        existingByPage.set(
          neededNew[i],
          new PageRenderer(pages[i], { linkService: this.linkService })
        );
      }
    }

    // Remove pages no longer in the new order.
    const newSlotSet = new Set(newSlots);
    for (const pr of prevRenderers) {
      if (!newSlotSet.has(pr.pageNumber)) {
        pr.cancel().catch(() => {});
        pr.wrapper.remove();
      }
    }

    // Build new renderer list and update wrapper margins.
    const newRenderers = newSlots.map((n) => existingByPage.get(n));
    newRenderers.forEach((pr, i, arr) => {
      pr.wrapper.style.marginLeft = "auto";
      pr.wrapper.style.marginRight = "auto";
      pr.wrapper.style.marginBottom =
        i === arr.length - 1 ? "0" : this._pageMargin;
    });

    // Size any newly instantiated renderers.
    for (const n of neededNew) {
      const pr = existingByPage.get(n);
      pr.setSize({ scale: this._scaleFor(pr), rotation: this._rotation });
    }

    // Reorder DOM without clearing canvas contents.
    this._pagesCol.replaceChildren(...newRenderers.map((pr) => pr.wrapper));

    this.renderers = newRenderers;
    this._rendererByWrapper = new Map(newRenderers.map((pr) => [pr.wrapper, pr]));
    this._slotByRenderer = new Map(newRenderers.map((pr, i) => [pr, i + 1]));

    // Rebuild order-sensitive collaborators.
    this._search?.destroy();
    this._search = null;
    this._thumbnails?.destroy();
    this._thumbnails = null;
    this._distributeCustomAnnotations();
    this._createSearchAndThumbnails();

    // Restart pipeline; already-rendered pages skip re-rendering via render()'s
    // early-return (same scale + rotation + no active task).
    this._startRenderPipeline();

    this._currentPage = 1;
    if (this._scrollRoot) this._scrollRoot.scrollTop = 0;
    this._toolbar?.updateNav(this._currentPage, this.renderers.length);
    this._thumbnails?.updateCurrentPage(this._currentPage);
  }

  setPageOrder(order, opts = {}) {
    this._pageOrder = order ?? [];
    this._hideUnordered = !!opts.hideUnordered;
    if (!this.pdf) return Promise.resolve();
    return this._reorderPages();
  }

  // ── Custom annotations ──────────────────────────────────────────────────────

  setCustomAnnotations(list) {
    this._customAnnotations = list ?? [];
    if (this.pdf) this._distributeCustomAnnotations();
  }

  _distributeCustomAnnotations() {
    const list = Array.isArray(this._customAnnotations)
      ? this._customAnnotations
      : [];
    for (const pr of this.renderers) {
      const subset = list.filter(
        (a) => a && (Math.floor(Number(a.page)) || 1) === pr.pageNumber
      );
      pr.setCustomAnnotations(subset);
    }
  }

  // ── Zoom ────────────────────────────────────────────────────────────────────

  setZoom(value) {
    if (value === "fit-width") {
      this._zoomMode = "fit-width";
    } else if (value === "fit-page") {
      this._zoomMode = "fit-page";
    } else {
      this._zoomMode = "explicit";
      this._explicitScale = value;
    }
    return this._reflowPreservingAnchor(() => {
      this._toolbar?.updateZoom(this._effectiveScale());
      this._toolbar?.updateFitWidth(this._zoomMode === "fit-width");
      this._toolbar?.updateFitPage(this._zoomMode === "fit-page");
    });
  }

  zoomIn() {
    const current = this._effectiveScale();
    const next = ZOOM_STEPS.find((s) => s > current + ZOOM_EPSILON);
    if (next !== undefined) return this.setZoom(next);
  }

  zoomOut() {
    const current = this._effectiveScale();
    const prev = [...ZOOM_STEPS].reverse().find((s) => s < current - ZOOM_EPSILON);
    if (prev !== undefined) return this.setZoom(prev);
  }

  getZoom() {
    return { mode: this._zoomMode, scale: this._effectiveScale() };
  }

  // Re-layout every page at the current scale/rotation. In cache mode this lays
  // out synchronously then repaints in the background; otherwise it re-renders
  // the already-rendered pages and lets the lazy observer handle the rest.
  async _applyScale() {
    const rotation = this._rotation;
    if (this._cacheFullPdf) {
      // Lay out every page synchronously (so scroll-anchor restore is correct),
      // then re-render all cached canvases at the new scale in the background.
      for (const pr of this.renderers) {
        pr.setSize({ scale: this._scaleFor(pr), rotation });
      }
      this._renderAllCached();
      return true;
    }
    // Rapid zooms can call _applyScale() repeatedly without awaiting; tag this
    // pass so a superseded one stops before re-laying-out for a stale scale.
    const token = ++this._scaleToken;
    await Promise.all(
      this.renderers.map((pr) => {
        const scale = this._scaleFor(pr);
        pr.setSize({ scale, rotation });
        if (pr.isRendered) {
          return pr.render({ scale, rotation }).catch((e) => {
            if (e?.name !== "RenderingCancelledException") console.error(e);
          });
        }
        return Promise.resolve();
      })
    );
    return token === this._scaleToken;
  }

  _effectiveScale() {
    if (this._zoomMode === "explicit") return this._explicitScale;
    if (this.renderers.length) {
      const pr0 = this.renderers[0];
      return pr0._intendedScale ?? this._scaleFor(pr0);
    }
    return this._explicitScale;
  }

  _scaleFor(renderer) {
    if (this._zoomMode === "fit-width")
      return this._fitScaleFor(renderer, this._lastWidth);
    if (this._zoomMode === "fit-page") return this._fitPageScaleFor(renderer);
    return this._explicitScale;
  }

  _fitScaleFor(renderer, width) {
    return Math.max(width / renderer.nativeWidthFor(this._rotation), MIN_SCALE);
  }

  _fitPageScaleFor(renderer) {
    const byHeight = this._lastHeight / renderer.nativeHeightFor(this._rotation);
    const byWidth = this._fitScaleFor(renderer, this._lastWidth);
    return Math.max(Math.min(byHeight, byWidth), MIN_SCALE);
  }

  // ── Rotation ────────────────────────────────────────────────────────────────

  rotateClockwise() {
    this._rotation = (this._rotation + 90) % 360;
    return this._applyRotation();
  }

  rotateCounterclockwise() {
    this._rotation = (this._rotation + 270) % 360;
    return this._applyRotation();
  }

  getRotation() {
    return this._rotation;
  }

  _applyRotation() {
    return this._reflowPreservingAnchor(() => {
      this._thumbnails?.setRotation(this._rotation);
      this._toolbar?.updateZoom(this._effectiveScale());
    });
  }

  // ── Navigation & scroll ─────────────────────────────────────────────────────

  goToPage(n) {
    const total = this.renderers.length;
    if (total === 0) return;
    n = Math.max(1, Math.min(total, Math.floor(n)));
    const pr = this.renderers[n - 1];
    if (!pr) return;
    // Suppress observer-driven page changes while the smooth scroll animates.
    this._scrollingTo = true;
    clearTimeout(this._scrollingToTimer);
    this._scrollingToTimer = setTimeout(() => {
      this._scrollingTo = false;
    }, SCROLL_SUPPRESS_MS);
    this._currentPage = n;
    this._toolbar?.updateNav(this._currentPage, total);
    this._thumbnails?.updateCurrentPage(n);
    pr.wrapper.scrollIntoView({ behavior: this._scrollBehavior, block: "start" });
  }

  _goToPdfPage(pdfPageNum) {
    const idx = this.renderers.findIndex((r) => r.pageNumber === pdfPageNum);
    if (idx >= 0) this.goToPage(idx + 1);
  }

  getCurrentPage() {
    return this._currentPage;
  }

  getPageCount() {
    return this.renderers.length;
  }

  setScrollBehavior(behavior) {
    this._scrollBehavior = behavior === "instant" ? "instant" : "smooth";
    this._search?.setScrollBehavior(this._scrollBehavior);
  }

  getScrollBehavior() {
    return this._scrollBehavior;
  }

  // Keep the page under the viewport's top edge fixed across a re-layout: note
  // the anchor before re-scaling, then scroll so it lands in the same place.
  _reflowPreservingAnchor(afterReflow) {
    const anchor = this._captureScrollAnchor();
    return this._applyScale().then((current) => {
      // A newer reflow superseded this one mid-flight; it owns the final layout
      // and chrome update, so don't fight it by restoring this pass's anchor.
      if (!current) return;
      this._restoreScrollAnchor(anchor);
      afterReflow();
    });
  }

  _captureScrollAnchor() {
    if (!this._scrollRoot) return null;
    const rootTop = this._scrollRoot.getBoundingClientRect().top;
    for (const pr of this.renderers) {
      const rect = pr.wrapper.getBoundingClientRect();
      if (rect.bottom <= rootTop) continue;
      return { pr, ratio: Math.max(0, (rootTop - rect.top) / rect.height) };
    }
    return null;
  }

  _restoreScrollAnchor(anchor) {
    if (!anchor || !this._scrollRoot) return;
    const rect = anchor.pr.wrapper.getBoundingClientRect();
    const rootTop = this._scrollRoot.getBoundingClientRect().top;
    const anchorY = rect.top + anchor.ratio * anchor.pr.wrapper.offsetHeight;
    this._scrollRoot.scrollTop += anchorY - rootTop;
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  search(query, opts) {
    return this._search?.search(query, opts);
  }

  nextMatch() {
    return this._search?.nextMatch();
  }

  prevMatch() {
    return this._search?.prevMatch();
  }

  // ── Thumbnails ──────────────────────────────────────────────────────────────

  toggleThumbnails() {
    this._thumbnailsActive = !this._thumbnailsActive;
    if (this._thumbnailsActive) this._thumbnails?.show();
    else this._thumbnails?.hide();
    this._toolbar?.updateThumbnails(this._thumbnailsActive);
  }

  // ── Resize handling ─────────────────────────────────────────────────────────

  _observe() {
    const widthTarget = this._pagesCol ?? this.host;
    this._observer = new ResizeObserver((entries) =>
      this._onResize(entries, widthTarget)
    );
    this._observer.observe(widthTarget);
    if (this._scrollRoot && this._scrollRoot !== widthTarget) {
      this._observer.observe(this._scrollRoot);
    }
  }

  _onResize(entries, widthTarget) {
    let widthChanged = false;
    let heightChanged = false;
    for (const entry of entries) {
      if (entry.target === widthTarget) {
        const w =
          entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
        if (Math.abs(w - this._lastWidth) >= 1) {
          this._lastWidth = w;
          widthChanged = true;
        }
      } else if (entry.target === this._scrollRoot) {
        const h =
          entry.contentBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        if (Math.abs(h - this._lastHeight) >= 1) {
          this._lastHeight = h;
          heightChanged = true;
        }
      }
    }
    const relevant =
      (this._zoomMode === "fit-width" && widthChanged) ||
      (this._zoomMode === "fit-page" && (heightChanged || widthChanged));
    if (!relevant) return;
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => {
      this._applyScale().then((current) => {
        if (current) this._toolbar?.updateZoom(this._effectiveScale());
      });
    }, RESIZE_DEBOUNCE_MS);
  }

  _measureContentWidth() {
    const target = this._pagesCol ?? this.host;
    const cs = getComputedStyle(target);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    return target.clientWidth - padL - padR;
  }

  // ── Input handlers ──────────────────────────────────────────────────────────

  _handleWheelZoom(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const now = Date.now();
    if (now - this._lastWheelZoom < WHEEL_ZOOM_THROTTLE_MS) return;
    this._lastWheelZoom = now;
    if (e.deltaY < 0) this.zoomIn();
    else if (e.deltaY > 0) this.zoomOut();
  }

  _handleShortcut(e) {
    const key = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && key === "f") {
      if (!this.host.contains(document.activeElement)) return;
      e.preventDefault();
      this._toolbar?.focusSearch();
      return;
    }
    if (
      (e.metaKey || e.ctrlKey) &&
      (key === "+" || key === "=" || key === "-" || key === "_")
    ) {
      if (!this.host.contains(document.activeElement)) return;
      e.preventDefault();
      if (key === "-" || key === "_") this.zoomOut();
      else this.zoomIn();
      return;
    }
    if (key === "escape" && this._toolbar?.isSearchFocused()) {
      e.preventDefault();
      this._toolbar.clearSearch();
      this.search("");
      this._scrollRoot?.focus();
    }
  }

  static _injectSelectionStyle() {
    const id = "pdf-viewer-selection-style";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent =
      ".textLayer :is(span,br)::selection{background:Highlight;}";
    document.head.appendChild(style);
  }
}
