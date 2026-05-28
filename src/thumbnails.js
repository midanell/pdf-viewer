const THUMB_SCALE = 0.2;
const HIGHLIGHT = "2px solid rgba(74,158,255,0.8)";

export class PdfThumbnails {
  constructor(renderers, { onNavigate, topOffset = 0 } = {}) {
    this._onNavigate = onNavigate;
    this._currentPage = 1;
    this._rotation = 0;

    const firstViewport = renderers[0]?.page.getViewport({ scale: THUMB_SCALE });
    const thumbW = firstViewport
      ? Math.floor(Math.max(firstViewport.width, firstViewport.height))
      : 100;
    const panelWidth = thumbW + 24;

    this._panel = document.createElement("div");
    this._panel.className = "pdf-thumbnails-panel";
    Object.assign(this._panel.style, {
      width: `${panelWidth}px`,
      flexShrink: "0",
      alignSelf: "flex-start",
      position: "sticky",
      top: `${topOffset}px`,
      maxHeight: `calc(100vh - ${topOffset}px)`,
      overflowY: "auto",
      background: "rgba(0,0,0,0.07)",
      display: "none",
    });

    this._items = renderers.map((pr) => this._createItem(pr));
    for (const item of this._items) this._panel.appendChild(item.wrapper);

    this._observer = new IntersectionObserver(
      (entries) => this._onIntersect(entries),
      { root: this._panel },
    );
  }

  get panel() {
    return this._panel;
  }

  show() {
    this._panel.style.display = "block";
    // Reconnect so the observer re-evaluates which items are now in view.
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
      const viewport = item.pr.page.getViewport({
        scale: THUMB_SCALE,
        rotation,
      });
      const w = Math.floor(viewport.width);
      const h = Math.floor(viewport.height);
      item.wrapper.style.width = `${w}px`;
      item.wrapper.style.height = `${h}px`;
      item.canvas.width = 0;
      item.canvas.height = 0;
      item.canvas.style.display = "none";
      item.spinner.style.display = "block";
      item.rendered = false;
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

  _createItem(pr) {
    const viewport = pr.page.getViewport({
      scale: THUMB_SCALE,
      rotation: this._rotation,
    });
    const w = Math.floor(viewport.width);
    const h = Math.floor(viewport.height);

    const wrapper = document.createElement("div");
    wrapper.dataset.pageNumber = String(pr.pageNumber);
    Object.assign(wrapper.style, {
      width: `${w}px`,
      height: `${h}px`,
      margin: "8px auto",
      cursor: "pointer",
      position: "relative",
      background: "#ccc",
      flexShrink: "0",
    });

    const canvas = document.createElement("canvas");
    canvas.style.display = "none";
    wrapper.appendChild(canvas);

    const spinner = this._createSpinner();
    wrapper.appendChild(spinner);

    const label = document.createElement("span");
    label.textContent = String(pr.pageNumber);
    Object.assign(label.style, {
      position: "absolute",
      bottom: "2px",
      right: "4px",
      fontSize: "10px",
      color: "rgba(0,0,0,0.6)",
      pointerEvents: "none",
    });
    wrapper.appendChild(label);

    wrapper.onclick = () => this._onNavigate?.(pr.pageNumber);
    return { wrapper, canvas, spinner, pr, rendered: false };
  }

  _createSpinner() {
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "absolute",
      top: "50%",
      left: "50%",
      width: "16px",
      height: "16px",
      marginTop: "-8px",
      marginLeft: "-8px",
      border: "2px solid rgba(0,0,0,0.12)",
      borderTopColor: "rgba(0,0,0,0.55)",
      borderRadius: "50%",
      pointerEvents: "none",
      boxSizing: "border-box",
    });
    el.animate(
      [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
      { duration: 800, iterations: Infinity },
    );
    return el;
  }

  async _renderItem(item) {
    if (item.rendered) return;
    item.rendered = true;
    const { pr, canvas, spinner } = item;
    const viewport = pr.page.getViewport({
      scale: THUMB_SCALE,
      rotation: this._rotation,
    });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = Math.floor(viewport.width) + "px";
    canvas.style.height = Math.floor(viewport.height) + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    await pr.page.render({ canvasContext: ctx, viewport }).promise;
    canvas.style.display = "block";
    spinner.style.display = "none";
  }

  _onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const n = parseInt(entry.target.dataset.pageNumber, 10);
      const item = this._items[n - 1];
      if (item) this._renderItem(item).catch(() => {});
    }
  }
}
