import { describe, it, expect, beforeEach } from "vitest";
import { PdfLoading } from "../src/loading.js";

// The indeterminate bar uses element.animate(); test/setup.js stubs it to return
// a fake Animation whose cancel/play are spies. The instance keeps it on `_anim`.

describe("PdfLoading", () => {
  let host;
  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("mounts an overlay into the host and starts indeterminate", () => {
    const loading = new PdfLoading(host);
    expect(host.children).toHaveLength(1);
    expect(host.textContent).toContain("Loading…");
    // animation object exists (indeterminate bar is running)
    expect(loading._anim).toBeTruthy();
  });

  describe("update()", () => {
    it("switches to determinate and reflects the percentage", () => {
      const loading = new PdfLoading(host);
      loading.update({ loaded: 25, total: 100 });

      expect(loading._anim.cancel).toHaveBeenCalledTimes(1); // left indeterminate
      expect(host.textContent).toContain("Loading 25%");
      expect(loading._fill.style.width).toBe("25%");
    });

    it("clamps the percentage at 100", () => {
      const loading = new PdfLoading(host);
      loading.update({ loaded: 200, total: 100 });
      expect(host.textContent).toContain("Loading 100%");
      expect(loading._fill.style.width).toBe("100%");
    });

    it("cancels the indeterminate animation only once across determinate updates", () => {
      const loading = new PdfLoading(host);
      loading.update({ loaded: 10, total: 100 });
      loading.update({ loaded: 50, total: 100 });
      expect(loading._anim.cancel).toHaveBeenCalledTimes(1);
      expect(host.textContent).toContain("Loading 50%");
    });

    it("returns to indeterminate when total drops to 0", () => {
      const loading = new PdfLoading(host);
      loading.update({ loaded: 50, total: 100 }); // determinate
      loading.update({ loaded: 0, total: 0 }); // back to indeterminate

      expect(loading._anim.play).toHaveBeenCalledTimes(1);
      expect(loading._fill.style.width).toBe("40%");
      expect(host.textContent).toContain("Loading…");
    });

    it("stays indeterminate (no anim churn) while total is 0", () => {
      const loading = new PdfLoading(host);
      loading.update({ loaded: 0, total: 0 });
      expect(loading._anim.play).not.toHaveBeenCalled();
      expect(loading._anim.cancel).not.toHaveBeenCalled();
    });
  });

  describe("destroy()", () => {
    it("cancels the animation and removes the overlay", () => {
      const loading = new PdfLoading(host);
      const anim = loading._anim;
      loading.destroy();
      expect(anim.cancel).toHaveBeenCalled();
      expect(host.children).toHaveLength(0);
    });
  });
});
