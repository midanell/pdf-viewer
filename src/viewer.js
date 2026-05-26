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
    this._currentPage = 1;
    this._pageRatios = new Map();
    this._pageObserver = null;
    this._scrollingTo = false;
    this._scrollingToTimer = null;
    this._navInput = null;
    this._navTotal = null;
    this._prevBtn = null;
    this._nextBtn = null;
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

    if (this._zoomControls) this._setupToolbar();

    await this.renderers[0].render();
    this._updateZoomDisplay();

    this._setupLazyObserver();
    this._setupDiscardObserver();
    this._setupPageObserver();
    this._updateNavDisplay();
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

    this._toolbarEl?.remove();
    this._toolbarEl = null;
    this._zoomDisplay = null;
    this._navInput = null;
    this._navTotal = null;
    this._prevBtn = null;
    this._nextBtn = null;

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
    this._updateNavDisplay();
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

  _setupToolbar() {
    const toolbar = document.createElement("div");
    toolbar.className = "pdf-viewer-toolbar";
    Object.assign(toolbar.style, {
      position: "sticky",
      top: "0",
      zIndex: "10",
      display: "grid",
      gridTemplateColumns: "1fr auto 1fr",
      alignItems: "center",
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

    const groupStyle = {
      display: "flex",
      alignItems: "center",
      gap: "4px",
    };

    // --- Nav group (left cell) ---
    const navGroup = document.createElement("div");
    navGroup.className = "pdf-viewer-nav-group";
    Object.assign(navGroup.style, groupStyle, { justifySelf: "start" });

    const prev = document.createElement("button");
    prev.className = "pdf-viewer-prev";
    prev.title = "Previous page";
    prev.textContent = "↑";
    Object.assign(prev.style, btnBase);

    const navInput = document.createElement("input");
    navInput.className = "pdf-viewer-page-input";
    navInput.type = "number";
    navInput.min = "1";
    navInput.max = String(this.pdf?.numPages ?? 1);
    navInput.value = String(this._currentPage);
    Object.assign(navInput.style, {
      width: "44px",
      height: "26px",
      padding: "0 6px",
      background: "rgba(0,0,0,0.4)",
      color: "#fff",
      border: "1px solid rgba(255,255,255,0.15)",
      borderRadius: "3px",
      fontSize: "13px",
      textAlign: "center",
      boxSizing: "border-box",
      appearance: "textfield",
      MozAppearance: "textfield",
    });

    const navTotal = document.createElement("span");
    navTotal.className = "pdf-viewer-page-total";
    navTotal.textContent = `/ ${this.pdf?.numPages ?? 0}`;
    Object.assign(navTotal.style, { padding: "0 2px" });

    const next = document.createElement("button");
    next.className = "pdf-viewer-next";
    next.title = "Next page";
    next.textContent = "↓";
    Object.assign(next.style, btnBase);

    prev.onclick = () => this.goToPage(this._currentPage - 1);
    next.onclick = () => this.goToPage(this._currentPage + 1);
    navInput.onchange = () => {
      const v = parseInt(navInput.value, 10);
      if (Number.isFinite(v)) this.goToPage(v);
      else navInput.value = String(this._currentPage);
    };

    navGroup.append(prev, navInput, navTotal, next);

    // --- Zoom group (center cell) ---
    const zoomGroup = document.createElement("div");
    zoomGroup.className = "pdf-viewer-zoom-group";
    Object.assign(zoomGroup.style, groupStyle);

    const zoomOut = document.createElement("button");
    zoomOut.className = "pdf-viewer-zoom-out";
    zoomOut.title = "Zoom out";
    zoomOut.textContent = "−";
    Object.assign(zoomOut.style, btnBase);

    const display = document.createElement("span");
    display.className = "pdf-viewer-zoom-display";
    Object.assign(display.style, { minWidth: "42px", textAlign: "center" });

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

    zoomGroup.append(zoomOut, display, zoomIn, fitWidth);

    // --- Right placeholder (keeps the center cell centered) ---
    const rightSlot = document.createElement("div");

    toolbar.append(navGroup, zoomGroup, rightSlot);
    this.host.prepend(toolbar);

    this._toolbarEl = toolbar;
    this._zoomDisplay = display;
    this._navInput = navInput;
    this._navTotal = navTotal;
    this._prevBtn = prev;
    this._nextBtn = next;
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
          this._updateNavDisplay();
        }
      },
      { root: this._scrollRoot, threshold: [0, 0.25, 0.5, 0.75, 1] }
    );
    for (const pr of this.renderers) this._pageObserver.observe(pr.wrapper);
  }

  _updateNavDisplay() {
    if (!this._navInput) return;
    const total = this.pdf?.numPages ?? 0;
    this._navInput.value = String(this._currentPage);
    this._navInput.max = String(total);
    this._navTotal.textContent = `/ ${total}`;
    const atFirst = this._currentPage <= 1;
    const atLast = this._currentPage >= total;
    this._prevBtn.style.opacity = atFirst ? "0.4" : "1";
    this._prevBtn.style.pointerEvents = atFirst ? "none" : "auto";
    this._nextBtn.style.opacity = atLast ? "0.4" : "1";
    this._nextBtn.style.pointerEvents = atLast ? "none" : "auto";
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
