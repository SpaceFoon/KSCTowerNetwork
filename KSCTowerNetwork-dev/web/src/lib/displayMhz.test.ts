import { describe, expect, it } from "vitest";
import { displayMhzFromCanonical, displayMhzFromNumber } from "./displayMhz";

describe("displayMhzFromCanonical", () => {
  it("trims trailing fractional zeros but keeps two decimals for .00", () => {
    expect(displayMhzFromCanonical("122.000")).toBe("122.00");
  });

  it("keeps three decimals when the third digit is non-zero", () => {
    expect(displayMhzFromCanonical("118.025")).toBe("118.025");
  });

  it("passes through non-canonical strings", () => {
    expect(displayMhzFromCanonical("manual")).toBe("manual");
  });
});

describe("displayMhzFromNumber", () => {
  it("snaps float noise to canonical then trims", () => {
    expect(displayMhzFromNumber(122)).toBe("122.00");
    expect(displayMhzFromNumber(122.0)).toBe("122.00");
  });
});
