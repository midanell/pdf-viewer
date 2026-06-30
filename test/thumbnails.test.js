import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetObservers } from "./setup.js";
import { PdfThumbnails } from "../src/thumbnails.js";

// Fake PageRenderer: only the page geometry + render the thumbnail panel touches.
// getViewport is rotation-aware so setRotation() produces observably new sizes.
function makeRenderer(pageNumber) {
  return {
    pageNumber,
    page: {
      getViewport: vi.fn(({ scale, rotation = 0 } = {}) => {
        const base = { width: 100 * scale, height: 200 * scale };
        return rotation % 180 === 0
          ? { ...base }
          : { width: base.height, height: base.width };
      }),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
    },
  };
}

const makeRenderers = (n) =>
  Array.from({ length: n }, (_, i) => makeRenderer(i + 1));

// The panel's IntersectionObserver is the last one created in the constructor.
const thumbObserver = () => globalThis.__observers.intersection.at(-1);

let instances;
beforeEach(() => {
  document.body.innerHTML = "";
  resetObservers();
  Element.prototype.scrollIntoView.mockClear?.();
  instances = [];
});
afterEach(() => {
  // Tolerate tests that already destroyed (destroy() is not idempotent by design).
  for (const t of instances) {
    try {
      t.destroy?.();
    } catch {
      /* already torn down */
    }
  }
});

function mount(renderers, opts = {}) {
  const t = new PdfThumbnails(renderers, opts);
  instances.push(t);
  document.body.appendChild(t.panel);
  return t;
}

describe("PdfThumbnails constructor", () => {
  it("builds one hidden item per renderer and exposes the panel", () => {
    const t = mount(makeRenderers(3));
    expect(t.panel).toBeInstanceOf(HTMLElement);
    expect(t.panel.style.display).toBe("none");
    expect(t.panel.querySelectorAll("[data-page-number]")).toHaveLength(3);
  });
});

describe("show() / hide()", () => {
  it("show() reveals the panel and observes every item", () => {
    const t = mount(makeRenderers(2));
    t.show();
    expect(t.panel.style.display).toBe("block");
    expect(thumbObserver().targets.size).toBe(2);
  });

  it("hide() collapses the panel", () => {
    const t = mount(makeRenderers(2));
    t.show();
    t.hide();
    expect(t.panel.style.display).toBe("none");
  });

  it("renders an item's canvas when it scrolls into view", async () => {
    const renderers = makeRenderers(2);
    const t = mount(renderers);
    t.show();

    const firstWrapper = t.panel.querySelector('[data-slot-index="1"]');
    thumbObserver().fire([{ isIntersecting: true, target: firstWrapper }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(renderers[0].page.render).toHaveBeenCalled();
    const canvas = firstWrapper.querySelector("canvas");
    expect(canvas.style.display).toBe("block");
  });

  it("ignores entries that are not intersecting", () => {
    const renderers = makeRenderers(2);
    const t = mount(renderers);
    t.show();
    const firstWrapper = t.panel.querySelector('[data-slot-index="1"]');
    thumbObserver().fire([{ isIntersecting: false, target: firstWrapper }]);
    expect(renderers[0].page.render).not.toHaveBeenCalled();
  });
});

describe("setRotation()", () => {
  it("re-sizes every item for the new rotation", () => {
    const t = mount(makeRenderers(2));
    const wrapper = t.panel.querySelector('[data-slot-index="1"]');
    expect(wrapper.style.width).toBe("20px"); // 100 * 0.2, rotation 0
    expect(wrapper.style.height).toBe("40px");

    t.setRotation(90);
    expect(wrapper.style.width).toBe("40px"); // swapped
    expect(wrapper.style.height).toBe("20px");
  });

  it("is a no-op when the rotation is unchanged", () => {
    const renderers = makeRenderers(1);
    const t = mount(renderers);
    renderers[0].page.getViewport.mockClear();
    t.setRotation(0); // same as default
    expect(renderers[0].page.getViewport).not.toHaveBeenCalled();
  });

  it("resets each item's canvas to hidden so it re-renders after rotation", () => {
    const t = mount(makeRenderers(1));
    const wrapper = t.panel.querySelector('[data-slot-index="1"]');
    const canvas = wrapper.querySelector("canvas");

    t.setRotation(90);

    // Canvas is zeroed and hidden; the next intersection will re-render it
    expect(canvas.width).toBe(0);
    expect(canvas.style.display).toBe("none");
  });
});

describe("updateCurrentPage()", () => {
  it("moves the highlight outline to the new page and scrolls it into view", () => {
    const t = mount(makeRenderers(3));
    const items = t.panel.querySelectorAll("[data-slot-index]");

    t.updateCurrentPage(2);
    expect(items[1].style.outline).not.toBe("");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

    t.updateCurrentPage(3);
    expect(items[1].style.outline).toBe(""); // previous cleared
    expect(items[2].style.outline).not.toBe("");
  });
});

describe("navigation callback", () => {
  it("clicking an item calls onNavigate with its slot index", () => {
    const onNavigate = vi.fn();
    const t = mount(makeRenderers(3), { onNavigate });
    t.panel.querySelector('[data-slot-index="2"]').onclick();
    expect(onNavigate).toHaveBeenCalledWith(2);
  });
});

describe("destroy()", () => {
  it("disconnects the observer and removes the panel", () => {
    const t = mount(makeRenderers(2));
    const panel = t.panel;
    t.destroy();
    expect(panel.isConnected).toBe(false);
  });
});
