import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetObservers } from "./setup.js";
import { PdfToolbar } from "../src/toolbar.js";

const CALLBACKS = [
  "onPrev", "onNext", "onGoToPage", "onZoomIn", "onZoomOut", "onFitWidth",
  "onFitPage", "onRotateCW", "onRotateCCW", "onThumbnails", "onSearch",
  "onPrevMatch", "onNextMatch",
];

let instances;
function mount(opts = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const cbs = Object.fromEntries(CALLBACKS.map((n) => [n, vi.fn()]));
  const toolbar = new PdfToolbar(host, { pageCount: 10, currentPage: 1, scale: 1, ...cbs, ...opts });
  instances.push(toolbar);
  const $ = (sel) => host.querySelector(sel);
  return { toolbar, host, cbs, $ };
}

// The toolbar's ResizeObserver is the last one created.
const resizeObs = () => globalThis.__observers.resize.at(-1);

beforeEach(() => {
  document.body.innerHTML = "";
  resetObservers();
  instances = [];
});
afterEach(() => {
  for (const t of instances) {
    try {
      t.destroy();
    } catch {
      /* already destroyed */
    }
  }
  vi.useRealTimers();
});

describe("construction", () => {
  it("renders the toolbar into the host", () => {
    const { $ } = mount();
    expect($(".pdf-viewer-toolbar")).toBeTruthy();
    expect($(".pdf-viewer-search")).toBeTruthy();
    expect($(".pdf-viewer-zoom-display")).toBeTruthy();
  });

  it("starts compact when the host has no measurable width (jsdom)", () => {
    const { toolbar } = mount();
    expect(toolbar._compact).toBe(true);
  });

  it("leaves compact mode when the ResizeObserver reports a wide toolbar", () => {
    const { toolbar } = mount();
    resizeObs().fire([{ contentRect: { width: 800 } }]);
    expect(toolbar._compact).toBe(false);
  });

  it("applies fitWidthActive=false and thumbnailsActive=true from constructor options", () => {
    const { $ } = mount({ fitWidthActive: false, thumbnailsActive: true });
    expect($(".pdf-viewer-fit-width").style.background).not.toContain("74, 158, 255");
    expect($(".pdf-viewer-thumbnails").style.background).toContain("74, 158, 255");
  });
});

describe("button wiring", () => {
  it("routes navigation, zoom and rotation clicks to their callbacks", () => {
    const { cbs, $ } = mount();
    $(".pdf-viewer-prev").click();
    $(".pdf-viewer-next").click();
    $(".pdf-viewer-zoom-in").click();
    $(".pdf-viewer-zoom-out").click();
    $(".pdf-viewer-fit-width").click();
    $(".pdf-viewer-fit-page").click();
    $(".pdf-viewer-rotate-cw").click();
    $(".pdf-viewer-rotate-ccw").click();
    $(".pdf-viewer-thumbnails").click();

    expect(cbs.onPrev).toHaveBeenCalled();
    expect(cbs.onNext).toHaveBeenCalled();
    expect(cbs.onZoomIn).toHaveBeenCalled();
    expect(cbs.onZoomOut).toHaveBeenCalled();
    expect(cbs.onFitWidth).toHaveBeenCalled();
    expect(cbs.onFitPage).toHaveBeenCalled();
    expect(cbs.onRotateCW).toHaveBeenCalled();
    expect(cbs.onRotateCCW).toHaveBeenCalled();
    expect(cbs.onThumbnails).toHaveBeenCalled();
  });

  it("commits a valid page input via onGoToPage", () => {
    const { cbs, $ } = mount({ currentPage: 2 });
    const input = $(".pdf-viewer-page-input");
    input.value = "5";
    input.dispatchEvent(new Event("change"));
    expect(cbs.onGoToPage).toHaveBeenCalledWith(5);
  });

  it("reverts an invalid page input without calling onGoToPage", () => {
    const { cbs, $ } = mount({ currentPage: 2 });
    const input = $(".pdf-viewer-page-input");
    input.value = "abc"; // number input coerces to ""
    input.dispatchEvent(new Event("change"));
    expect(cbs.onGoToPage).not.toHaveBeenCalled();
    expect(input.value).toBe("2");
  });

  it("routes match-navigation clicks", () => {
    const { cbs, $ } = mount();
    $(".pdf-viewer-prev-match").click();
    $(".pdf-viewer-next-match").click();
    expect(cbs.onPrevMatch).toHaveBeenCalled();
    expect(cbs.onNextMatch).toHaveBeenCalled();
  });
});

