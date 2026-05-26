export function createLinkService(pdf) {
  return {
    pagesCount: pdf?.numPages ?? 0,
    page: 1,
    rotation: 0,
    isInPresentationMode: false,
    externalLinkEnabled: true,

    // TODO: wire to scrolling when multi-page lands
    async goToDestination(_dest) {},
    goToPage(_val) {},

    addLinkAttributes(link, url, newWindow) {
      link.href = url;
      link.target = newWindow ? "_blank" : "_self";
      link.rel = "noopener noreferrer";
    },
    getDestinationHash(_dest) { return "#"; },
    getAnchorUrl(hash) { return "#" + hash; },
    setHash(_hash) {},
    executeNamedAction(_action) {},
    executeSetOCGState(_action) {},
  };
}
