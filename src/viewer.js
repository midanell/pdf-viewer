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
    this._observer = null;
    this._resizeTimer = null;
    this._lastWidth = 0;
  }

  async load(url) {
    this.pdf = await pdfjsLib.getDocument(url).promise;
    this.linkService = createLinkService(this.pdf);
    const pr = new PageRenderer(this.pdf, 1, { linkService: this.linkService });
    this.host.appendChild(pr.wrapper);
    this.renderers.push(pr);

    if (this.sizing === "fit-width") {
      this._lastWidth = this._measureContentWidth();
      const scale = await this._computeFitScale(this._lastWidth);
      await pr.render({ scale });
      this._observe();
    } else {
      await pr.render({ scale: this.scale });
    }
  }

  destroy() {
    this._observer?.disconnect();
    clearTimeout(this._resizeTimer);
  }

  _measureContentWidth() {
    const cs = getComputedStyle(this.host);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    return this.host.clientWidth - padL - padR;
  }

  async _computeFitScale(width) {
    const page = await this.pdf.getPage(1);
    const base = page.getViewport({ scale: 1 }).width;
    return Math.max(width / base, 0.1);
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
    const scale = await this._computeFitScale(width);
    await Promise.all(this.renderers.map((r) => r.render({ scale })));
  }
}
