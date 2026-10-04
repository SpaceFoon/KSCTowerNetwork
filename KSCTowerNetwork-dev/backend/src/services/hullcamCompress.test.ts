import assert from "node:assert/strict";
import { describe, it } from "node:test";
import sharp from "sharp";
import { getOptimizedJpeg, getWebp } from "./hullcamCompress";
import type { HullCamFrame } from "./hullcamStore";

async function wideTestJpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: 2000,
      height: 1000,
      channels: 3,
      background: { r: 40, g: 50, b: 60 }
    }
  })
    .jpeg({ quality: 92 })
    .toBuffer();
}

describe("getOptimizedJpeg", () => {
  it("dedupes concurrent encodes to one buffer", async () => {
    const jpeg = await wideTestJpeg();
    const frame: HullCamFrame = { jpeg, name: "cam", updatedAtMs: Date.now() };
    const [a, b] = await Promise.all([getOptimizedJpeg(frame), getOptimizedJpeg(frame)]);
    assert.strictEqual(a, b);
    assert.strictEqual(frame.optimizedJpeg, a);
  });

  it("serves original bytes and marks failure when input is not a JPEG", async () => {
    const frame: HullCamFrame = {
      jpeg: Buffer.from("not a jpeg"),
      name: "bad",
      updatedAtMs: Date.now()
    };
    const out = await getOptimizedJpeg(frame);
    assert.ok(out.equals(frame.jpeg));
    assert.equal(frame.optimizationFailed, true);
  });
});

describe("getWebp", () => {
  it("returns WebP bytes for valid JPEG or falls back with isWebp false", async () => {
    const jpeg = await wideTestJpeg();
    const frame: HullCamFrame = { jpeg, name: "cam", updatedAtMs: Date.now() };
    const r = await getWebp(frame);
    assert.ok(r.buf.length > 0);
    assert.equal(typeof r.isWebp, "boolean");
  });
});
