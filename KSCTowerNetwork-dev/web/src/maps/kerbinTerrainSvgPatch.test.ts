import { assert, describe, it } from "vitest";
import {
  KERBIN_MAP_VB_H,
  KERBIN_MAP_VB_W,
  patchKerbinTerrainSvgRoot
} from "./kerbinTerrainSvgPatch";

describe("patchKerbinTerrainSvgRoot", () => {
  it("remaps legacy cropped-plate root viewBox to overlay coordinates and preserves aspect", () => {
    const input =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="50 106.5 702.25 351.5" preserveAspectRatio="none"><path d="M0 0"/></svg>';
    const out = patchKerbinTerrainSvgRoot(input);
    assert.match(out, new RegExp(`viewBox="0 0 ${KERBIN_MAP_VB_W} ${KERBIN_MAP_VB_H}"`));
    assert.match(out, /<g\s+transform="matrix\(/);
    assert.ok(out.includes("</g></svg>"));
    assert.ok(out.includes('preserveAspectRatio="xMidYMid meet"'));
  });

  it("strips XML declaration before other fixes (safe for innerHTML)", () => {
    const input =
      '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 596 298" preserveAspectRatio="none"></svg>';
    const out = patchKerbinTerrainSvgRoot(input);
    assert.ok(!out.includes("<?xml"));
    assert.ok(out.trimStart().startsWith("<svg"));
  });

  it("leaves already-aligned SVGs unchanged except preserveAspectRatio", () => {
    const input = `<svg viewBox="0 0 ${KERBIN_MAP_VB_W} ${KERBIN_MAP_VB_H}" preserveAspectRatio="none"></svg>`;
    const out = patchKerbinTerrainSvgRoot(input);
    assert.ok(out.includes(`viewBox="0 0 ${KERBIN_MAP_VB_W} ${KERBIN_MAP_VB_H}"`));
    assert.ok(!out.includes("transform="));
    assert.ok(out.includes('preserveAspectRatio="xMidYMid meet"'));
  });
});
