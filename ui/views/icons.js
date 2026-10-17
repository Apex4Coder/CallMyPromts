// Small geometric line icons; no font glyph or external network dependency.
const PATHS = {
  grid: "M3 3h5v5H3z M12 3h5v5h-5z M3 12h5v5H3z M12 12h5v5h-5z",
  pin: "M12 2l6 6-3 1-3 5-2-2-5 5-1-1 5-5-2-2 5-3z",
  clock: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M10 6v4l3 2",
  folder: "M2 6h6l2 2h8v9H2z",
  settings: "M3 5h14 M3 10h14 M3 15h14 M7 3v4 M13 8v4 M8 13v4",
  pulse: "M2 11h4l2-6 4 11 2-5h4",
  help: "M7 7a3 3 0 1 1 5 2l-2 2v1 M10 15v1",
  search: "M9 3a6 6 0 1 0 0 12 6 6 0 0 0 0-12 M13 13l5 5",
};
export const icon = (name) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("line-icon");
  const p = document.createElementNS(svg.namespaceURI, "path");
  p.setAttribute("d", PATHS[name] || PATHS.grid);
  svg.append(p);
  return svg;
};
