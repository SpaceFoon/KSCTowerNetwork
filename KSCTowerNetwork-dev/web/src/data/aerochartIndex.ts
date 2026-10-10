export type AerochartPage = {
  page: number;
  file: string;
  thumb: string;
  widthPx: number;
  heightPx: number;
  title: string;
  blurb: string;
  chartTag: string | null;
  category?: string;
  text?: string;
};

export type AerochartManifest = {
  source: string;
  sourcePdf?: string;
  sourceUrl?: string;
  sourceSha256?: string;
  author?: string;
  license: string;
  licenseUrl?: string;
  publicationDate?: string;
  referenceData?: string;
  terrainVector?: string;
  pageCount: number;
  renderZoom: number;
  pages: AerochartPage[];
};

function normalize(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/[−–—]/g, "-").replace(/\s+/g, " ").trim();
}

export function filterAerochartPages(pages: readonly AerochartPage[], query: string, category = "All"): AerochartPage[] {
  const terms = normalize(query).split(" ").filter(Boolean);
  return pages.filter((page) => {
    if (category !== "All" && page.category !== category) return false;
    const text = normalize(`${page.title} ${page.chartTag ?? ""} ${page.category ?? ""} ${page.blurb} ${page.text ?? ""}`);
    return terms.every((term) => text.includes(term));
  });
}
