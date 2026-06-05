import { PDF_ASSET_URLS } from "./worker.js";
import * as pdfjsLib from "pdfjs-dist";
import { PageRenderer } from "./pageRenderer.js";
import { createLinkService } from "./linkService.js";
import { PdfToolbar } from "./toolbar.js";
import { PdfSearch } from "./search.js";
import { PdfThumbnails } from "./thumbnails.js";
import { PdfLoading } from "./loading.js";

const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 4.0];

export class PdfViewer {
  constructor(host, options = {}) {
    this.host = host;
    this._defaultZoomMode = options.sizing ?? "fit-width";
    this._defaultScale = options.scale ?? 1.5;
    this._zoomMode = this._defaultZoomMode; // "fit-width" | "explicit"
    this._explicitScale = this._defaultScale;
    this._rotation = 0;
    this._zoomControls = options.zoomControls ?? true;
    this._useCustomProgress = options.useCustomProgress ?? false;
    this._pageOrder = options.pageOrder ?? [];
    this._hideUnordered = options.hideUnorderedPages ?? false;
    this._customAnnotations = options.customAnnotations ?? [];
    this._pageMargin = options.margin ?? "12px";
    this.pdf = null;
    this.renderers = [];
    this._rendererByWrapper = new Map();
    this._slotByRenderer = new Map();
    this._observer = null;
    this._lazyObserver = null;
    this._discardObserver = null;
    this._resizeTimer = null;
    this._lastWidth = 0;
    this._scrollRoot = null;
    this._toolbar = null;
    this._lastWheelZoom = 0;
    this._currentPage = 1;
    this._pageRatios = new Map();
    this._pageObserver = null;
    this._scrollingTo = false;
    this._scrollingToTimer = null;
    this._search = null;
    this._thumbnails = null;
    this._thumbnailsActive = false;
    this._contentRow = null;
    this._pagesCol = null;
    this._scrollWrapper = null;
    this._bodyRow = null;
    this._loading = null;
    this._onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const now = Date.now();
      if (now - this._lastWheelZoom < 100) return;
      this._lastWheelZoom = now;
      if (e.deltaY < 0) this.zoomIn();
      else if (e.deltaY > 0) this.zoomOut();
    };
    this._onKeyDown = (e) => {
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
    };
  }

  async load(url, options = {}) {
    if (!this._useCustomProgress) {
      this.host.style.position ||= "relative";
      this._loading = new PdfLoading(this.host);
    }
    try {
      return await this._loadInternal(url, options);
    } finally {
      this._loading?.destroy();
      this._loading = null;
    }
  }

  async _loadInternal(url, options = {}) {
    if (this.pdf) await this._unload();
    this._rotation = 0;
    this._zoomMode = this._defaultZoomMode;
    this._explicitScale = this._defaultScale;
    const src =
      typeof url === "string" || url instanceof URL
        ? { url, ...PDF_ASSET_URLS }
        : url instanceof Uint8Array
          ? { data: url, ...PDF_ASSET_URLS }
          : { ...url, ...PDF_ASSET_URLS };
    const loadingTask = pdfjsLib.getDocument(src);
    loadingTask.onProgress = ({ loaded, total }) => {
      this._loading?.update({ loaded, total });
      options.onProgress?.({ loaded, total });
    };
    this.pdf = await loadingTask.promise;
    this.linkService = createLinkService(this.pdf, {
      onNavigate: (pdfPageNum) => this._goToPdfPage(pdfPageNum),
    });

    Object.assign(this.host.style, {
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    });

    if (this._zoomControls) {
      this._toolbar = new PdfToolbar(this.host, {
        pageCount: this.pdf.numPages,
        currentPage: this._currentPage,
        scale: this._effectiveScale(),
        fitWidthActive: this._zoomMode === "fit-width",
        thumbnailsActive: false,
        onPrev: () => this.goToPage(this._currentPage - 1),
        onNext: () => this.goToPage(this._currentPage + 1),
        onGoToPage: (n) => this.goToPage(n),
        onZoomIn: () => this.zoomIn(),
        onZoomOut: () => this.zoomOut(),
        onFitWidth: () => this.setZoom("fit-width"),
        onRotateCW: () => this.rotateClockwise(),
        onRotateCCW: () => this.rotateCounterclockwise(),
        onThumbnails: () => this.toggleThumbnails(),
        onSearch: ({ query, matchCase, wholeWord }) =>
          this.search(query, { matchCase, wholeWord }),
        onPrevMatch: () => this.prevMatch(),
        onNextMatch: () => this.nextMatch(),
      });
    }

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
    Object.assign(this._contentRow.style, { display: "flex", alignItems: "flex-start" });

    this._pagesCol = document.createElement("div");
    Object.assign(this._pagesCol.style, { flex: "1", minWidth: "0" });

    this._contentRow.appendChild(this._pagesCol);
    this._scrollWrapper.appendChild(this._contentRow);

    this._lastWidth = this._measureContentWidth();

    await this._buildVisiblePages();
    this._observe();

    (this._scrollRoot ?? window).addEventListener("wheel", this._onWheel, {
      passive: false,
    });
    window.addEventListener("keydown", this._onKeyDown);
  }

  async _buildVisiblePages() {
    await this._teardownPages();

    const slots = this._computeSlots();
    const pages = await Promise.all(slots.map((n) => this.pdf.getPage(n)));
    this.renderers = pages.map(
      (page) => new PageRenderer(page, { linkService: this.linkService }),
    );
    this._rendererByWrapper = new Map(this.renderers.map((pr) => [pr.wrapper, pr]));
    this._slotByRenderer = new Map(this.renderers.map((pr, i) => [pr, i + 1]));

    this.renderers.forEach((pr, i, array) => {
      pr.setSize({ scale: this._scaleFor(pr), rotation: this._rotation });
      pr.wrapper.style.marginLeft = "auto";
      pr.wrapper.style.marginRight = "auto";
      pr.wrapper.style.marginBottom = i === array.length - 1 ? "0" : this._pageMargin;
      this._pagesCol.appendChild(pr.wrapper);
    });

    this._distributeCustomAnnotations();

    this._search = new PdfSearch(this.renderers, {
      onUpdate: (cur, tot) => this._toolbar?.updateSearch(cur, tot),
    });

    this._thumbnails = new PdfThumbnails(this.renderers, {
      onNavigate: (n) => this.goToPage(n),
    });
    this._bodyRow.prepend(this._thumbnails.panel);
    if (this._thumbnailsActive) this._thumbnails.show();
    if (this._rotation !== 0) this._thumbnails.setRotation(this._rotation);

    if (this.renderers[0]) {
      await this.renderers[0].render();
    }
    this._toolbar?.updateZoom(this._effectiveScale());

    this._setupLazyObserver();
    this._setupDiscardObserver();
    this._setupPageObserver();
    this._currentPage = 1;
    this._toolbar?.updateNav(this._currentPage, this.renderers.length);
    this._thumbnails?.updateCurrentPage(this._currentPage);
  }

  async _teardownPages() {
    if (!this.renderers.length) return;
    this._lazyObserver?.disconnect();
    this._discardObserver?.disconnect();
    this._pageObserver?.disconnect();
    this._lazyObserver = null;
    this._discardObserver = null;
    this._pageObserver = null;

    this._search?.destroy();
    this._search = null;
    this._thumbnails?.destroy();
    this._thumbnails = null;

    await Promise.all(this.renderers.map((pr) => pr.cancel().catch(() => {})));
    for (const pr of this.renderers) pr.wrapper.remove();
    this.renderers = [];
    this._rendererByWrapper.clear();
    this._slotByRenderer.clear();
    this._pageRatios.clear();
  }

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

  setPageOrder(order, opts = {}) {
    this._pageOrder = order ?? [];
    this._hideUnordered = !!opts.hideUnordered;
    if (!this.pdf) return Promise.resolve();
    return this._buildVisiblePages();
  }

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
        (a) => a && (Math.floor(Number(a.page)) || 1) === pr.pageNumber,
      );
      pr.setCustomAnnotations(subset);
    }
  }

  _goToPdfPage(pdfPageNum) {
    const idx = this.renderers.findIndex((r) => r.pageNumber === pdfPageNum);
    if (idx >= 0) this.goToPage(idx + 1);
  }

  async destroy() {
    this._loading?.destroy();
    this._loading = null;
    await this._unload();
  }

  async _unload() {
    (this._scrollRoot ?? window).removeEventListener("wheel", this._onWheel);
    window.removeEventListener("keydown", this._onKeyDown);
    this._observer?.disconnect();
    this._observer = null;
    this._lazyObserver?.disconnect();
    this._lazyObserver = null;
    this._discardObserver?.disconnect();
    this._discardObserver = null;
    this._pageObserver?.disconnect();
    this._pageObserver = null;
    clearTimeout(this._resizeTimer);
    clearTimeout(this._scrollingToTimer);

    this._toolbar?.destroy();
    this._toolbar = null;
    this._search?.destroy();
    this._search = null;
    this._thumbnails?.destroy();
    this._thumbnails = null;

    await Promise.all(this.renderers.map((pr) => pr.cancel().catch(() => {})));
    for (const pr of this.renderers) pr.wrapper.remove();
    this.renderers = [];
    this._rendererByWrapper.clear();
    this._slotByRenderer.clear();
    this._pageRatios.clear();

    this._contentRow?.remove();
    this._contentRow = null;
    this._pagesCol = null;
    this._scrollWrapper?.remove();
    this._scrollWrapper = null;
    this._bodyRow?.remove();
    this._bodyRow = null;
    this._scrollRoot = null;

    await this.pdf?.destroy();
    this.pdf = null;
  }

  setZoom(value) {
    if (value === "fit-width") {
      this._zoomMode = "fit-width";
    } else {
      this._zoomMode = "explicit";
      this._explicitScale = value;
    }
    const anchor = this._captureScrollAnchor();
    return this._applyScale().then(() => {
      this._restoreScrollAnchor(anchor);
      this._toolbar?.updateZoom(this._effectiveScale());
      this._toolbar?.updateFitWidth(this._zoomMode === "fit-width");
    });
  }

  zoomIn() {
    const current = this._effectiveScale();
    const next = ZOOM_STEPS.find((s) => s > current + 0.01);
    if (next !== undefined) return this.setZoom(next);
  }

  zoomOut() {
    const current = this._effectiveScale();
    const prev = [...ZOOM_STEPS].reverse().find((s) => s < current - 0.01);
    if (prev !== undefined) return this.setZoom(prev);
  }

  getZoom() {
    return { mode: this._zoomMode, scale: this._effectiveScale() };
  }

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
    const anchor = this._captureScrollAnchor();
    return this._applyScale().then(() => {
      this._thumbnails?.setRotation(this._rotation);
      this._restoreScrollAnchor(anchor);
      this._toolbar?.updateZoom(this._effectiveScale());
    });
  }

  goToPage(n) {
    const total = this.renderers.length;
    if (total === 0) return;
    n = Math.max(1, Math.min(total, Math.floor(n)));
    const pr = this.renderers[n - 1];
    if (!pr) return;
    this._scrollingTo = true;
    clearTimeout(this._scrollingToTimer);
    this._scrollingToTimer = setTimeout(() => {
      this._scrollingTo = false;
    }, 600);
    this._currentPage = n;
    this._toolbar?.updateNav(this._currentPage, total);
    this._thumbnails?.updateCurrentPage(n);
    pr.wrapper.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  getCurrentPage() {
    return this._currentPage;
  }

  getPageCount() {
    return this.renderers.length;
  }

  search(query, opts) {
    return this._search?.search(query, opts);
  }

  nextMatch() {
    return this._search?.nextMatch();
  }

  prevMatch() {
    return this._search?.prevMatch();
  }

  toggleThumbnails() {
    this._thumbnailsActive = !this._thumbnailsActive;
    if (this._thumbnailsActive) this._thumbnails?.show();
    else this._thumbnails?.hide();
    this._toolbar?.updateThumbnails(this._thumbnailsActive);
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
    return this._zoomMode === "fit-width"
      ? this._fitScaleFor(renderer, this._lastWidth)
      : this._explicitScale;
  }

  async _applyScale() {
    const rotation = this._rotation;
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
  }

  _measureContentWidth() {
    const target = this._pagesCol ?? this.host;
    const cs = getComputedStyle(target);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    return target.clientWidth - padL - padR;
  }

  _fitScaleFor(renderer, width) {
    return Math.max(width / renderer.nativeWidthFor(this._rotation), 0.1);
  }

  _setupPageObserver() {
    this._pageRatios = new Map();
    this._pageObserver = new IntersectionObserver(
      (entries) => {
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
      },
      { root: this._scrollRoot, threshold: [0, 0.25, 0.5, 0.75, 1] }
    );
    for (const pr of this.renderers) this._pageObserver.observe(pr.wrapper);
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

  _setupLazyObserver() {
    this._lazyObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const pr = this._rendererByWrapper.get(entry.target);
          pr?.render()
            .then(() => this._search?.applyToPage(pr))
            .catch((e) => {
              if (e?.name !== "RenderingCancelledException") console.error(e);
            });
        }
      },
      { root: this._scrollRoot, rootMargin: "200px" }
    );
    for (const pr of this.renderers) this._lazyObserver.observe(pr.wrapper);
  }

  _setupDiscardObserver() {
    this._discardObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) continue;
          const pr = this._rendererByWrapper.get(entry.target);
          if (pr?.isRendered) pr.discard();
        }
      },
      { root: this._scrollRoot, rootMargin: "1500px" }
    );
    for (const pr of this.renderers) this._discardObserver.observe(pr.wrapper);
  }

  _observe() {
    this._observer = new ResizeObserver((entries) => {
      const w =
        entries[0].contentBoxSize?.[0]?.inlineSize ??
        entries[0].contentRect.width;
      if (Math.abs(w - this._lastWidth) < 1) return;
      this._lastWidth = w;
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        if (this._zoomMode === "fit-width") {
          this._applyScale().then(() =>
            this._toolbar?.updateZoom(this._effectiveScale())
          );
        }
      }, 150);
    });
    this._observer.observe(this._pagesCol ?? this.host);
  }

}
