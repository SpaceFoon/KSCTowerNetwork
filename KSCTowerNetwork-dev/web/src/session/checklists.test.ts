import { describe, expect, it } from "vitest";
import { diffChecklistPhases, isEmptyDiff, type ChecklistPhase } from "./checklists";

function phase(
  id: string,
  title: string,
  pilot: { id: string; label: string }[],
  controller: { id: string; label: string }[]
): ChecklistPhase {
  return { id, title, pilot, controller };
}

describe("diffChecklistPhases", () => {
  it("returns empty diff for identical snapshots", () => {
    const cur = [phase("a", "A", [{ id: "1", label: "x" }], [{ id: "c1", label: "y" }])];
    expect(isEmptyDiff(diffChecklistPhases(cur, structuredClone(cur)))).toBe(true);
  });

  it("detects added and removed phases by title", () => {
    const cur = [phase("p1", "One", [], [])];
    const next = [phase("p1", "One", [], []), phase("p2", "Two", [], [])];
    const d = diffChecklistPhases(cur, next);
    expect(d.addedPhases).toContain("Two");
    const d2 = diffChecklistPhases(next, cur);
    expect(d2.removedPhases).toContain("Two");
  });

  it("detects renamed phase title", () => {
    const cur = [phase("p1", "Old", [], [])];
    const next = [phase("p1", "New", [], [])];
    const d = diffChecklistPhases(cur, next);
    expect(d.renamedPhases).toEqual([{ id: "p1", from: "Old", to: "New" }]);
  });

  it("detects added/removed/renamed items within a phase", () => {
    const cur = [
      phase(
        "p1",
        "T",
        [
          { id: "i1", label: "A" },
          { id: "i2", label: "B" }
        ],
        []
      )
    ];
    const next = [
      phase(
        "p1",
        "T",
        [
          { id: "i1", label: "A2" },
          { id: "i3", label: "C" }
        ],
        []
      )
    ];
    const d = diffChecklistPhases(cur, next);
    expect(d.addedItems.some((x) => x.label === "C")).toBe(true);
    expect(d.removedItems.some((x) => x.label === "B")).toBe(true);
    expect(d.renamedItems.some((x) => x.from === "A" && x.to === "A2")).toBe(true);
  });
});

describe("isEmptyDiff", () => {
  it("is true only when all buckets empty", () => {
    expect(
      isEmptyDiff({
        addedPhases: [],
        removedPhases: [],
        renamedPhases: [],
        addedItems: [],
        removedItems: [],
        renamedItems: []
      })
    ).toBe(true);
    expect(
      isEmptyDiff({
        addedPhases: ["x"],
        removedPhases: [],
        renamedPhases: [],
        addedItems: [],
        removedItems: [],
        renamedItems: []
      })
    ).toBe(false);
  });
});
