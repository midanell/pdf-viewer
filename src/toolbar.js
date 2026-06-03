const TOGGLE_ON = "rgba(74,158,255,0.6)";
const TOGGLE_OFF = "rgba(255,255,255,0.15)";
const COMPACT_BREAK_POINT = 600;

export class PdfToolbar {
  constructor(
    host,
    {
      pageCount,
      currentPage = 1,
      scale = 1,
      fitWidthActive = true,
      thumbnailsActive = false,
      onPrev,
      onNext,
      onGoToPage,
      onZoomIn,
      onZoomOut,
      onFitWidth,
      onRotateCW,
      onRotateCCW,
      onThumbnails,
      onSearch,
      onPrevMatch,
      onNextMatch,
    },
  ) {
    this._currentPage = currentPage;
    this._pageCount = pageCount;

    const toolbar = document.createElement("div");
    toolbar.className = "pdf-viewer-toolbar";
    Object.assign(toolbar.style, {
      flexShrink: "0",
      zIndex: "10",
      display: "grid",
      gridTemplateColumns: "1fr auto 1fr",
      alignItems: "center",
      gap: "4px",
      padding: "6px 8px",
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
      whiteSpace: "nowrap",
    };

    const groupStyle = {
      display: "flex",
      alignItems: "center",
      gap: "4px",
      position: "relative",
    };

    const createMoreButton = () => {
      const b = document.createElement("button");
      b.className = "pdf-viewer-more";
      b.title = "More";
      b.textContent = "...";
      Object.assign(b.style, btnBase);
      b.style.display = "none";
      return b;
    };

    const createDropdown = () => {
      const d = document.createElement("div");
      d.className = "pdf-viewer-dropdown";
      Object.assign(d.style, {
        position: "absolute",
        top: "100%",
        right: "0",
        marginTop: "4px",
        display: "none",
        flexDirection: "row",
        flexWrap: "no-wrap",
        gap: "4px",
        padding: "6px 8px",
        background: "rgba(0,0,0,0.85)",
        borderRadius: "4px",
        zIndex: "11",
        alignItems: "center",
      });
      return d;
    };

    // --- Nav group (left cell) ---
    const navGroup = document.createElement("div");
    navGroup.className = "pdf-viewer-nav-group";
    Object.assign(navGroup.style, groupStyle, { justifySelf: "start" });

    const thumbnailsBtn = document.createElement("button");
    thumbnailsBtn.className = "pdf-viewer-thumbnails";
    thumbnailsBtn.title = "Toggle thumbnails";
    thumbnailsBtn.textContent = "☰";
    Object.assign(thumbnailsBtn.style, btnBase);
    thumbnailsBtn.style.background = thumbnailsActive ? TOGGLE_ON : TOGGLE_OFF;
    thumbnailsBtn.onclick = () => onThumbnails?.();

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
    Object.assign(navTotal.style, { padding: "0 2px", whiteSpace: "nowrap" });

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

    navGroup.append(thumbnailsBtn, prev, navInput, navTotal, next);

    const navMore = createMoreButton();
    const navDropdown = createDropdown();
    navGroup.append(navMore, navDropdown);

    // --- Zoom group (center cell) ---
    const zoomGroup = document.createElement("div");
    zoomGroup.className = "pdf-viewer-zoom-group";
    Object.assign(zoomGroup.style, groupStyle);

    const rotateCCW = document.createElement("button");
    rotateCCW.className = "pdf-viewer-rotate-ccw";
    rotateCCW.title = "Rotate counterclockwise";
    rotateCCW.textContent = "↺";
    Object.assign(rotateCCW.style, btnBase);

    const rotateCW = document.createElement("button");
    rotateCW.className = "pdf-viewer-rotate-cw";
    rotateCW.title = "Rotate clockwise";
    rotateCW.textContent = "↻";
    Object.assign(rotateCW.style, btnBase);

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
    fitWidth.style.background = fitWidthActive ? TOGGLE_ON : TOGGLE_OFF;

    zoomOut.onclick = () => onZoomOut?.();
    zoomIn.onclick = () => onZoomIn?.();
    fitWidth.onclick = () => onFitWidth?.();
    rotateCCW.onclick = () => onRotateCCW?.();
    rotateCW.onclick = () => onRotateCW?.();

    zoomGroup.append(rotateCCW, rotateCW, zoomOut, display, zoomIn, fitWidth);

    const zoomMore = createMoreButton();
    const zoomDropdown = createDropdown();
    zoomGroup.append(zoomMore, zoomDropdown);

    // --- Search group (right cell) ---
    const searchGroup = document.createElement("div");
    searchGroup.className = "pdf-viewer-search-group";
    Object.assign(searchGroup.style, groupStyle, { justifySelf: "end" });

    const searchInput = document.createElement("input");
    searchInput.className = "pdf-viewer-search";
    searchInput.type = "search";
    searchInput.placeholder = "Search…";
    Object.assign(searchInput.style, {
      width: "80px",
      height: "26px",
      padding: "0 8px",
      background: "rgba(0,0,0,0.4)",
      color: "#fff",
      border: "1px solid rgba(255,255,255,0.15)",
      borderRadius: "3px",
      fontSize: "13px",
      boxSizing: "border-box",
    });

    const matchCaseBtn = document.createElement("button");
    matchCaseBtn.className = "pdf-viewer-match-case";
    matchCaseBtn.title = "Match case";
    matchCaseBtn.textContent = "Aa";
    Object.assign(matchCaseBtn.style, btnBase);

    const wholeWordBtn = document.createElement("button");
    wholeWordBtn.className = "pdf-viewer-whole-word";
    wholeWordBtn.title = "Match whole word";
    wholeWordBtn.innerHTML = "<u>ab</u>";
    Object.assign(wholeWordBtn.style, btnBase);

    const counter = document.createElement("span");
    counter.className = "pdf-viewer-search-count";
    Object.assign(counter.style, {
      minWidth: "56px",
      textAlign: "center",
      fontSize: "11px",
      color: "rgba(255,255,255,0.7)",
    });

    const prevMatchBtn = document.createElement("button");
    prevMatchBtn.className = "pdf-viewer-prev-match";
    prevMatchBtn.title = "Previous match";
    prevMatchBtn.textContent = "<";
    Object.assign(prevMatchBtn.style, btnBase);

    const nextMatchBtn = document.createElement("button");
    nextMatchBtn.className = "pdf-viewer-next-match";
    nextMatchBtn.title = "Next match";
    nextMatchBtn.textContent = ">";
    Object.assign(nextMatchBtn.style, btnBase);

    let matchCase = false;
    let wholeWord = false;

    const applyToggleStyle = (btn, active) => {
      btn.style.background = active ? TOGGLE_ON : TOGGLE_OFF;
    };
    applyToggleStyle(matchCaseBtn, false);
    applyToggleStyle(wholeWordBtn, false);

    const triggerSearch = () => {
      onSearch?.({
        query: searchInput.value.trim(),
        matchCase,
        wholeWord,
      });
    };

    this._searchTimer = null;
    searchInput.oninput = () => {
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(triggerSearch, 250);
    };

    matchCaseBtn.onclick = () => {
      matchCase = !matchCase;
      applyToggleStyle(matchCaseBtn, matchCase);
      triggerSearch();
    };
    wholeWordBtn.onclick = () => {
      wholeWord = !wholeWord;
      applyToggleStyle(wholeWordBtn, wholeWord);
      triggerSearch();
    };

    prevMatchBtn.onclick = () => onPrevMatch?.();
    nextMatchBtn.onclick = () => onNextMatch?.();

    searchGroup.append(
      searchInput,
      matchCaseBtn,
      wholeWordBtn,
      prevMatchBtn,
      counter,
      nextMatchBtn,
    );

    const searchMore = createMoreButton();
    searchMore.style.display = "flex";
    const searchDropdown = createDropdown();
    searchGroup.append(searchMore, searchDropdown);

    toolbar.append(navGroup, zoomGroup, searchGroup);
    host.prepend(toolbar);

    this._groupSpecs = [
      {
        container: navGroup,
        fullOrder: [thumbnailsBtn, prev, navInput, navTotal, next],
        essentials: [thumbnailsBtn, prev, next],
        nonEssentials: [navInput, navTotal],
        moreBtn: navMore,
        dropdown: navDropdown,
      },
      {
        container: zoomGroup,
        fullOrder: [rotateCCW, rotateCW, zoomOut, display, zoomIn, fitWidth],
        essentials: [rotateCCW, rotateCW, zoomOut, zoomIn],
        nonEssentials: [display, fitWidth],
        moreBtn: zoomMore,
        dropdown: zoomDropdown,
      },
      {
        container: searchGroup,
        fullOrder: [searchInput, prevMatchBtn, counter, nextMatchBtn],
        essentials: [searchInput],
        nonEssentials: [prevMatchBtn, counter, nextMatchBtn],
        alwaysInDropdown: [matchCaseBtn, wholeWordBtn],
        moreBtn: searchMore,
        dropdown: searchDropdown,
      },
    ];

    for (const spec of this._groupSpecs) {
      spec.moreBtn.onclick = () => this._toggleDropdown(spec);
    }

    this._compact = null;
    this._setCompact(
      toolbar.getBoundingClientRect().width < COMPACT_BREAK_POINT,
    );

    this._resizeObserver = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      this._setCompact(w < COMPACT_BREAK_POINT);
    });
    this._resizeObserver.observe(toolbar);

