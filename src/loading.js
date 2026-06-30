// Progress overlay shown while a PDF is downloading/parsing. Starts in
// indeterminate mode (animated bar) and switches to a determinate percentage
// bar once the browser reports a Content-Length via the PDF.js onProgress hook.

const FILL_INITIAL_WIDTH  = "40%";  // indeterminate bar starting position
const FILL_ANIM_DURATION_MS = 1200; // one sweep of the indeterminate animation
const BAR_WIDTH_PX = 240;

export class PdfLoading {
  constructor(host) {
    const { overlay, text, fill, anim } = this._buildOverlay();
    host.appendChild(overlay);

    this._overlay = overlay;
    this._text = text;
    this._fill = fill;
    this._anim = anim;          // keep name — referenced by tests
    this._indeterminate = true;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  update({ loaded, total }) {
    if (total > 0) {
      if (this._indeterminate) {
        this._anim.cancel();
        this._indeterminate = false;
      }
      const pct = Math.min(100, Math.round((loaded / total) * 100));
      this._text.textContent = `Loading ${pct}%`;
      this._fill.style.width = `${pct}%`;
    } else {
      if (!this._indeterminate) {
        this._indeterminate = true;
        this._fill.style.width = FILL_INITIAL_WIDTH;
        this._anim.play();
      }
      this._text.textContent = "Loading…";
    }
  }

  destroy() {
    this._anim.cancel();
    this._overlay.remove();
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  _buildOverlay() {
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "absolute",
      inset: "0",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: "0.5rem",
      background: "rgba(82, 86, 89, 0.85)",
      color: "#ddd",
      fontSize: "0.85rem",
      fontFamily: "sans-serif",
      pointerEvents: "none",
      zIndex: "20",
    });

    const text = document.createElement("div");
    text.textContent = "Loading…";

    const { bar, fill, anim } = this._buildProgressBar();

    overlay.append(text, bar);
    return { overlay, text, fill, anim };
  }

  _buildProgressBar() {
    const bar = document.createElement("div");
    Object.assign(bar.style, {
      width: `${BAR_WIDTH_PX}px`,
      height: "3px",
      background: "#1a1b1d",
      borderRadius: "2px",
      overflow: "hidden",
    });

    const fill = document.createElement("div");
    Object.assign(fill.style, {
      height: "100%",
      width: FILL_INITIAL_WIDTH,
      background: "#4a9eff",
      transition: "width 0.15s linear",
    });
    bar.appendChild(fill);

    // Sweep the fill across the bar repeatedly while progress is unknown.
    const anim = fill.animate(
      [{ transform: "translateX(-100%)" }, { transform: "translateX(250%)" }],
      { duration: FILL_ANIM_DURATION_MS, iterations: Infinity, easing: "ease-in-out" },
    );

    return { bar, fill, anim };
  }
}
