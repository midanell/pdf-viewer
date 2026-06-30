const THUMB_SCALE     = 0.2;
const PANEL_PADDING_PX = 24;   // horizontal space around items inside the panel
const LABEL_FONT_SIZE  = "10px";
const HIGHLIGHT        = "2px solid rgba(74,158,255,0.8)";

export class PdfThumbnails {
  constructor(renderers, { onNavigate } = {}) {
    this._onNavigate = onNavigate;
    this._currentPage = 1;
    this._rotation = 0;

    this._panel = this._buildPanel(renderers);
    this._items = renderers.map((pr, i) => this._createItem(pr, i + 1));
    for (const item of this._items) this._panel.appendChild(item.wrapper);

    this._observer = new IntersectionObserver(
      (entries) => this._onIntersect(entries),
      { root: this._panel },
    );
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get panel() {
    return this._panel;
  }

  show() {
    this._panel.style.display = "block";
    // Disconnect then reconnect so the observer re-evaluates which items are now
    // actually in view after the panel became visible.
    this._observer.disconnect();
    for (const item of this._items) this._observer.observe(item.wrapper);
  }

  hide() {
    this._panel.style.display = "none";
  }

  setRotation(rotation) {
    if (rotation === this._rotation) return;
    this._rotation = rotation;
    for (const item of this._items) {
      this._resizeItem(item, rotation);
    }
    this._observer.disconnect();
    if (this._panel.style.display !== "none") {
      for (const item of this._items) this._observer.observe(item.wrapper);
    }
  }

  updateCurrentPage(n) {
    const prev = this._items[this._currentPage - 1];
    if (prev) prev.wrapper.style.outline = "";
    this._currentPage = n;
    const cur = this._items[n - 1];
    if (cur) {
      cur.wrapper.style.outline = HIGHLIGHT;
      cur.wrapper.scrollIntoView({ block: "nearest" });
    }
  }

  destroy() {
    this._observer.disconnect();
    this._observer = null;
    this._panel.remove();
    this._items = [];
  }

  // ── DOM construction ───────────────────────────────────────────────────────

  _buildPanel(renderers) {
    const panelWidth = this._panelWidthFor(renderers[0]);
    const panel = document.createElement("div");
    panel.className = "pdf-thumbnails-panel";
    Object.assign(panel.style, {
      width: `${panelWidth}px`,
      flexShrink: "0",
      height: "100%",
      overflowY: "auto",
      background: "rgba(0,0,0,0.07)",
      display: "none",
    });
    return panel;
  }

  // The panel width is driven by the largest thumbnail dimension so both
  // portrait and landscape pages fit without horizontal scrolling.
  _panelWidthFor(firstRenderer) {
    if (!firstRenderer) return 100 + PANEL_PADDING_PX;
    const vp = firstRenderer.page.getViewport({ scale: THUMB_SCALE });
    return Math.floor(Math.max(vp.width, vp.height)) + PANEL_PADDING_PX;
  }

  _createItem(pr, slotIndex) {
    const viewport = pr.page.getViewport({ scale: THUMB_SCALE, rotation: this._rotation });
    const w = Math.floor(viewport.width);
    const h = Math.floor(viewport.height);

    const wrapper = this._createItemWrapper(w, h, slotIndex, pr.pageNumber);
    const canvas  = this._createThumbCanvas();
    const spinner = this._createSpinner();
    const label   = this._createThumbLabel(pr.pageNumber);

    wrapper.append(canvas, spinner, label);
    wrapper.onclick = () => this._onNavigate?.(slotIndex);
    return { wrapper, canvas, spinner, pr, rendered: false };
  }

  _createItemWrapper(w, h, slotIndex, pageNumber) {
    const wrapper = document.createElement("div");
    wrapper.dataset.pageNumber = String(pageNumber);
    wrapper.dataset.slotIndex  = String(slotIndex);
    Object.assign(wrapper.style, {
      width:      `${w}px`,
      height:     `${h}px`,
      margin:     "8px auto",
      cursor:     "pointer",
      position:   "relative",
      background: "#ccc",
      flexShrink: "0",
    });
    return wrapper;
  }

  _createThumbCanvas() {
    const canvas = document.createElement("canvas");
    canvas.style.display = "none";
    return canvas;
  }

  _createThumbLabel(pageNumber) {
    const label = document.createElement("span");
    label.textContent = String(pageNumber);
    Object.assign(label.style, {
      position:      "absolute",
      bottom:        "2px",
      right:         "4px",
      fontSize:      LABEL_FONT_SIZE,
      color:         "rgba(0,0,0,0.6)",
      pointerEvents: "none",
    });
    return label;
  }

  _createSpinner() {
    const el = document.createElement("div");
    Object.assign(el.style, {
      position:    "absolute",
      top:         "50%",
      left:        "50%",
      width:       "16px",
      height:      "16px",
      marginTop:   "-8px",
      marginLeft:  "-8px",
      border:      "2px solid rgba(0,0,0,0.12)",
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

  // ── Rendering ──────────────────────────────────────────────────────────────

  async _renderItem(item) {
    if (item.rendered) return;
    item.rendered = true;

    const { pr, canvas, spinner } = item;
    const viewport = pr.page.getViewport({ scale: THUMB_SCALE, rotation: this._rotation });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width  = Math.floor(viewport.width  * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width  = Math.floor(viewport.width)  + "px";
    canvas.style.height = Math.floor(viewport.height) + "px";

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    try {
      await pr.page.render({ canvasContext: ctx, viewport }).promise;
    } catch (e) {
      // Allow a later intersection to retry (e.g. the shared page was cleaned
      // up mid-render by the main PageRenderer).
      item.rendered = false;
      throw e;
    }

    canvas.style.display  = "block";
    spinner.style.display = "none";
  }

  // Zeros the canvas and shows the spinner so the item re-renders on its next
  // intersection (called when rotation changes).
  _resizeItem(item, rotation) {
    const viewport = item.pr.page.getViewport({ scale: THUMB_SCALE, rotation });
    item.wrapper.style.width  = `${Math.floor(viewport.width)}px`;
    item.wrapper.style.height = `${Math.floor(viewport.height)}px`;
    item.canvas.width         = 0;
    item.canvas.height        = 0;
    item.canvas.style.display  = "none";
    item.spinner.style.display = "block";
    item.rendered = false;
  }

  _onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const slotIndex = parseInt(entry.target.dataset.slotIndex, 10);
      const item = this._items[slotIndex - 1];
      if (item) this._renderItem(item).catch(() => {});
    }
  }
}