    this._el = toolbar;
    this._zoomDisplay = display;
    this._fitWidthBtn = fitWidth;
    this._thumbnailsBtn = thumbnailsBtn;
    this._navInput = navInput;
    this._navTotal = navTotal;
    this._prevBtn = prev;
    this._nextBtn = next;
    this._searchInput = searchInput;
    this._searchCount = counter;
    this._prevMatchBtn = prevMatchBtn;
    this._nextMatchBtn = nextMatchBtn;

    this.updateNav(currentPage, pageCount);
    this.updateSearch(0, 0);
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

  updateFitWidth(active) {
    if (!this._fitWidthBtn) return;
    this._fitWidthBtn.style.background = active ? TOGGLE_ON : TOGGLE_OFF;
  }

  updateThumbnails(active) {
    if (!this._thumbnailsBtn) return;
    this._thumbnailsBtn.style.background = active ? TOGGLE_ON : TOGGLE_OFF;
  }

  _setCompact(compact) {
    if (compact === this._compact) return;
    this._compact = compact;
    for (const spec of this._groupSpecs) this._relayoutGroup(spec);
  }

  _relayoutGroup(spec) {
    while (spec.container.firstChild) {
      spec.container.removeChild(spec.container.firstChild);
    }
    while (spec.dropdown.firstChild) {
      spec.dropdown.removeChild(spec.dropdown.firstChild);
    }
    const alwaysDropdown = spec.alwaysInDropdown ?? [];
    const hasAlways = alwaysDropdown.length > 0;
    if (this._compact) {
      for (const el of spec.essentials) spec.container.appendChild(el);
      for (const el of alwaysDropdown) spec.dropdown.appendChild(el);
      for (const el of spec.nonEssentials) spec.dropdown.appendChild(el);
      spec.container.appendChild(spec.moreBtn);
      spec.container.appendChild(spec.dropdown);
      spec.moreBtn.style.display = "flex";
      spec.dropdown.style.display = "none";
      spec.moreBtn.style.background = TOGGLE_OFF;
    } else {
      for (const el of spec.fullOrder) spec.container.appendChild(el);
      if (hasAlways) {
        for (const el of alwaysDropdown) spec.dropdown.appendChild(el);
        spec.container.appendChild(spec.moreBtn);
        spec.container.appendChild(spec.dropdown);
        spec.moreBtn.style.display = "flex";
        spec.dropdown.style.display = "none";
        spec.moreBtn.style.background = TOGGLE_OFF;
      }
    }
  }

