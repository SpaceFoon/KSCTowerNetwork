import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __testInternals as A } from "./atis";

describe("ATIS speech helpers", () => {
  it("spellDigits: per-digit phrasing with non-digit passthrough", () => {
    assert.equal(A.spellDigits("270"), "two seven zero");
    assert.equal(A.spellDigits("00"), "zero zero");
    assert.equal(A.spellDigits("2-9"), "two - nine");
  });

  it("windDirSpeech: zero-padded to three digits", () => {
    assert.equal(A.windDirSpeech(0), "zero zero zero");
    assert.equal(A.windDirSpeech(9), "zero zero nine");
    assert.equal(A.windDirSpeech(90), "zero nine zero");
    assert.equal(A.windDirSpeech(270), "two seven zero");
  });

  it("windKtSpeech: per-digit, never empty for 0", () => {
    assert.equal(A.windKtSpeech(0), "zero");
    assert.equal(A.windKtSpeech(8), "eight");
    assert.equal(A.windKtSpeech(15), "one five");
  });

  it("runwaySpeech: per-digit, whitespace ignored", () => {
    assert.equal(A.runwaySpeech("09"), "zero nine");
    assert.equal(A.runwaySpeech(" 27 "), "two seven");
  });

  it("altimeterSpeech: 4 digits, decimal point dropped", () => {
    assert.equal(A.altimeterSpeech(29.92), "two nine nine two");
    assert.equal(A.altimeterSpeech(30.05), "three zero zero five");
  });

  it("tempSpeech: 'minus' prefix for negatives, rounding to int", () => {
    assert.equal(A.tempSpeech(15), "one five");
    assert.equal(A.tempSpeech(-3), "minus three");
    assert.equal(A.tempSpeech(0), "zero");
  });

  it("visibilitySpeech: integer + decimal point support", () => {
    assert.equal(A.visibilitySpeech(10), "one zero");
    assert.equal(A.visibilitySpeech(0.5), "zero point five");
  });

  it("zuluTimeSpeech: HHMM zulu in UTC", () => {
    const d = new Date(Date.UTC(2026, 3, 21, 13, 42, 0));
    assert.equal(A.zuluTimeSpeech(d), "one three four two zulu");
    const midnight = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    assert.equal(A.zuluTimeSpeech(midnight), "zero zero zero zero zulu");
  });
});

describe("ATIS hysteresis (materiallyChanged)", () => {
  const base = A.materialFromInputs(A.DEFAULT_WEATHER, A.DEFAULT_RUNWAY, "");

  it("identical snapshots are NOT material", () => {
    assert.equal(A.materiallyChanged(base, { ...base }), false);
  });

  it("wind direction must move >= 10 degrees", () => {
    assert.equal(A.materiallyChanged(base, { ...base, windDirDeg: base.windDirDeg + 9 }), false);
    assert.equal(A.materiallyChanged(base, { ...base, windDirDeg: base.windDirDeg + 10 }), true);
  });

  it("wind direction respects circular distance (no false positive on 359->0 wraparound)", () => {
    // 355° -> 4° is 9° on the circle, sub-threshold; 355° -> 5° is exactly 10° and trips.
    const near360 = { ...base, windDirDeg: 355 };
    assert.equal(A.materiallyChanged(near360, { ...near360, windDirDeg: 4 }), false);
    assert.equal(A.materiallyChanged(near360, { ...near360, windDirDeg: 5 }), true);
    assert.equal(A.circularDiffDeg(355, 4), 9);
    assert.equal(A.circularDiffDeg(355, 5), 10);
  });

  it("wind speed must move >= 3 kt", () => {
    assert.equal(A.materiallyChanged(base, { ...base, windKt: base.windKt + 2 }), false);
    assert.equal(A.materiallyChanged(base, { ...base, windKt: base.windKt + 3 }), true);
  });

  it("any runway change is material", () => {
    assert.equal(A.materiallyChanged(base, { ...base, runwayId: "27" }), true);
  });

  it("altimeter must move > 0.005 inHg (one significant digit)", () => {
    assert.equal(A.materiallyChanged(base, { ...base, altInHg: base.altInHg + 0.005 }), false);
    assert.equal(A.materiallyChanged(base, { ...base, altInHg: base.altInHg + 0.01 }), true);
  });

  it("any NOTAM signature change is material", () => {
    assert.equal(A.materiallyChanged(base, { ...base, notamSig: "rwy09-closed" }), true);
  });
});

