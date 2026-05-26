export class PdfToolbar {
  constructor(host, {
    pageCount,
    currentPage = 1,
    scale = 1,
    onPrev,
    onNext,
    onGoToPage,
    onZoomIn,
    onZoomOut,
    onFitWidth,
  }) {
    this._currentPage = currentPage;
    this._pageCount = pageCount;

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
    navInput.max = String(pageCount);
    navInput.value = String(currentPage);
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
    navTotal.textContent = `/ ${pageCount}`;
    Object.assign(navTotal.style, { padding: "0 2px" });

    const next = document.createElement("button");
    next.className = "pdf-viewer-next";
    next.title = "Next page";
    next.textContent = "↓";
    Object.assign(next.style, btnBase);

    prev.onclick = () => onPrev?.();
    next.onclick = () => onNext?.();
    navInput.onchange = () => {
      const v = parseInt(navInput.value, 10);
      if (Number.isFinite(v)) onGoToPage?.(v);
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
    display.textContent = `${Math.round(scale * 100)}%`;

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

    zoomOut.onclick = () => onZoomOut?.();
    zoomIn.onclick = () => onZoomIn?.();
    fitWidth.onclick = () => onFitWidth?.();

    zoomGroup.append(zoomOut, display, zoomIn, fitWidth);

    // --- Right placeholder (keeps the center cell centered) ---
    const rightSlot = document.createElement("div");

    toolbar.append(navGroup, zoomGroup, rightSlot);
    host.prepend(toolbar);

    this._el = toolbar;
    this._zoomDisplay = display;
    this._navInput = navInput;
    this._navTotal = navTotal;
    this._prevBtn = prev;
    this._nextBtn = next;

    this.updateNav(currentPage, pageCount);
  }

  updateNav(currentPage, pageCount) {
    if (!this._navInput) return;
    this._currentPage = currentPage;
    this._pageCount = pageCount;
    this._navInput.value = String(currentPage);
    this._navInput.max = String(pageCount);
    this._navTotal.textContent = `/ ${pageCount}`;
    const atFirst = currentPage <= 1;
    const atLast = currentPage >= pageCount;
    this._prevBtn.style.opacity = atFirst ? "0.4" : "1";
    this._prevBtn.style.pointerEvents = atFirst ? "none" : "auto";
    this._nextBtn.style.opacity = atLast ? "0.4" : "1";
    this._nextBtn.style.pointerEvents = atLast ? "none" : "auto";
  }

  updateZoom(scale) {
    if (!this._zoomDisplay) return;
    this._zoomDisplay.textContent = `${Math.round(scale * 100)}%`;
  }

  destroy() {
    this._el?.remove();
    this._el = null;
    this._zoomDisplay = null;
    this._navInput = null;
    this._navTotal = null;
    this._prevBtn = null;
    this._nextBtn = null;
  }
}
