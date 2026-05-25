import "./worker.js";
import * as pdfjsLib from "pdfjs-dist";

export class PdfViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.pdf = null;
  }

  async load(url) {
    const loadingTask = pdfjsLib.getDocument(url);
    this.pdf = await loadingTask.promise;
    await this.renderPage(1);
  }

  async renderPage(pageNumber) {
    const page = await this.pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.5 });
    const ctx = this.canvas.getContext("2d");

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(viewport.width * dpr);
    this.canvas.height = Math.floor(viewport.height * dpr);
    this.canvas.style.width = `${viewport.width}px`;
    this.canvas.style.height = `${viewport.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    await page.render({ canvasContext: ctx, viewport }).promise;
  }
}
