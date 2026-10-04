import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeStr, stripControlChars } from "./safeText";

describe("stripControlChars", () => {
  it("removes NUL and C1 controls but keeps tab, LF, CR", () => {
    assert.equal(stripControlChars("a\u0000b"), "ab");
    assert.equal(stripControlChars("x\u007Fy"), "xy");
    assert.equal(stripControlChars("a\tb\nc\r"), "a\tb\nc\r");
  });
});

describe("safeStr", () => {
  it("strips controls then enforces max length", () => {
    const schema = safeStr(4);
    assert.equal(schema.parse("ab\u0000cd"), "abcd");
    assert.equal(schema.parse("ab\u0000cdef"), "abcd");
  });
});
