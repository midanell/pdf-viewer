import "./worker.js";
import * as pdfjsLib from "pdfjs-dist";
import { PageRenderer } from "./pageRenderer.js";
import { createLinkService } from "./linkService.js";

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
    this._toolbarEl = null;
    this._zoomDisplay = null;
    this._lastWheelZoom = 0;
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
    this.linkService = createLinkService(this.pdf);

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

    if (this._zoomControls) this._setupToolbar();

    await this.renderers[0].render();
    this._updateZoomDisplay();

    this._setupLazyObserver();
    this._setupDiscardObserver();
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
    clearTimeout(this._resizeTimer);

    this._toolbarEl?.remove();
    this._toolbarEl = null;
    this._zoomDisplay = null;

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
      this._updateZoomDisplay();
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

  _setupToolbar() {
    const toolbar = document.createElement("div");
    toolbar.className = "pdf-viewer-toolbar";
    Object.assign(toolbar.style, {
      position: "sticky",
      top: "0",
      zIndex: "10",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "4px",
      padding: "6px 8px",
      marginBottom: "12px",
      background: "rgba(0,0,0,0.7)",
      backdropFilter: "blur(4px)",
      color: "#fff",
      fontSize: "12px",
      userSelect: "none",
      width: "100%",
      boxSizing: "border-box",
    });

    const btnBase = {
      background: "rgba(255,255,255,0.15)",
      border: "none",
      color: "#fff",
      borderRadius: "3px",
      padding: "0 8px",
      cursor: "pointer",
      fontSize: "13px",
      height: "26px",
      boxSizing: "border-box",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    };

    const zoomOut = document.createElement("button");
    zoomOut.className = "pdf-viewer-zoom-out";
    zoomOut.title = "Zoom out";
    zoomOut.textContent = "−";
    Object.assign(zoomOut.style, btnBase);

    const display = document.createElement("span");
    display.className = "pdf-viewer-zoom-display";
    Object.assign(display.style, { minWidth: "42px", textAlign: "center" });
    this._zoomDisplay = display;

    const zoomIn = document.createElement("button");
    zoomIn.className = "pdf-viewer-zoom-in";
    zoomIn.title = "Zoom in";
    zoomIn.textContent = "+";
    Object.assign(zoomIn.style, btnBase);

    const fitWidth = document.createElement("button");
    fitWidth.className = "pdf-viewer-fit-width";
    fitWidth.title = "Fit width";
    fitWidth.textContent = "Fit width";
    Object.assign(fitWidth.style, btnBase);

    zoomOut.onclick = () => this.zoomOut();
    zoomIn.onclick = () => this.zoomIn();
    fitWidth.onclick = () => this.setZoom("fit-width");

    toolbar.append(zoomOut, display, zoomIn, fitWidth);
    this.host.prepend(toolbar);
    this._toolbarEl = toolbar;
  }

  _updateZoomDisplay() {
    if (!this._zoomDisplay) return;
    this._zoomDisplay.textContent = `${Math.round(this._effectiveScale() * 100)}%`;
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
          this._applyScale().then(() => this._updateZoomDisplay());
        }
      }, 150);
    });
    this._observer.observe(this.host);
  }
}
