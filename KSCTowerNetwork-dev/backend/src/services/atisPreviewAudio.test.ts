import assert from "node:assert/strict";
import test from "node:test";
import { renderAtisPreviewAudio } from "./atisPreviewAudio";

test("renderAtisPreviewAudio returns null for empty text", async () => {
  assert.equal(await renderAtisPreviewAudio(""), null);
  assert.equal(await renderAtisPreviewAudio("   \n\t"), null);
});
