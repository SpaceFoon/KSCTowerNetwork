/**
 * Mirrors `livekitTokenSchema` in `api.ts` for POST /v1/session/:id/livekit-token.
 * If the route schema drifts, update this copy and fix the mismatch.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

const livekitTokenBodySchema = z
  .object({
    flavor: z.enum(["ops", "booth", "lobby_ops"]).optional()
  })
  .optional();

test("accepts empty JSON object (legacy bridge + browsers)", () => {
  const r = livekitTokenBodySchema.safeParse({});
  assert.equal(r.success, true);
});

test("accepts explicit ops, booth, and lobby_ops flavors", () => {
  assert.equal(livekitTokenBodySchema.safeParse({ flavor: "ops" }).success, true);
  assert.equal(livekitTokenBodySchema.safeParse({ flavor: "booth" }).success, true);
  assert.equal(livekitTokenBodySchema.safeParse({ flavor: "lobby_ops" }).success, true);
});

test("rejects invalid flavor strings", () => {
  const r = livekitTokenBodySchema.safeParse({ flavor: "radio" });
  assert.equal(r.success, false);
});
