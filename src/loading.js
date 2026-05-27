export class PdfLoading {
  constructor(host) {
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

    const bar = document.createElement("div");
    Object.assign(bar.style, {
      width: "240px",
      height: "3px",
      background: "#1a1b1d",
      borderRadius: "2px",
      overflow: "hidden",
    });

    const fill = document.createElement("div");
    Object.assign(fill.style, {
      height: "100%",
      width: "40%",
      background: "#4a9eff",
      transition: "width 0.15s linear",
    });

    bar.appendChild(fill);
    overlay.append(text, bar);
    host.appendChild(overlay);

    this._overlay = overlay;
    this._text = text;
    this._fill = fill;
    this._anim = fill.animate(
      [{ transform: "translateX(-100%)" }, { transform: "translateX(250%)" }],
      { duration: 1200, iterations: Infinity, easing: "ease-in-out" },
    );
    this._indeterminate = true;
  }

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
        this._fill.style.width = "40%";
        this._anim.play();
      }
      this._text.textContent = "Loading…";
    }
  }

  destroy() {
    this._anim.cancel();
    this._overlay.remove();
  }
}
