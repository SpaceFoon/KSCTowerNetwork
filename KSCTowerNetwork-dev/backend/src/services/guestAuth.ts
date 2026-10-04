import { randomBytes, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { registerOrTouchGuest, type GuestRecord } from "./repository";

const GUEST_TOKEN_TYPE = "guest";
/** Guest JWTs are short-lived; reconnect = new guest_id. Keeps the cleanup story simple. */
const GUEST_TOKEN_TTL_SECONDS = 60 * 60 * 12;
/** ~16M handles before any retry; collision retries below cap us at 5 attempts per request. */
const GUEST_HANDLE_BYTES = 3;

function generateGuestHandle(): string {
  return `Guest_${randomBytes(GUEST_HANDLE_BYTES).toString("hex")}`;
}

export interface IssuedGuestToken {
  token: string;
  guest: GuestRecord;
  expiresInSeconds: number;
}

export async function createGuestSession(ip: string): Promise<IssuedGuestToken> {
  const guestId = `guest_${randomUUID().replace(/-/g, "")}`;
  const displayName = generateGuestHandle();
  const guest = await registerOrTouchGuest(guestId, ip, displayName);

  const token = jwt.sign(
    {
      token_type: GUEST_TOKEN_TYPE,
      display_name: guest.displayName,
      ip
    },
    env.APP_JWT_SECRET,
    {
      subject: guest.id,
      expiresIn: GUEST_TOKEN_TTL_SECONDS
    }
  );

  return { token, guest, expiresInSeconds: GUEST_TOKEN_TTL_SECONDS };
}