describe("search input", () => {
  it("debounces typing into a single onSearch call", () => {
    vi.useFakeTimers();
    const { cbs, $ } = mount();
    const input = $(".pdf-viewer-search");
    input.value = "  hello  ";
    input.dispatchEvent(new Event("input"));
    expect(cbs.onSearch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(cbs.onSearch).toHaveBeenCalledWith({
      query: "hello", // trimmed
      matchCase: false,
      wholeWord: false,
    });
  });

  it("Enter navigates to the next match when no search is pending", () => {
    const { cbs, $ } = mount();
    const input = $(".pdf-viewer-search");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(cbs.onNextMatch).toHaveBeenCalled();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
    expect(cbs.onPrevMatch).toHaveBeenCalled();
  });

  it("Enter commits a still-pending debounced search instead of navigating", () => {
    vi.useFakeTimers();
    const { cbs, $ } = mount();
    const input = $(".pdf-viewer-search");
    input.value = "term";
    input.dispatchEvent(new Event("input")); // starts the 250ms timer
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(cbs.onSearch).toHaveBeenCalledWith({ query: "term", matchCase: false, wholeWord: false });
    expect(cbs.onNextMatch).not.toHaveBeenCalled();
  });

  it("toggling match-case re-runs the search with the flag set", () => {
    const { cbs, $ } = mount();
    $(".pdf-viewer-search").value = "x";
    $(".pdf-viewer-match-case").click();
    expect(cbs.onSearch).toHaveBeenLastCalledWith({ query: "x", matchCase: true, wholeWord: false });
  });

  it("toggling whole-word re-runs the search with the flag set", () => {
    const { cbs, $ } = mount();
    $(".pdf-viewer-search").value = "x";
    $(".pdf-viewer-whole-word").click();
    expect(cbs.onSearch).toHaveBeenLastCalledWith({ query: "x", matchCase: false, wholeWord: true });
  });

  it("shows the search spinner when a search fires", () => {
    vi.useFakeTimers();
    const { toolbar, $ } = mount();
    $(".pdf-viewer-search").value = "test";
    $(".pdf-viewer-search").dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(250);
    expect(toolbar._searchSpinner.style.display).toBe("block");
  });
});

describe("compact mode dropdown", () => {
  it("the '...' button opens and closes the overflow dropdown", () => {
    const { $ } = mount();
    // toolbar starts compact (jsdom BoundingClientRect.width === 0)
    const moreBtn = $(".pdf-viewer-more");
    // the dropdown is always appended immediately after its moreBtn
    const dropdown = moreBtn.nextElementSibling;

    expect(moreBtn.style.display).toBe("flex"); // visible in compact
    expect(dropdown.style.display).toBe("none"); // closed initially

    moreBtn.click();
    expect(dropdown.style.display).toBe("flex"); // open

    moreBtn.click();
    expect(dropdown.style.display).toBe("none"); // closed again
  });
});

describe("update methods", () => {
  it("updateNav reflects page/total and dims prev/next at the ends", () => {
    const { toolbar, $ } = mount();
    toolbar.updateNav(1, 10);
    expect($(".pdf-viewer-page-input").value).toBe("1");
    expect($(".pdf-viewer-page-total").textContent).toBe("/ 10");
    expect($(".pdf-viewer-prev").style.opacity).toBe("0.4"); // at first
    expect($(".pdf-viewer-next").style.opacity).toBe("1");

    toolbar.updateNav(10, 10);
    expect($(".pdf-viewer-next").style.opacity).toBe("0.4"); // at last
  });

  it("updateZoom renders the scale as a percentage", () => {
    const { toolbar, $ } = mount();
    toolbar.updateZoom(2);
    expect($(".pdf-viewer-zoom-display").textContent).toBe("200%");
  });

  it("updateFitWidth / updateFitPage / updateThumbnails toggle the active style", () => {
    const { toolbar, $ } = mount();
    toolbar.updateFitWidth(true);
    expect($(".pdf-viewer-fit-width").style.background).toContain("74, 158, 255");
    toolbar.updateFitWidth(false);
    expect($(".pdf-viewer-fit-width").style.background).not.toContain("74, 158, 255");

    toolbar.updateFitPage(true);
    expect($(".pdf-viewer-fit-page").style.background).toContain("74, 158, 255");
    toolbar.updateThumbnails(true);
    expect($(".pdf-viewer-thumbnails").style.background).toContain("74, 158, 255");
  });

  it("updateSearch shows count states and dims match-nav without results", () => {
    const { toolbar, $ } = mount();
    const count = $(".pdf-viewer-search-count");

    toolbar.updateSearch(0, 0); // no query
    expect(count.textContent).toBe("");
    expect($(".pdf-viewer-next-match").style.opacity).toBe("0.4");

    $(".pdf-viewer-search").value = "x";
    toolbar.updateSearch(0, 0); // query, no hits
    expect(count.textContent).toBe("No results");

    toolbar.updateSearch(2, 5);
    expect(count.textContent).toBe("2 / 5");
    expect($(".pdf-viewer-next-match").style.opacity).toBe("1");
  });
});

describe("search focus helpers", () => {
  it("focusSearch focuses the input and isSearchFocused reports it", () => {
    const { toolbar, $ } = mount();
    toolbar.focusSearch();
    expect(document.activeElement).toBe($(".pdf-viewer-search"));
    expect(toolbar.isSearchFocused()).toBe(true);
  });

  it("clearSearch empties the field", () => {
    const { toolbar, $ } = mount();
    const input = $(".pdf-viewer-search");
    input.value = "abc";
    toolbar.clearSearch();
    expect(input.value).toBe("");
  });
});

describe("destroy()", () => {
  it("removes the toolbar and disconnects the ResizeObserver; safe to repeat", () => {
    const { toolbar, host } = mount();
    const obs = resizeObs();
    const disconnect = vi.spyOn(obs, "disconnect");
    toolbar.destroy();
    expect(host.querySelector(".pdf-viewer-toolbar")).toBeNull();
    expect(disconnect).toHaveBeenCalled();
    expect(() => toolbar.destroy()).not.toThrow();
  });
});
