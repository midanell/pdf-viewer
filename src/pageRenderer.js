import { TextLayer, AnnotationLayer, setLayerDimensions } from "pdfjs-dist";

const DEFAULT_CUSTOM_COLOR   = "#ffd54a";
const DEFAULT_CUSTOM_OPACITY = 0.35;

export class PageRenderer {
  // ── Construction ───────────────────────────────────────────────────────────

  constructor(page, options = {}) {
    this.page       = page;
    this.pageNumber = page.pageNumber;

    const nativeViewport   = page.getViewport({ scale: 1 });
    this.nativeWidth       = nativeViewport.width;
    this.nativeHeight      = nativeViewport.height;

    this.wrapper = document.createElement("div");
    this.wrapper.dataset.pageNumber = String(this.pageNumber);
    this.wrapper.style.position        = "relative";
    this.wrapper.style.backgroundColor = "#DDD";
    this.wrapper.style.setProperty("--scale-round-x", "1px");
    this.wrapper.style.setProperty("--scale-round-y", "1px");

    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.wrapper.appendChild(this.canvas);

    this._spinner = this._createSpinner();
    this.wrapper.appendChild(this._spinner);

    // Render state
    this._task             = null;
    this._currentScale     = null;
    this._currentRotation  = null;
    this._intendedScale    = null;
    this._intendedRotation = 0;

    // Text layer
    this.textLayerEnabled = options.textLayer ?? true;
    this._textDiv         = null;
    this._textLayer       = null;
    this._textRendered    = false;

    // Annotation layer
    this.annotationLayerEnabled = options.annotationLayer ?? true;
    this.linkService            = options.linkService ?? null;
    this._annotDiv              = null;
    this._annotLayer            = null;
    this._annotRendered         = false;

    // Custom highlight annotations
    this._customAnnotations = [];
    this._customDiv         = null;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get isRendered() {
    return this._currentScale !== null;
  }

  get textDiv() {
    return this._textDiv;
  }

  // Width/height of the page at scale 1, swapped for 90° / 270° rotation.
  nativeWidthFor(rotation = 0) {
    return rotation % 180 === 0 ? this.nativeWidth : this.nativeHeight;
  }

  nativeHeightFor(rotation = 0) {
    return rotation % 180 === 0 ? this.nativeHeight : this.nativeWidth;
  }

  setSize({ scale, rotation = this._intendedRotation ?? 0 }) {
    this._intendedScale    = scale;
    this._intendedRotation = rotation;

    const viewport = this.page.getViewport({ scale, rotation });
    const cssW = Math.floor(viewport.width);
    const cssH = Math.floor(viewport.height);

    this.wrapper.style.width  = `${cssW}px`;
    this.wrapper.style.height = `${cssH}px`;
    this.canvas.style.width   = `${cssW}px`;
    this.canvas.style.height  = `${cssH}px`;
    this.wrapper.style.setProperty("--scale-factor",       String(scale));
    this.wrapper.style.setProperty("--total-scale-factor", String(scale));

    this._placeCustomAnnotations();
  }

  async render({
    scale    = this._intendedScale    ?? 1.5,
    rotation = this._intendedRotation ?? 0,
  } = {}) {
    if (
      this._currentScale    === scale &&
      this._currentRotation === rotation &&
      !this._task
    ) {
      return;
    }
    this._intendedScale    = scale;
    this._intendedRotation = rotation;
    await this._cancelActive();

    const viewport = this.page.getViewport({ scale, rotation });
    const dpr      = Math.min(window.devicePixelRatio || 1, 2);

    this._task = this._sizeCanvas(viewport, dpr);
    this.wrapper.style.setProperty("--scale-factor",       String(viewport.scale));
    this.wrapper.style.setProperty("--total-scale-factor", String(viewport.scale));

    const textPromise  = this.textLayerEnabled
      ? (this._textRendered ? this._updateTextLayer(viewport) : this._setupTextLayer(viewport))
      : Promise.resolve();

    const annotPromise = (this.annotationLayerEnabled && this.linkService)
      ? (this._annotRendered ? this._updateAnnotationLayer(viewport) : this._setupAnnotationLayer(viewport))
      : Promise.resolve();

    try {
      await Promise.all([this._task.promise, textPromise, annotPromise]);
      this._currentScale    = scale;
      this._currentRotation = rotation;
      this._setSpinnerVisible(false);
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
    this.canvas.width  = 0;
    this.canvas.height = 0;
    if (this._textDiv)  this._textDiv.replaceChildren();
    if (this._annotDiv) this._annotDiv.replaceChildren();
    this._textLayer    = null;
    this._annotLayer   = null;
    this._textRendered  = false;
    this._annotRendered = false;
    this._currentScale    = null;
    this._currentRotation = null;
    if (this._intendedScale != null) {
      this.setSize({ scale: this._intendedScale, rotation: this._intendedRotation ?? 0 });
    }
    this._setSpinnerVisible(true);
  }

  setCustomAnnotations(list) {
    this._customAnnotations = Array.isArray(list)
      ? list.filter((a) => a && typeof a === "object")
      : [];
    this._placeCustomAnnotations();
  }

  // ── Rendering helpers ──────────────────────────────────────────────────────

  // Sizes the canvas for the viewport + DPR, sizes the wrapper, and returns
  // the render task (so render() can await task.promise alongside the layers).
  _sizeCanvas(viewport, dpr) {
    const cssW = Math.floor(viewport.width);
    const cssH = Math.floor(viewport.height);

    this.canvas.width  = Math.floor(viewport.width  * dpr);
    this.canvas.height = Math.floor(viewport.height * dpr);
    this.canvas.style.width  = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.wrapper.style.width  = `${cssW}px`;
    this.wrapper.style.height = `${cssH}px`;

    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    return this.page.render({ canvasContext: ctx, viewport });
  }

  // First render: create the text layer div and stream text content into it.
  _setupTextLayer(viewport) {
    this._textDiv ??= this._createTextDiv();
    setLayerDimensions(this._textDiv, viewport);
    this._textLayer = new TextLayer({
      textContentSource: this.page.streamTextContent(),
      container: this._textDiv,
      viewport,
    });
    return this._textLayer.render().then(() => {
      this._textRendered = true;
    });
  }

  // Subsequent renders: update the existing layer to the new viewport.
  _updateTextLayer(viewport) {
    setLayerDimensions(this._textDiv, viewport);
    this._textLayer.update({ viewport });
    return Promise.resolve();
  }

  // First render: create the annotation layer div, fetch annotations, and render.
  async _setupAnnotationLayer(viewport) {
    this._annotDiv ??= this._createAnnotDiv();
    const annotViewport = viewport.clone({ dontFlip: true });
    const annotLayer = new AnnotationLayer({
      div: this._annotDiv,
      page: this.page,
      viewport: annotViewport,
      accessibilityManager:      null,
      annotationCanvasMap:       null,
      annotationEditorUIManager: null,
      structTreeLayer:           null,
    });
    this._annotLayer = annotLayer;

    const annotations = await this.page.getAnnotations();
    // Bail if _cancelActive() already replaced this layer while we were waiting.
    if (this._annotLayer !== annotLayer) return;

    await annotLayer.render({
      viewport: annotViewport,
      div:      this._annotDiv,
      annotations,
      page:        this.page,
      linkService: this.linkService,
      renderForms: true,
    });
    this._annotRendered = true;
  }

  // Subsequent renders: update the existing annotation layer to the new viewport.
  _updateAnnotationLayer(viewport) {
    this._annotLayer.update({ viewport: viewport.clone({ dontFlip: true }) });
    return Promise.resolve();
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────

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

  _createSpinner() {
    const el = document.createElement("div");
    el.className = "pdf-page-spinner";
    Object.assign(el.style, {
      position:    "absolute",
      top:         "50%",
      left:        "50%",
      width:       "32px",
      height:      "32px",
      marginTop:   "-16px",
      marginLeft:  "-16px",
      border:      "3px solid rgba(0,0,0,0.12)",
      borderTopColor: "rgba(0,0,0,0.55)",
      borderRadius: "50%",
      pointerEvents: "none",
      boxSizing:   "border-box",
    });
    el.animate(
      [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
      { duration: 800, iterations: Infinity },
    );
    return el;
  }

  _setSpinnerVisible(visible) {
    if (this._spinner) this._spinner.style.display = visible ? "block" : "none";
  }

  // ── Cancellation ───────────────────────────────────────────────────────────

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

  // ── Custom annotations ─────────────────────────────────────────────────────

  _placeCustomAnnotations() {
    if (!this._customAnnotations.length) {
      this._customDiv?.replaceChildren();
      return;
    }
    this._customDiv ??= this._createCustomDiv();

    const rotation = (((this._intendedRotation ?? 0) % 360) + 360) % 360;
    const rects = [];

    for (const a of this._customAnnotations) {
      const x = Number(a.x);
      const y = Number(a.y);
      const w = Number(a.width);
      const h = Number(a.height);
      if (![x, y, w, h].every(Number.isFinite)) continue;

      // PDF space has bottom-left origin; CSS uses top-left. Convert, then
      // rotate the two opposing corners through the unit square and take the
      // bounding box so the highlight lands correctly at any rotation.
      let left = x;
      let top  = 1 - y - h;
      const p1 = this._rotatePoint(left,     top,     rotation);
      const p2 = this._rotatePoint(left + w, top + h, rotation);
      left = Math.min(p1.u, p2.u);
      top  = Math.min(p1.v, p2.v);
      const cw = Math.abs(p2.u - p1.u);
      const ch = Math.abs(p2.v - p1.v);

      const el = document.createElement("div");
      Object.assign(el.style, {
        position:      "absolute",
        left:          `${left * 100}%`,
        top:           `${top  * 100}%`,
        width:         `${cw   * 100}%`,
        height:        `${ch   * 100}%`,
        background:    a.color   ?? DEFAULT_CUSTOM_COLOR,
        opacity:       String(a.opacity ?? DEFAULT_CUSTOM_OPACITY),
        pointerEvents: "none",
      });
      rects.push(el);
    }
    this._customDiv.replaceChildren(...rects);
  }

  _createCustomDiv() {
    const div = document.createElement("div");
    div.className = "customAnnotationLayer";
    Object.assign(div.style, {
      position:      "absolute",
      inset:         "0",
      pointerEvents: "none",
      zIndex:        "4",
    });
    this.wrapper.appendChild(div);
    return div;
  }

  _rotatePoint(u, v, rotation) {
    switch (rotation) {
      case  90: return { u: 1 - v, v: u };
      case 180: return { u: 1 - u, v: 1 - v };
      case 270: return { u: v,     v: 1 - u };
      default:  return { u, v };
    }
  }
}
