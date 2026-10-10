import { describe, expect, it } from "vitest";
import { filterAerochartPages, type AerochartPage } from "./aerochartIndex";

const pages: AerochartPage[] = [
  { page: 1, file: "/charts/page_01.png", thumb: "/charts/page_01_thumb.png", widthPx: 100, heightPx: 100, title: "Example airport", blurb: "", chartTag: "X-1", category: "Aerodromes", text: "Frequency 108.50\nBattery charge" },
  { page: 2, file: "/charts/page_02.png", thumb: "/charts/page_02_thumb.png", widthPx: 100, heightPx: 100, title: "Example procedure", blurb: "", chartTag: null, category: "Approaches", text: "Missed approach — climb" },
];

describe("optional aerochart search", () => {
  it("finds installed page transcripts and combines query terms", () => {
    expect(filterAerochartPages(pages, "108.50 battery").map(p => p.page)).toEqual([1]);
    expect(filterAerochartPages(pages, "MISSED APPROACH").map(p => p.page)).toEqual([2]);
    expect(filterAerochartPages(pages, "approach - climb").map(p => p.page)).toEqual([2]);
  });
  it("combines section filters with text and handles missing bundles", () => {
    expect(filterAerochartPages(pages, "", "Aerodromes").map(p => p.page)).toEqual([1]);
    expect(filterAerochartPages(pages, "battery", "Approaches")).toEqual([]);
    expect(filterAerochartPages([], "battery")).toEqual([]);
  });
});
