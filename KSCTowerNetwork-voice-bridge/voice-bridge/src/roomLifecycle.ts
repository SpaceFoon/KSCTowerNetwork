import type { Room } from "@livekit/rtc-node";

export async function disconnectRoomPreservingHandlers(room: Room): Promise<void> {
  // The SDK clears room listeners on disconnect, but the bridge reuses the room.
  const subscribed = room.listeners("trackSubscribed");
  const unsubscribed = room.listeners("trackUnsubscribed");
  const disconnected = room.listeners("disconnected");
  try {
    await room.disconnect();
  } finally {
    for (const handler of subscribed) {
      room.off("trackSubscribed", handler);
      room.on("trackSubscribed", handler);
    }
    for (const handler of unsubscribed) {
      room.off("trackUnsubscribed", handler);
      room.on("trackUnsubscribed", handler);
    }
    for (const handler of disconnected) {
      room.off("disconnected", handler);
      room.on("disconnected", handler);
    }
  }
}
