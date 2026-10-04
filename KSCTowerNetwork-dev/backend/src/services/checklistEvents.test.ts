/**
 * In-process checklist SSE fan-out — must not throw on bad listeners.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emitChecklistEvent, subscribeChecklistEvents, type ChecklistEvent } from "./checklistEvents";

describe("subscribeChecklistEvents / emitChecklistEvent", () => {
  it("delivers events to subscribers for the matching session", () => {
    const received: ChecklistEvent[] = [];
    const unsub = subscribeChecklistEvents("sess-a", (e) => received.push(e));
    const ev: ChecklistEvent = {
      kind: "state",
      sessionId: "sess-a",
      at: new Date().toISOString()
    };
    emitChecklistEvent(ev);
    assert.equal(received.length, 1);
    assert.equal(received[0]!.kind, "state");
    unsub();
  });

  it("does not cross-notify other session ids", () => {
    const received: ChecklistEvent[] = [];
    const unsub = subscribeChecklistEvents("sess-b", (e) => received.push(e));
    emitChecklistEvent({
      kind: "ack",
      sessionId: "sess-c",
      at: "t"
    });
    assert.equal(received.length, 0);
    unsub();
  });

  it("unsubscribe stops further delivery", () => {
    let n = 0;
    const unsub = subscribeChecklistEvents("sess-d", () => {
      n += 1;
    });
    emitChecklistEvent({ kind: "send", sessionId: "sess-d", at: "1" });
    assert.equal(n, 1);
    unsub();
    emitChecklistEvent({ kind: "send", sessionId: "sess-d", at: "2" });
    assert.equal(n, 1);
  });

  it("survives a throwing listener without blocking others", () => {
    const ok: string[] = [];
    subscribeChecklistEvents("sess-e", () => {
      throw new Error("boom");
    });
    const unsub2 = subscribeChecklistEvents("sess-e", () => {
      ok.push("second");
    });
    emitChecklistEvent({ kind: "state", sessionId: "sess-e", at: "t" });
    assert.deepEqual(ok, ["second"]);
    unsub2();
  });
});
