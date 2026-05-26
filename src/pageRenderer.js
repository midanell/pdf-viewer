import { TextLayer, AnnotationLayer, setLayerDimensions } from "pdfjs-dist";

export class PageRenderer {
  constructor(page, options = {}) {
    this.page = page;
    this.pageNumber = page.pageNumber;
    this.nativeWidth = page.getViewport({ scale: 1 }).width;
    this.wrapper = document.createElement("div");
    this.wrapper.dataset.pageNumber = String(this.pageNumber);
    this.wrapper.style.position = "relative";
    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.wrapper.appendChild(this.canvas);
    this._task = null;
    this._currentScale = null;
    this._intendedScale = null;
    this.textLayerEnabled = options.textLayer ?? true;
    this._textDiv = null;
    this._textLayer = null;
    this._textRendered = false;
    this.annotationLayerEnabled = options.annotationLayer ?? true;
    this.linkService = options.linkService ?? null;
    this._annotDiv = null;
    this._annotLayer = null;
    this._annotRendered = false;
  }

  get isRendered() {
    return this._currentScale !== null;
  }

  setSize({ scale }) {
    this._intendedScale = scale;
    const viewport = this.page.getViewport({ scale });
    const cssW = Math.floor(viewport.width);
    const cssH = Math.floor(viewport.height);
    this.wrapper.style.width = `${cssW}px`;
    this.wrapper.style.height = `${cssH}px`;
    this.wrapper.style.setProperty("--scale-factor", String(scale));
  }

  async render({ scale = this._intendedScale ?? 1.5 } = {}) {
    if (this._currentScale === scale && !this._task) return;
    this._intendedScale = scale;
    await this._cancelActive();

    const viewport = this.page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
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

    let annotPromise = Promise.resolve();
    if (this.annotationLayerEnabled && this.linkService) {
      const annotViewport = viewport.clone({ dontFlip: true });
      if (!this._annotRendered) {
        this._annotDiv ??= this._createAnnotDiv();
        this._annotLayer = new AnnotationLayer({
          div: this._annotDiv,
          page: this.page,
          viewport: annotViewport,
          accessibilityManager: null,
          annotationCanvasMap: null,
          annotationEditorUIManager: null,
          structTreeLayer: null,
        });
        annotPromise = this.page.getAnnotations().then((annotations) =>
          this._annotLayer
            .render({
              viewport: annotViewport,
              div: this._annotDiv,
              annotations,
              page: this.page,
              linkService: this.linkService,
              renderForms: true,
            })
            .then(() => {
              this._annotRendered = true;
            })
        );
      } else {
        this._annotLayer.update({ viewport: annotViewport });
      }
    }

    try {
      await Promise.all([this._task.promise, textPromise, annotPromise]);
      this._currentScale = scale;
      this.page.cleanup();
    } finally {
      this._task = null;
    }
  }

  async cancel() {
    await this._cancelActive();
  }

  discard() {
    this._cancelActive().catch(() => {});
    this.canvas.width = 0;
    this.canvas.height = 0;
    if (this._textDiv) this._textDiv.replaceChildren();
    if (this._annotDiv) this._annotDiv.replaceChildren();
    this._textLayer = null;
    this._annotLayer = null;
    this._textRendered = false;
    this._annotRendered = false;
    this._currentScale = null;
    if (this._intendedScale != null) {
      this.setSize({ scale: this._intendedScale });
    }
  }

  _createTextDiv() {
    const div = document.createElement("div");
    div.className = "textLayer";
    this.wrapper.appendChild(div);
    return div;
  }

  _createAnnotDiv() {
    const div = document.createElement("div");
    div.className = "annotationLayer";
    this.wrapper.appendChild(div);
    return div;
  }

  async _cancelActive() {
    if (this._textLayer && !this._textRendered) {
      this._textLayer.cancel();
      this._textLayer = null;
      if (this._textDiv) this._textDiv.replaceChildren();
    }
    if (this._annotLayer && !this._annotRendered) {
      this._annotLayer = null;
      if (this._annotDiv) this._annotDiv.replaceChildren();
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
