/**
 * Admin log tail buffer — ring semantics and delta polling (`sinceSeq`, `minLevel`).
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  __resetServerLogBufferForTests,
  readLogEntries,
  recordLogLine
} from "./serverLogBuffer";

beforeEach(() => {
  __resetServerLogBufferForTests();
});

describe("recordLogLine / readLogEntries", () => {
  it("parses pino JSON and assigns monotonic seq", () => {
    recordLogLine(JSON.stringify({ level: 30, time: 1_700_000_000_000, msg: "boot", name: "api" }));
    const { entries, latestSeq } = readLogEntries({ limit: 10 });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.msg, "boot");
    assert.equal(entries[0]!.level, "info");
    assert.equal(entries[0]!.seq, 1);
    assert.equal(latestSeq, 1);
  });

  it("stores non-JSON lines as raw info messages", () => {
    recordLogLine("plain text crash");
    const { entries } = readLogEntries({ limit: 5 });
    assert.equal(entries[0]!.msg, "plain text crash");
    assert.equal(entries[0]!.level, "info");
  });

  it("returns only entries with seq > sinceSeq (delta polling)", () => {
    recordLogLine(JSON.stringify({ level: 30, time: 1, msg: "a" }));
    recordLogLine(JSON.stringify({ level: 30, time: 2, msg: "b" }));
    const first = readLogEntries({ limit: 10 });
    assert.equal(first.entries.length, 2);
    const delta = readLogEntries({ limit: 10, sinceSeq: 1 });
    assert.equal(delta.entries.length, 1);
    assert.equal(delta.entries[0]!.msg, "b");
  });

  it("filters by minLevel", () => {
    recordLogLine(JSON.stringify({ level: 30, time: 1, msg: "info" }));
    recordLogLine(JSON.stringify({ level: 50, time: 2, msg: "error" }));
    const { entries } = readLogEntries({ limit: 10, minLevel: "error" });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.level, "error");
  });
});
