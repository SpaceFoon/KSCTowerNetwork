import assert from "node:assert/strict";
import test from "node:test";
import { Room, RoomEvent } from "@livekit/rtc-node";
import { disconnectRoomPreservingHandlers } from "../src/roomLifecycle.js";

for (const mode of ["clears listeners", "no-op", "fails after clearing"] as const) {
  test(`room handlers survive repeated disconnect when SDK ${mode}`, async () => {
    const room = new Room();
    let subscribed = 0;
    let unsubscribed = 0;
    let disconnected = 0;
    room.on(RoomEvent.TrackSubscribed, () => subscribed++);
    room.on(RoomEvent.TrackUnsubscribed, () => unsubscribed++);
    room.on(RoomEvent.Disconnected, () => disconnected++);
    room.disconnect = async () => {
      if (mode === "no-op") return;
      room.removeAllListeners();
      if (mode === "fails after clearing") throw new Error("disconnect failed");
    };
    for (let cycle = 1; cycle <= 3; cycle++) {
      if (mode === "fails after clearing") {
        await assert.rejects(disconnectRoomPreservingHandlers(room), /disconnect failed/);
      } else {
        await disconnectRoomPreservingHandlers(room);
      }
      // EventEmitter dispatch needs no native tracks or connected LiveKit room.
      for (const event of [RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed, RoomEvent.Disconnected]) {
        assert.equal(room.listenerCount(event), 1);
        Reflect.apply(room.emit, room, [event]);
      }
      assert.equal(subscribed, cycle);
      assert.equal(unsubscribed, cycle);
      assert.equal(disconnected, cycle);
    }
  });
}
