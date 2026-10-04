import assert from "node:assert/strict";
import test from "node:test";

import {
  isLivekitTokenSessionNotFoundError,
  isParticipantAlreadyExistsJoinError
} from "../src/livekitTokenErrors.js";

test("detects backend 404 session-not-found livekit-token errors", () => {
  assert.equal(
    isLivekitTokenSessionNotFoundError('livekit-token HTTP 404: {"error":"Session not found"}'),
    true
  );
  assert.equal(
    isLivekitTokenSessionNotFoundError('livekit-token HTTP 404: {"error":"session not found"}'),
    true
  );
});

test("does not treat generic 404 as session missing", () => {
  assert.equal(isLivekitTokenSessionNotFoundError("livekit-token HTTP 404: {}"), false);
});

test("does not treat session message without 404", () => {
  assert.equal(isLivekitTokenSessionNotFoundError("Session not found"), false);
});

test("detects LiveKit join Participant already exists (bridge retry path)", () => {
  assert.equal(isParticipantAlreadyExistsJoinError(new Error("Participant already exists")), true);
  assert.equal(isParticipantAlreadyExistsJoinError(new Error("foo already exists bar")), true);
  assert.equal(isParticipantAlreadyExistsJoinError(new Error("connection timeout")), false);
});
