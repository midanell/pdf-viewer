import "./worker.js";
import * as pdfjsLib from "pdfjs-dist";
import { PageRenderer } from "./pageRenderer.js";
import { createLinkService } from "./linkService.js";

export class PdfViewer {
  constructor(host, options = {}) {
    this.host = host;
    this.sizing = options.sizing ?? "fit-width";
    this.scale = options.scale ?? 1.5;
    this.pdf = null;
    this.renderers = [];
    this._rendererByWrapper = new Map();
    this._observer = null;
    this._lazyObserver = null;
    this._discardObserver = null;
    this._resizeTimer = null;
    this._lastWidth = 0;
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

    const width = this._measureContentWidth();
    this._lastWidth = width;

    for (const pr of this.renderers) {
      if (this.sizing === "fit-width") {
        pr.setSize({ scale: this._fitScaleFor(pr, width) });
      } else {
        pr.setSize({ scale: this.scale });
      }
      this.host.appendChild(pr.wrapper);
    }

    await this.renderers[0].render();

    this._setupLazyObserver();
    this._setupDiscardObserver();
    if (this.sizing === "fit-width") this._observe();
  }

  async destroy() {
    this._observer?.disconnect();
    this._lazyObserver?.disconnect();
    this._discardObserver?.disconnect();
    clearTimeout(this._resizeTimer);

    await Promise.all(
      this.renderers.map((pr) => pr.cancel().catch(() => {}))
    );
    for (const pr of this.renderers) pr.wrapper.remove();
    this.renderers = [];
    this._rendererByWrapper.clear();

    await this.pdf?.destroy();
    this.pdf = null;
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

  _setupLazyObserver() {
    const root = this._findScrollContainer(this.host);
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
      { root, rootMargin: "200px" }
    );
    for (const pr of this.renderers) this._lazyObserver.observe(pr.wrapper);
  }

  _setupDiscardObserver() {
    const root = this._findScrollContainer(this.host);
    this._discardObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) continue;
          const pr = this._rendererByWrapper.get(entry.target);
          if (pr?.isRendered) pr.discard();
        }
      },
      { root, rootMargin: "1500px" }
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
      this._resizeTimer = setTimeout(() => this._refit(w), 150);
    });
    this._observer.observe(this.host);
  }

  async _refit(width) {
    await Promise.all(
      this.renderers.map((pr) => {
        const scale = this._fitScaleFor(pr, width);
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
}
