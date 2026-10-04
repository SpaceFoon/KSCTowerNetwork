import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UnsafeSvgError, sanitizeSvgBytes, worldMapsSchema } from "./worldMaps";

/** 1×1 PNG — satisfies `bytesBase64` min length and base64 regex. */
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("sanitizeSvgBytes", () => {
  it("accepts a minimal inline SVG without forbidden content", () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>',
      "utf8"
    );
    const out = sanitizeSvgBytes(svg);
    assert.ok(out.length > 0);
    assert.match(out.toString("utf8"), /<svg/i);
  });

  it("rejects script injection", () => {
    const bad = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      "utf8"
    );
    assert.throws(() => sanitizeSvgBytes(bad), UnsafeSvgError);
  });
});

describe("worldMapsSchema", () => {
  const base = {
    schemaVersion: "3",
    scannedAt: 0,
    body: { name: "Kerbin", displayName: "Kerbin", radiusM: 600_000 },
    layers: [
      {
        id: "alt" as const,
        label: "Alt",
        contentType: "image/png" as const,
        viewBoxW: 1,
        viewBoxH: 1,
        bytesBase64: TINY_PNG_B64
      }
    ]
  };

  it("parses a minimal valid payload", () => {
    const parsed = worldMapsSchema.parse(base);
    assert.equal(parsed.layers.length, 1);
    assert.equal(parsed.layers[0]?.id, "alt");
  });

  it("rejects duplicate layer ids", () => {
    const dup = {
      ...base,
      layers: [
        { ...base.layers[0], id: "alt" as const, label: "A" },
        {
          ...base.layers[0],
          id: "alt" as const,
          label: "B",
          bytesBase64: TINY_PNG_B64
        }
      ]
    };
    assert.throws(() => worldMapsSchema.parse(dup), /Duplicate world-maps layer id/);
  });
});
