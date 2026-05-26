import { TextLayer, setLayerDimensions } from "pdfjs-dist";

export class PageRenderer {
  constructor(pdf, pageNumber, options = {}) {
    this.pdf = pdf;
    this.pageNumber = pageNumber;
    this.page = null;
    this.wrapper = document.createElement("div");
    this.wrapper.dataset.pageNumber = String(pageNumber);
    this.wrapper.style.position = "relative";
    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.wrapper.appendChild(this.canvas);
    this._task = null;
    this.textLayerEnabled = options.textLayer ?? true;
    this._textDiv = null;
    this._textLayer = null;
    this._textRendered = false;
  }

  async render({ scale = 1.5 } = {}) {
    if (!this.page) this.page = await this.pdf.getPage(this.pageNumber);
    await this._cancelActive();

    const viewport = this.page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.floor(viewport.width);
    const cssH = Math.floor(viewport.height);

    this.canvas.width = Math.floor(viewport.width * dpr);
    this.canvas.height = Math.floor(viewport.height * dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.wrapper.style.width = `${cssW}px`;
    this.wrapper.style.height = `${cssH}px`;

    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this._task = this.page.render({ canvasContext: ctx, viewport });

    this.wrapper.style.setProperty("--scale-factor", String(viewport.scale));

    let textPromise = Promise.resolve();
    if (this.textLayerEnabled) {
      if (!this._textRendered) {
        this._textDiv ??= this._createTextDiv();
        setLayerDimensions(this._textDiv, viewport);
        this._textLayer = new TextLayer({
          textContentSource: this.page.streamTextContent(),
          container: this._textDiv,
          viewport,
        });
        textPromise = this._textLayer.render().then(() => {
          this._textRendered = true;
        });
      } else {
        setLayerDimensions(this._textDiv, viewport);
        this._textLayer.update({ viewport });
      }
    }

    try {
      await Promise.all([this._task.promise, textPromise]);
    } finally {
      this._task = null;
    }
  }

  async cancel() {
    await this._cancelActive();
  }

  _createTextDiv() {
    const div = document.createElement("div");
    div.className = "textLayer";
    this.wrapper.appendChild(div);
    return div;
  }

  async _cancelActive() {
    if (this._textLayer && !this._textRendered) {
      this._textLayer.cancel();
      this._textLayer = null;
      if (this._textDiv) this._textDiv.replaceChildren();
    }
    if (!this._task) return;
    const task = this._task;
    task.cancel();
    try {
      await task.promise;
    } catch (e) {
      if (e?.name !== "RenderingCancelledException") throw e;
    }
  }
}