describe("ATIS composeLines snapshot", () => {
  it("produces the planned template lines including notam block when present", () => {
    const lines = A.composeLines(
      A.DEFAULT_WEATHER,
      A.DEFAULT_RUNWAY,
      "Alpha",
      "Notice runway zero nine closed two zero zero zero zulu.",
      new Date(Date.UTC(2026, 3, 21, 13, 42))
    );
    assert.equal(lines[0], "KSC information Alpha. Time one three four two zulu.");
    assert.match(lines[1]!, /^Wind two seven zero at eight\./);
    assert.match(lines[2]!, /Altimeter two nine nine two\.$/);
    assert.equal(lines[3], "Notice runway zero nine closed two zero zero zero zulu.");
    assert.equal(lines.length, 4);
    assert.equal(lines.join(" ").includes("ILS approach runway"), false);
    assert.equal(lines.join(" ").includes("Advise on initial contact"), false);
  });

  it("omits the notam line entirely when block is empty/whitespace", () => {
    const lines = A.composeLines(
      A.DEFAULT_WEATHER,
      A.DEFAULT_RUNWAY,
      "Bravo",
      "   ",
      new Date(Date.UTC(2026, 3, 21, 0, 0))
    );
    assert.equal(lines.length, 3);
    assert.match(lines[2]!, /Altimeter two nine nine two\.$/);
  });

  it("roleplay mode adds modular advisory/disclaimer/closer lines", () => {
    const lines = A.composeLines(
      A.DEFAULT_WEATHER,
      A.DEFAULT_RUNWAY,
      "Charlie",
      "Runway two seven closed for rubber removal. Birds reported north of field.",
      new Date(Date.UTC(2026, 3, 21, 7, 0)),
      {
        mode: "roleplay",
        includeNotamAdvisories: true,
        maxNotamAdvisories: 2,
        includeFieldStatus: true,
        includeDisclaimer: true,
        includeCloser: true
      },
      "seed-roleplay"
    );
    assert.match(lines.join(" "), /Advisory /);
    assert.match(lines.join(" "), /Tower clearance required/);
    assert.equal(lines[lines.length - 1], "Information Charlie.");
  });

  it("roleplay toggles can disable all optional lines", () => {
    const lines = A.composeLines(
      A.DEFAULT_WEATHER,
      A.DEFAULT_RUNWAY,
      "Delta",
      "Taxiway alpha closed.",
      new Date(Date.UTC(2026, 3, 21, 7, 0)),
      {
        mode: "roleplay",
        includeNotamAdvisories: false,
        maxNotamAdvisories: 1,
        includeFieldStatus: false,
        includeDisclaimer: false,
        includeCloser: false
      },
      "seed-none"
    );
    assert.equal(lines.join(" ").includes("Advisory "), false);
    assert.equal(lines.join(" ").includes("Tower clearance required"), false);
    assert.equal(lines.join(" ").includes("Information Delta."), false);
  });
});

describe("ATIS contentHash stability", () => {
  it("identical material + letter + notam => identical hash", () => {
    const m = A.materialFromInputs(A.DEFAULT_WEATHER, "09", "");
    assert.equal(A.contentHashStable("Alpha", m, ""), A.contentHashStable("Alpha", m, ""));
  });

  it("changing letter changes the hash (cache key is keyed by letter)", () => {
    const m = A.materialFromInputs(A.DEFAULT_WEATHER, "09", "");
    assert.notEqual(A.contentHashStable("Alpha", m, ""), A.contentHashStable("Bravo", m, ""));
  });

  it("changing material changes the hash", () => {
    const a = A.materialFromInputs(A.DEFAULT_WEATHER, "09", "");
    const b = A.materialFromInputs({ ...A.DEFAULT_WEATHER, windKt: 20 }, "09", "");
    assert.notEqual(A.contentHashStable("Alpha", a, ""), A.contentHashStable("Alpha", b, ""));
  });

  it("changing notam signature changes the hash", () => {
    const m = A.materialFromInputs(A.DEFAULT_WEATHER, "09", "");
    assert.notEqual(A.contentHashStable("Alpha", m, ""), A.contentHashStable("Alpha", m, "x"));
  });
});

describe("ATIS NATO_LETTERS", () => {
  it("has 26 unique entries", () => {
    assert.equal(A.NATO_LETTERS.length, 26);
    assert.equal(new Set(A.NATO_LETTERS).size, 26);
  });
  it("starts at Alpha and ends at Zulu", () => {
    assert.equal(A.NATO_LETTERS[0], "Alpha");
    assert.equal(A.NATO_LETTERS[A.NATO_LETTERS.length - 1], "Zulu");
  });
});
