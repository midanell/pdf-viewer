import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Registry of mocked pdfjs layer instances so tests can inspect constructor args
// and the render/update/cancel spies.
const { reg } = vi.hoisted(() => ({
  reg: { textLayers: [], annotLayers: [], setLayerDimensions: null },
}));

vi.mock("pdfjs-dist", () => {
  class TextLayer {
    constructor(opts) {
      this.opts = opts;
      this.render = vi.fn(() => Promise.resolve());
      this.update = vi.fn();
      this.cancel = vi.fn();
      reg.textLayers.push(this);
    }
  }
  class AnnotationLayer {
    constructor(opts) {
      this.opts = opts;
      this.render = vi.fn(() => Promise.resolve());
      this.update = vi.fn();
      reg.annotLayers.push(this);
    }
  }
  const setLayerDimensions = vi.fn();
  reg.setLayerDimensions = setLayerDimensions;
  return { TextLayer, AnnotationLayer, setLayerDimensions };
});

import { PageRenderer } from "../src/pageRenderer.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

// Percentage strings carry float noise (e.g. "20.000000000000004%"); compare numerically.
const pct = (v) => parseFloat(v);

// Fake page. Geometry scales with `scale` and swaps on 90/270 so sizing is
// observable. render() returns a controllable task; cancel() rejects its promise
// with a RenderingCancelledException, mirroring pdf.js.
function makePage(pageNumber = 1, { auto = true } = {}) {
  const tasks = [];
  const mkViewport = (scale, rotation) => {
    const w = 100 * scale;
    const h = 200 * scale;
    const dims = rotation % 180 === 0 ? { width: w, height: h } : { width: h, height: w };
    const vp = { ...dims, scale, rotation };
    vp.clone = ({ dontFlip = false } = {}) => ({ ...vp, dontFlip, clone: vp.clone });
    return vp;
  };
  return {
    pageNumber,
    getViewport: vi.fn(({ scale = 1, rotation = 0 } = {}) => mkViewport(scale, rotation)),
    streamTextContent: vi.fn(() => ({ source: "text" })),
    getAnnotations: vi.fn(() => Promise.resolve([{ id: 1 }])),
    cleanup: vi.fn(),
    render: vi.fn(() => {
      let resolve, reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const task = {
        promise,
        resolve,
        reject,
        cancel: vi.fn(() => {
          reject(Object.assign(new Error("cancelled"), { name: "RenderingCancelledException" }));
        }),
      };
      if (auto) resolve();
      tasks.push(task);
      return task;
    }),
    tasks,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  reg.textLayers.length = 0;
  reg.annotLayers.length = 0;
  reg.setLayerDimensions.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("PageRenderer construction", () => {
  it("builds a positioned wrapper with canvas, spinner and CSS round vars", () => {
    const pr = new PageRenderer(makePage(2));
    expect(pr.wrapper.style.position).toBe("relative");
    expect(pr.wrapper.dataset.pageNumber).toBe("2");
    expect(pr.wrapper.style.getPropertyValue("--scale-round-x")).toBe("1px");
    expect(pr.wrapper.style.getPropertyValue("--scale-round-y")).toBe("1px");
    expect(pr.wrapper.querySelector("canvas")).toBeTruthy();
    expect(pr.isRendered).toBe(false);
    expect(pr.textDiv).toBeNull();
  });

  it("records native (unrotated) page dimensions", () => {
    const pr = new PageRenderer(makePage());
    expect(pr.nativeWidthFor(0)).toBe(100);
    expect(pr.nativeHeightFor(0)).toBe(200);
    // 90/270 swap width and height
    expect(pr.nativeWidthFor(90)).toBe(200);
    expect(pr.nativeHeightFor(90)).toBe(100);
  });
});

describe("setSize()", () => {
  it("sizes the wrapper/canvas and sets the scale CSS vars", () => {
    const pr = new PageRenderer(makePage());
    pr.setSize({ scale: 2 });
    expect(pr.wrapper.style.width).toBe("200px"); // 100 * 2
    expect(pr.wrapper.style.height).toBe("400px");
    expect(pr.canvas.style.width).toBe("200px");
    expect(pr.wrapper.style.getPropertyValue("--scale-factor")).toBe("2");
    expect(pr.wrapper.style.getPropertyValue("--total-scale-factor")).toBe("2");
  });

  it("accounts for rotation when sizing", () => {
    const pr = new PageRenderer(makePage());
    pr.setSize({ scale: 2, rotation: 90 });
    expect(pr.wrapper.style.width).toBe("400px"); // height*scale after swap
    expect(pr.wrapper.style.height).toBe("200px");
  });
});

describe("render()", () => {
  it("rasterizes the canvas, renders the text layer, and cleans up", async () => {
    const page = makePage();
    const pr = new PageRenderer(page);
    await pr.render({ scale: 1.5 });

    expect(pr.isRendered).toBe(true);
    expect(page.render).toHaveBeenCalledTimes(1);
    expect(pr.canvas.width).toBe(150); // 100 * 1.5 * dpr(1)
    expect(reg.textLayers).toHaveLength(1);
    expect(reg.textLayers[0].render).toHaveBeenCalled();
    expect(reg.setLayerDimensions).toHaveBeenCalled();
    expect(page.cleanup).toHaveBeenCalled();
  });

  it("skips the annotation layer without a linkService", async () => {
    const pr = new PageRenderer(makePage());
    await pr.render({ scale: 1 });
    expect(reg.annotLayers).toHaveLength(0);
  });

  it("renders the annotation layer with a dontFlip viewport when a linkService is set", async () => {
    const page = makePage();
    const linkService = { name: "ls" };
    const pr = new PageRenderer(page, { linkService });
    await pr.render({ scale: 1 });

    expect(reg.annotLayers).toHaveLength(1);
    expect(reg.annotLayers[0].opts.viewport.dontFlip).toBe(true);
    expect(page.getAnnotations).toHaveBeenCalled();
    expect(reg.annotLayers[0].render).toHaveBeenCalled();
  });

  it("is a no-op when re-rendering at the same scale/rotation", async () => {
    const page = makePage();
    const pr = new PageRenderer(page);
    await pr.render({ scale: 1.5, rotation: 0 });
    await pr.render({ scale: 1.5, rotation: 0 });
    expect(page.render).toHaveBeenCalledTimes(1);
  });

  it("reuses and updates text/annotation layers on re-render at a different scale", async () => {
    const page = makePage();
    const linkService = {};
    const pr = new PageRenderer(page, { linkService });
    await pr.render({ scale: 1.0, rotation: 0 });

    reg.setLayerDimensions.mockClear();

    await pr.render({ scale: 2.0, rotation: 0 });

    // Both canvas renders ran
    expect(page.render).toHaveBeenCalledTimes(2);
    // TextLayer was created once (first render) then updated — never recreated
    expect(reg.textLayers).toHaveLength(1);
    expect(reg.textLayers[0].update).toHaveBeenCalledWith(
      expect.objectContaining({ viewport: expect.objectContaining({ scale: 2 }) }),
    );
    expect(reg.textLayers[0].render).toHaveBeenCalledTimes(1); // only the first render
    expect(reg.setLayerDimensions).toHaveBeenCalledTimes(1); // once for the second render
    // AnnotationLayer was created once then updated — never recreated
    expect(reg.annotLayers).toHaveLength(1);
    expect(reg.annotLayers[0].update).toHaveBeenCalled();
  });

  it("hides the spinner after render completes", async () => {
    const pr = new PageRenderer(makePage());
    await pr.render({ scale: 1 });
    expect(pr._spinner.style.display).toBe("none");
  });
});

describe("cancel()", () => {
  it("cancels an in-flight render task", async () => {
    const page = makePage(1, { auto: false });
    const pr = new PageRenderer(page);
    const renderP = pr.render({ scale: 1.5 }).catch(() => {});
    await tick(); // let render() create the task and suspend on Promise.all

    await pr.cancel();
    expect(page.tasks[0].cancel).toHaveBeenCalled();
    await renderP;
    expect(pr.isRendered).toBe(false);
  });

  it("is safe to call with no active render", async () => {
    const pr = new PageRenderer(makePage());
    await expect(pr.cancel()).resolves.toBeUndefined();
  });
});

describe("discard()", () => {
  it("tears the canvas down to a placeholder and marks it unrendered", async () => {
    const pr = new PageRenderer(makePage());
    pr.setSize({ scale: 1.5 });
    await pr.render({ scale: 1.5 });
    expect(pr.isRendered).toBe(true);

    pr.discard();
    expect(pr.isRendered).toBe(false);
    expect(pr.canvas.width).toBe(0);
    // re-applies the intended size so the placeholder keeps the scrollbar honest
    expect(pr.wrapper.style.width).toBe("150px");
    // spinner is restored so the placeholder signals "not yet rendered"
    expect(pr._spinner.style.display).toBe("block");
  });
});

describe("setCustomAnnotations()", () => {
  it("places a percentage-positioned rect for rotation 0", () => {
    const pr = new PageRenderer(makePage());
    pr.setSize({ scale: 1 });
    pr.setCustomAnnotations([{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }]);

    const layer = pr.wrapper.querySelector(".customAnnotationLayer");
    expect(layer.children).toHaveLength(1);
    const el = layer.children[0];
    expect(pct(el.style.left)).toBeCloseTo(10, 5);
    expect(pct(el.style.top)).toBeCloseTo(70, 5); // 1 - y - height = 0.7
    expect(pct(el.style.width)).toBeCloseTo(20, 5);
    expect(pct(el.style.height)).toBeCloseTo(20, 5);
  });

  it("filters out non-finite rects", () => {
    const pr = new PageRenderer(makePage());
    pr.setCustomAnnotations([{ x: 0.1 }, { foo: "bar" }]); // missing/NaN dims
    const layer = pr.wrapper.querySelector(".customAnnotationLayer");
    expect(layer.children).toHaveLength(0);
  });

  it("tolerates a non-array argument", () => {
    const pr = new PageRenderer(makePage());
    expect(() => pr.setCustomAnnotations(null)).not.toThrow();
  });

  it("rotates the rect bounding box for rotation 90", () => {
    const pr = new PageRenderer(makePage());
    pr.setSize({ scale: 1, rotation: 90 });
    pr.setCustomAnnotations([{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }]);
    const el = pr.wrapper.querySelector(".customAnnotationLayer").children[0];
    // unrotated top-left = (0.1, 0.7); rotate(90): (u,v)->(1-v,u)
    // corners (0.1,0.7) & (0.3,0.9) -> (0.3,0.1) & (0.1,0.3); bbox left=0.1 top=0.1
    expect(pct(el.style.left)).toBeCloseTo(10, 5);
    expect(pct(el.style.top)).toBeCloseTo(10, 5);
    expect(pct(el.style.width)).toBeCloseTo(20, 5);
    expect(pct(el.style.height)).toBeCloseTo(20, 5);
  });
});
