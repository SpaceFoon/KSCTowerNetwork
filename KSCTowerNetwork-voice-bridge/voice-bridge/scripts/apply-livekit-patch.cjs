"use strict";

const fs = require("node:fs");
const path = require("node:path");

const bridgeRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(
  bridgeRoot,
  "node_modules",
  "@livekit",
  "rtc-node",
  "package.json",
);

if (!fs.existsSync(packageJsonPath)) {
  throw new Error("@livekit/rtc-node is missing. Install bridge dependencies first.");
}

const livekitPackage = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
if (livekitPackage.version !== "1.1.0") {
  throw new Error(
    "The local LiveKit guard supports @livekit/rtc-node 1.1.0 only; found " +
      livekitPackage.version +
      ". Review the upstream changes before updating the pinned version.",
  );
}

function applyBlock(
  file,
  originalLines,
  replacementLines,
  marker,
  description,
  previousReplacementBlocks,
) {
  const filePath = path.join(
    bridgeRoot,
    "node_modules",
    "@livekit",
    "rtc-node",
    file,
  );
  const source = fs.readFileSync(filePath, "utf8");

  if (source.includes(marker)) {
    return false;
  }

  let original = originalLines.join("\n");
  let first = source.indexOf(original);
  if (first < 0 && previousReplacementBlocks) {
    for (const previousLines of previousReplacementBlocks) {
      const previous = previousLines.join("\n");
      const previousFirst = source.indexOf(previous);
      if (previousFirst >= 0) {
        original = previous;
        first = previousFirst;
        break;
      }
    }
  }
  const replacement = replacementLines.join("\n");
  if (first < 0 || source.indexOf(original, first + original.length) >= 0) {
    throw new Error(
      "Could not safely apply the LiveKit " +
        description +
        " guard in " +
        file +
        ". Review the upstream file before changing this script.",
    );
  }

  const updated =
    source.slice(0, first) +
    replacement +
    source.slice(first + original.length);
  fs.writeFileSync(filePath, updated);
  return true;
}

const changes = [
  applyBlock(
    "dist/room.cjs",
    [
      "        const participant = this.createRemoteParticipant(ev.value.info);",
      "        this.remoteParticipants.set(participant.identity, participant);",
    ],
    [
      "        const owned = ev.value.info;",
      "        const identity = owned.info.identity;",
      "        if (this.remoteParticipants.has(identity)) {",
      '          import_log.log.warn("RoomEvent.ParticipantConnected: duplicate identity " + identity + ", ignoring");',
      "          try {",
      "            new import_ffi_client.FfiHandle(owned.handle.id).dispose();",
      "          } catch (e) {",
      '            import_log.log.warn("RoomEvent.ParticipantConnected: failed to dispose duplicate participant handle: " + String(e));',
      "          }",
      "          return;",
      "        }",
      "        const participant = this.createRemoteParticipant(owned);",
    ],
    "RoomEvent.ParticipantConnected: failed to dispose duplicate participant handle",
    "duplicate participant",
    [
      [
        "        const owned = ev.value.info;",
        "        const identity = owned.info.identity;",
        "        if (this.remoteParticipants.has(identity)) {",
        '          import_log.log.warn("RoomEvent.ParticipantConnected: duplicate identity " + identity + ", ignoring");',
        "          return;",
        "        }",
        "        const participant = this.createRemoteParticipant(owned);",
      ],
      [
        "        const owned = ev.value.info;",
        "        const identity = owned.info.identity;",
        "        if (this.remoteParticipants.has(identity)) {",
        '          import_log.log.warn(`RoomEvent.ParticipantConnected: duplicate identity ${identity}, ignoring`);',
        "          return;",
        "        }",
        "        const participant = this.createRemoteParticipant(owned);",
      ],
    ],
  ),
  applyBlock(
    "src/room.ts",
    [
      "      const participant = this.createRemoteParticipant(ev.value.info!);",
      "      this.remoteParticipants.set(participant.identity!, participant);",
    ],
    [
      "      const owned = ev.value.info!;",
      "      const identity = owned.info!.identity!;",
      "      if (this.remoteParticipants.has(identity)) {",
      '        log.warn("RoomEvent.ParticipantConnected: duplicate identity " + identity + ", ignoring");',
      "        try {",
      "          new FfiHandle(owned.handle!.id!).dispose();",
      "        } catch (e) {",
      '          log.warn("RoomEvent.ParticipantConnected: failed to dispose duplicate participant handle: " + String(e));',
      "        }",
      "        return;",
      "      }",
      "      const participant = this.createRemoteParticipant(owned);",
    ],
    "RoomEvent.ParticipantConnected: failed to dispose duplicate participant handle",
    "duplicate participant source",
    [
      [
        "      const owned = ev.value.info!;",
        "      const identity = owned.info!.identity!;",
        "      if (this.remoteParticipants.has(identity)) {",
        '        log.warn("RoomEvent.ParticipantConnected: duplicate identity " + identity + ", ignoring");',
        "        return;",
        "      }",
        "      const participant = this.createRemoteParticipant(owned);",
      ],
      [
        "      const owned = ev.value.info!;",
        "      const identity = owned.info!.identity!;",
        "      if (this.remoteParticipants.has(identity)) {",
        '        log.warn(`RoomEvent.ParticipantConnected: duplicate identity ${identity}, ignoring`);',
        "        return;",
        "      }",
        "      const participant = this.createRemoteParticipant(owned);",
      ],
    ],
  ),
  applyBlock(
    "dist/room.cjs",
    [
      "            new import_ffi_client.FfiHandle(dataPacket.value.data.handle.id).dispose();",
    ],
    [
      "            try {",
      "              new import_ffi_client.FfiHandle(dataPacket.value.data.handle.id).dispose();",
      "            } catch (e) {",
      '              import_log.log.warn("RoomEvent.DataPacketReceived: failed to dispose user data handle: " + String(e));',
      "            }",
    ],
    "failed to dispose user data handle",
    "data handle",
  ),
  applyBlock(
    "src/room.ts",
    [
      "          new FfiHandle(dataPacket.value.data!.handle!.id!).dispose();",
    ],
    [
      "          try {",
      "            new FfiHandle(dataPacket.value.data!.handle!.id!).dispose();",
      "          } catch (e) {",
      '            log.warn("RoomEvent.DataPacketReceived: failed to dispose user data handle: " + String(e));',
      "          }",
    ],
    "failed to dispose user data handle",
    "data handle source",
  ),
];

if (changes.some(Boolean)) {
  console.log("Applied local guards to @livekit/rtc-node 1.1.0.");
} else {
  console.log("@livekit/rtc-node 1.1.0 already has the local guards.");
}
