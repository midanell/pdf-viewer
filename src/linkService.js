export function createLinkService(pdf, { onNavigate } = {}) {
  return {
    pagesCount: pdf?.numPages ?? 0,
    page: 1,
    rotation: 0,
    isInPresentationMode: false,
    externalLinkEnabled: true,

    async goToDestination(dest) {
      const destination =
        typeof dest === "string" ? await pdf.getDestination(dest) : dest;
      if (!destination) return;
      const pageIndex = await pdf.getPageIndex(destination[0]);
      onNavigate?.(pageIndex + 1);
    },
    goToPage(val) {
      onNavigate?.(val);
    },

    addLinkAttributes(link, url, newWindow) {
      link.href = url;
      link.target = newWindow ? "_blank" : "_self";
      link.rel = "noopener noreferrer";
    },
    getDestinationHash() {
      return "#";
    },
    getAnchorUrl(hash) {
      return "#" + hash;
    },
    setHash() {},
    executeNamedAction() {},
    executeSetOCGState() {},
  };
}
