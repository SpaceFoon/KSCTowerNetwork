import { describe, it, expect } from "vitest";
import { ApiError, describeQueryError } from "./hooks";

describe("describeQueryError", () => {
  it("maps unreachable ApiError to a fixed user string", () => {
    const err = new ApiError(0, "fetch failed", null);
    expect(err.unreachable).toBe(true);
    expect(describeQueryError(err)).toMatch(/Cannot reach the tower API/);
  });

  it("passes through ApiError message for HTTP errors", () => {
    const err = new ApiError(404, "Not found", {});
    expect(describeQueryError(err)).toBe("Not found");
  });

  it("falls back to Error.message or String", () => {
    expect(describeQueryError(new Error("oops"))).toBe("oops");
    expect(describeQueryError("plain")).toBe("plain");
  });
});
