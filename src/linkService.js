// Minimal PDF.js link service adapter. PDF.js's AnnotationLayer expects a link
// service object for resolving internal destinations (bookmarks, TOC links) and
// decorating external anchor elements. This implementation routes internal
// navigation back to the viewer via the onNavigate callback and lets external
// links open normally.

export function createLinkService(pdf, { onNavigate } = {}) {
  return {
    // ── Static properties read by PDF.js ─────────────────────────────────────

    pagesCount: pdf?.numPages ?? 0,
    page: 1,
    rotation: 0,
    isInPresentationMode: false,
    externalLinkEnabled: true,

    // ── Internal navigation ───────────────────────────────────────────────────

    async goToDestination(dest) {
      const destination =
        typeof dest === "string" ? await pdf.getDestination(dest) : dest;
      if (!destination) return;
      const pageIndex = await pdf.getPageIndex(destination[0]);
      onNavigate?.(pageIndex + 1); // getPageIndex is 0-based; viewer pages are 1-based
    },

    goToPage(val) {
      onNavigate?.(val);
    },

    // ── External links ────────────────────────────────────────────────────────

    addLinkAttributes(link, url, newWindow) {
      link.href = url;
      link.target = newWindow ? "_blank" : "_self";
      link.rel = "noopener noreferrer";
    },

    // ── No-op stubs required by the PDF.js AnnotationLayer contract ──────────

    getDestinationHash() { return "#"; },
    getAnchorUrl(hash)   { return "#" + hash; },
    setHash()            {},
    executeNamedAction() {},
    executeSetOCGState() {},
  };
}
