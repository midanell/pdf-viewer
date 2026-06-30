import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLinkService } from "../src/linkService.js";

// A minimal pdf double with the three async lookups the link service uses.
function makePdf({ numPages = 5 } = {}) {
  return {
    numPages,
    getDestination: vi.fn(() => Promise.resolve(null)),
    getPageIndex: vi.fn(() => Promise.resolve(0)),
  };
}

describe("createLinkService", () => {
  let onNavigate;
  beforeEach(() => {
    onNavigate = vi.fn();
  });

  it("exposes the static link-service properties", () => {
    const ls = createLinkService(makePdf({ numPages: 7 }), { onNavigate });
    expect(ls.pagesCount).toBe(7);
    expect(ls.page).toBe(1);
    expect(ls.rotation).toBe(0);
    expect(ls.isInPresentationMode).toBe(false);
    expect(ls.externalLinkEnabled).toBe(true);
  });

  it("defaults pagesCount to 0 when no pdf is given", () => {
    expect(createLinkService(null).pagesCount).toBe(0);
    expect(createLinkService(undefined).pagesCount).toBe(0);
  });

  describe("goToDestination", () => {
    it("resolves a named (string) destination then navigates 1-based", async () => {
      const pdf = makePdf();
      pdf.getDestination.mockResolvedValue(["ref"]);
      pdf.getPageIndex.mockResolvedValue(3); // 0-based
      const ls = createLinkService(pdf, { onNavigate });

      await ls.goToDestination("chapter-2");

      expect(pdf.getDestination).toHaveBeenCalledWith("chapter-2");
      expect(pdf.getPageIndex).toHaveBeenCalledWith("ref");
      expect(onNavigate).toHaveBeenCalledWith(4); // pageIndex + 1
    });

    it("uses an explicit (array) destination without resolving a name", async () => {
      const pdf = makePdf();
      pdf.getPageIndex.mockResolvedValue(0);
      const ls = createLinkService(pdf, { onNavigate });

      await ls.goToDestination(["ref0"]);

      expect(pdf.getDestination).not.toHaveBeenCalled();
      expect(pdf.getPageIndex).toHaveBeenCalledWith("ref0");
      expect(onNavigate).toHaveBeenCalledWith(1);
    });

    it("does nothing when the destination cannot be resolved", async () => {
      const pdf = makePdf();
      pdf.getDestination.mockResolvedValue(null);
      const ls = createLinkService(pdf, { onNavigate });

      await ls.goToDestination("missing");

      expect(pdf.getPageIndex).not.toHaveBeenCalled();
      expect(onNavigate).not.toHaveBeenCalled();
    });
  });

  it("goToPage forwards the value straight to onNavigate", () => {
    const ls = createLinkService(makePdf(), { onNavigate });
    ls.goToPage(4);
    expect(onNavigate).toHaveBeenCalledWith(4);
  });

  it("does not throw when onNavigate is omitted", async () => {
    const pdf = makePdf();
    pdf.getDestination.mockResolvedValue(["ref"]);
    const ls = createLinkService(pdf);
    await expect(ls.goToDestination("x")).resolves.toBeUndefined();
    expect(() => ls.goToPage(2)).not.toThrow();
  });

  describe("addLinkAttributes", () => {
    it("opens external links in a new tab with a safe rel", () => {
      const ls = createLinkService(makePdf());
      const a = document.createElement("a");
      ls.addLinkAttributes(a, "https://example.com", true);
      expect(a.getAttribute("href")).toBe("https://example.com");
      expect(a.target).toBe("_blank");
      expect(a.rel).toBe("noopener noreferrer");
    });

    it("keeps same-window links in _self", () => {
      const ls = createLinkService(makePdf());
      const a = document.createElement("a");
      ls.addLinkAttributes(a, "https://example.com", false);
      expect(a.target).toBe("_self");
    });
  });

  it("returns hash/anchor helpers and exposes no-op actions", () => {
    const ls = createLinkService(makePdf());
    expect(ls.getDestinationHash()).toBe("#");
    expect(ls.getAnchorUrl("foo")).toBe("#foo");
    expect(() => ls.setHash("x")).not.toThrow();
    expect(() => ls.executeNamedAction("Next")).not.toThrow();
    expect(() => ls.executeSetOCGState({})).not.toThrow();
  });
});
