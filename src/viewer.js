import "./worker.js";
import * as pdfjsLib from "pdfjs-dist";
import { PageRenderer } from "./pageRenderer.js";
import { createLinkService } from "./linkService.js";
import { PdfToolbar } from "./toolbar.js";

const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 4.0];

export class PdfViewer {
  constructor(host, options = {}) {
    this.host = host;
    this._zoomMode = options.sizing ?? "fit-width"; // "fit-width" | "explicit"
    this._explicitScale = options.scale ?? 1.5;
    this._zoomControls = options.zoomControls ?? true;
    this.pdf = null;
    this.renderers = [];
    this._rendererByWrapper = new Map();
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
    this._onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const now = Date.now();
      if (now - this._lastWheelZoom < 100) return;
      this._lastWheelZoom = now;
      if (e.deltaY < 0) this.zoomIn();
      else if (e.deltaY > 0) this.zoomOut();
    };
  }

  async load(url, options = {}) {
    const loadingTask = pdfjsLib.getDocument(url);
    if (options.onProgress) loadingTask.onProgress = options.onProgress;
    this.pdf = await loadingTask.promise;
    this.linkService = createLinkService(this.pdf, {
      onNavigate: (n) => this.goToPage(n),
    });

    const pages = await Promise.all(
      Array.from({ length: this.pdf.numPages }, (_, i) => this.pdf.getPage(i + 1))
    );
    this.renderers = pages.map(
      (page) => new PageRenderer(page, { linkService: this.linkService })
    );
    this._rendererByWrapper = new Map(this.renderers.map((pr) => [pr.wrapper, pr]));

    this._scrollRoot = this._findScrollContainer(this.host);

    const width = this._measureContentWidth();
    this._lastWidth = width;

    for (const pr of this.renderers) {
      pr.setSize({ scale: this._scaleFor(pr) });
      pr.wrapper.style.marginLeft = "auto";
      pr.wrapper.style.marginRight = "auto";
      this.host.appendChild(pr.wrapper);
    }

    if (this._zoomControls) {
      this._toolbar = new PdfToolbar(this.host, {
        pageCount: this.pdf.numPages,
        currentPage: this._currentPage,
        scale: this._effectiveScale(),
        onPrev: () => this.goToPage(this._currentPage - 1),
        onNext: () => this.goToPage(this._currentPage + 1),
        onGoToPage: (n) => this.goToPage(n),
        onZoomIn: () => this.zoomIn(),
        onZoomOut: () => this.zoomOut(),
        onFitWidth: () => this.setZoom("fit-width"),
      });
    }

    await this.renderers[0].render();
    this._toolbar?.updateZoom(this._effectiveScale());

    this._setupLazyObserver();
    this._setupDiscardObserver();
    this._setupPageObserver();
    this._toolbar?.updateNav(this._currentPage, this.pdf.numPages);
    this._observe();

    (this._scrollRoot ?? window).addEventListener("wheel", this._onWheel, {
      passive: false,
    });
  }

  async destroy() {
    (this._scrollRoot ?? window).removeEventListener("wheel", this._onWheel);
    this._observer?.disconnect();
    this._lazyObserver?.disconnect();
    this._discardObserver?.disconnect();
    this._pageObserver?.disconnect();
    clearTimeout(this._resizeTimer);
    clearTimeout(this._scrollingToTimer);

    this._toolbar?.destroy();
    this._toolbar = null;

    await Promise.all(this.renderers.map((pr) => pr.cancel().catch(() => {})));
    for (const pr of this.renderers) pr.wrapper.remove();
    this.renderers = [];
    this._rendererByWrapper.clear();

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

  goToPage(n) {
    const total = this.pdf?.numPages ?? 1;
    n = Math.max(1, Math.min(total, Math.floor(n)));
    const pr = this.renderers[n - 1];
    if (!pr) return;
    this._scrollingTo = true;
    clearTimeout(this._scrollingToTimer);
    this._scrollingToTimer = setTimeout(() => {
      this._scrollingTo = false;
    }, 600);
    this._currentPage = n;
    this._toolbar?.updateNav(this._currentPage, this.pdf?.numPages ?? 0);
    pr.wrapper.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  getCurrentPage() {
    return this._currentPage;
  }

  getPageCount() {
    return this.pdf?.numPages ?? 0;
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
    await Promise.all(
      this.renderers.map((pr) => {
        const scale = this._scaleFor(pr);
        pr.setSize({ scale });
        if (pr.isRendered) {
          return pr.render({ scale }).catch((e) => {
            if (e?.name !== "RenderingCancelledException") console.error(e);
          });
        }
        return Promise.resolve();
      })
    );
  }

  _measureContentWidth() {
    const cs = getComputedStyle(this.host);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    return this.host.clientWidth - padL - padR;
  }

  _fitScaleFor(renderer, width) {
    return Math.max(width / renderer.nativeWidth, 0.1);
  }

  _setupPageObserver() {
    this._pageRatios = new Map();
    this._pageObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pr = this._rendererByWrapper.get(entry.target);
          if (pr) this._pageRatios.set(pr.pageNumber, entry.intersectionRatio);
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
          this._toolbar?.updateNav(this._currentPage, this.pdf?.numPages ?? 0);
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
          pr?.render().catch((e) => {
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

  _findScrollContainer(el) {
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      const oy = getComputedStyle(cur).overflowY;
      if (oy === "auto" || oy === "scroll" || oy === "overlay") return cur;
      cur = cur.parentElement;
    }
    return null;
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
    this._observer.observe(this.host);
  }
}
