export const LIVE_UDP_PROTOCOL_VERSION = 1;

export type LiveUdpMessageType =
  | "telemetry.sample"
  | "telemetry.status"
  | "ghost.query"
  | "reply.ok"
  | "reply.error";

const TYPE_TO_CODE: Record<LiveUdpMessageType, number> = {
  "telemetry.sample": 1,
  "telemetry.status": 2,
  "ghost.query": 3,
  "reply.ok": 100,
  "reply.error": 101
};

const CODE_TO_TYPE: Record<number, LiveUdpMessageType> = Object.entries(TYPE_TO_CODE).reduce(
  (acc, [k, v]) => {
    acc[v] = k as LiveUdpMessageType;
    return acc;
  },
  {} as Record<number, LiveUdpMessageType>
);

type LiveUdpPacket = {
  version: number;
  type: LiveUdpMessageType;
  flags: number;
  sequence: number;
  timestampMs: number;
  sessionId: string;
  token: string;
  payload: Buffer;
};

const HEADER_BYTES = 1 + 1 + 1 + 4 + 8 + 2 + 2 + 2;

function writeU32(buf: Buffer, off: number, v: number): void {
  buf.writeUInt32BE(v >>> 0, off);
}

function writeU64(buf: Buffer, off: number, v: number): void {
  buf.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(v))), off);
}

function readU64(buf: Buffer, off: number): number {
  return Number(buf.readBigUInt64BE(off));
}

export function encodeLiveUdpPacket(packet: LiveUdpPacket): Buffer {
  const sessionBytes = Buffer.from(packet.sessionId ?? "", "utf8");
  const tokenBytes = Buffer.from(packet.token ?? "", "utf8");
  const payloadBytes = packet.payload ?? Buffer.alloc(0);
  if (sessionBytes.length > 0xffff || tokenBytes.length > 0xffff || payloadBytes.length > 0xffff) {
    throw new Error("UDP frame field exceeds 65535-byte limit");
  }

  const out = Buffer.allocUnsafe(HEADER_BYTES + sessionBytes.length + tokenBytes.length + payloadBytes.length);
  let o = 0;
  out[o++] = packet.version & 0xff;
  out[o++] = TYPE_TO_CODE[packet.type] & 0xff;
  out[o++] = packet.flags & 0xff;
  writeU32(out, o, packet.sequence);
  o += 4;
  writeU64(out, o, packet.timestampMs);
  o += 8;
  out.writeUInt16BE(sessionBytes.length, o);
  o += 2;
  out.writeUInt16BE(tokenBytes.length, o);
  o += 2;
  out.writeUInt16BE(payloadBytes.length, o);
  o += 2;
  sessionBytes.copy(out, o);
  o += sessionBytes.length;
  tokenBytes.copy(out, o);
  o += tokenBytes.length;
  payloadBytes.copy(out, o);
  return out;
}

export function decodeLiveUdpPacket(frame: Buffer): LiveUdpPacket {
  if (!Buffer.isBuffer(frame) || frame.length < HEADER_BYTES) {
    throw new Error("Frame too short");
  }
  let o = 0;
  const version = frame.readUInt8(o++);
  const typeCode = frame.readUInt8(o++);
  const type = CODE_TO_TYPE[typeCode];
  if (!type) throw new Error(`Unknown message type code: ${typeCode}`);
  const flags = frame.readUInt8(o++);
  const sequence = frame.readUInt32BE(o);
  o += 4;
  const timestampMs = readU64(frame, o);
  o += 8;
  const sessionLen = frame.readUInt16BE(o);
  o += 2;
  const tokenLen = frame.readUInt16BE(o);
  o += 2;
  const payloadLen = frame.readUInt16BE(o);
  o += 2;
  const expected = HEADER_BYTES + sessionLen + tokenLen + payloadLen;
  if (frame.length < expected) {
    throw new Error("Frame truncated");
  }
  const sessionId = frame.subarray(o, o + sessionLen).toString("utf8");
  o += sessionLen;
  const token = frame.subarray(o, o + tokenLen).toString("utf8");
  o += tokenLen;
  const payload = frame.subarray(o, o + payloadLen);
  return { version, type, flags, sequence, timestampMs, sessionId, token, payload };
}

export function encodeLiveUdpJson(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload ?? {}), "utf8");
}

export function decodeLiveUdpJson<T>(payload: Buffer): T {
  if (!payload || payload.length === 0) {
    return {} as T;
  }
  return JSON.parse(payload.toString("utf8")) as T;
}