  _toggleDropdown(spec) {
    const open = spec.dropdown.style.display !== "none";
    if (open) {
      spec.dropdown.style.display = "none";
      spec.moreBtn.style.background = TOGGLE_OFF;
    } else {
      spec.dropdown.style.display = "flex";
      spec.moreBtn.style.background = TOGGLE_ON;
    }
  }

  updateSearch(current, total) {
    if (!this._searchCount) return;
    const hasQuery = this._searchInput?.value.trim().length > 0;
    if (total === 0 && !hasQuery) {
      this._searchCount.textContent = "";
    } else if (total === 0) {
      this._searchCount.textContent = "No results";
    } else {
      this._searchCount.textContent = `${current} / ${total}`;
    }
    const hasMatches = total > 0;
    const dim = (btn) => {
      btn.style.opacity = hasMatches ? "1" : "0.4";
      btn.style.pointerEvents = hasMatches ? "auto" : "none";
    };
    dim(this._prevMatchBtn);
    dim(this._nextMatchBtn);
  }

  focusSearch() {
    this._searchInput?.focus();
    this._searchInput?.select();
  }

  clearSearch() {
    if (!this._searchInput) return;
    this._searchInput.value = "";
    clearTimeout(this._searchTimer);
  }

  isSearchFocused() {
    return document.activeElement === this._searchInput;
  }

  destroy() {
    clearTimeout(this._searchTimer);
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._el?.remove();
    this._el = null;
    this._zoomDisplay = null;
    this._fitWidthBtn = null;
    this._thumbnailsBtn = null;
    this._navInput = null;
    this._navTotal = null;
    this._prevBtn = null;
    this._nextBtn = null;
    this._searchInput = null;
    this._searchCount = null;
    this._prevMatchBtn = null;
    this._nextMatchBtn = null;
  }
}
