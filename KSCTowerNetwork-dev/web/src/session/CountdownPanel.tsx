import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthUser } from "../auth/session";
import { userHasCapability } from "../auth/session";
import { apiCall, useApiMutation } from "../query/hooks";

type Props = {
  sessionId: string;
  user: AuthUser;
  /** ISO timestamp from /session/:id (when countdown was started). */
  startsAt?: string;
  /** Configured length, in seconds. */
  lengthSec?: number;
  /** Latest pilot launch-countdown request (from session poll). */
  countdownRequest?: { at: string; byUserId: string; label?: string } | null;
  /** Latest pilot takeoff-clearance ping (planes/rovers; from session poll). */
  takeoffRequest?: { at: string; byUserId: string; label?: string } | null;
  /** Called after Start/Scrub/abort/request so the parent re-pulls the session. */
  onChanged?: () => void;
};

const DEFAULT_LENGTH = 10;
const AUDIO_PATH = "/audio/launch-countdown.mp3";
const POST_LIFTOFF_ABORT_WINDOW_MS = 60_000;

function formatRequestAge(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const sec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

/**
 * Synced launch countdown. The clock is driven entirely off the server-supplied `startsAt` so
 * every viewer (controller + pilot + spectators) sees the same remaining time without polling
 * the server for every tick. We poll the parent (`onChanged`) on edge events only.
 *
 * Audio: tries to play `/audio/launch-countdown.mp3` (drop in NASA's public-domain clip).
 * If the asset is missing or playback is blocked, we fall back to a Web Audio beep cadence
 * — descending tones once per second through T-3..T-1, then a sustained chord at T-0.
 */
export function CountdownPanel({
  sessionId,
  user,
  startsAt,
  lengthSec = DEFAULT_LENGTH,
  countdownRequest = null,
  takeoffRequest = null,
  onChanged
}: Props): JSX.Element {
  const isController = userHasCapability(user, "controller:assume");
  const canSessionChat = userHasCapability(user, "chat:session");
  const [now, setNow] = useState<number>(() => Date.now());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);
  const playedForKeyRef = useRef<string | null>(null);

  const stopCountdownAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    playedForKeyRef.current = null;
  }, []);

  // Three small TanStack mutations rather than one big one — each surfaces its
  // own pending/error state for the corresponding button without us juggling
  // a shared "which action is in flight?" enum.
  const startMutation = useApiMutation<unknown, void>({
    mutationFn: () =>
      apiCall(`/v1/session/${encodeURIComponent(sessionId)}/countdown/start`, {
        method: "POST",
        body: JSON.stringify({ seconds: DEFAULT_LENGTH })
      }),
    onSuccess: () => onChanged?.()
  });
  const requestMutation = useApiMutation<unknown, void>({
    mutationFn: () =>
      apiCall(`/v1/session/${encodeURIComponent(sessionId)}/countdown/request`, {
        method: "POST",
        body: JSON.stringify({ kind: "launch" })
      }),
    onSuccess: () => onChanged?.()
  });
  const scrubMutation = useApiMutation<unknown, void>({
    mutationFn: () =>
      apiCall(`/v1/session/${encodeURIComponent(sessionId)}/countdown/scrub`, {
        method: "POST"
      }),
    onSuccess: () => {
      stopCountdownAudio();
      onChanged?.();
    }
  });

  const postLiftoffAbortMutation = useApiMutation<unknown, void>({
    mutationFn: () =>
      apiCall(`/v1/session/${encodeURIComponent(sessionId)}/countdown/post-liftoff-abort`, {
        method: "POST"
      }),
    onSuccess: () => {
      stopCountdownAudio();
      onChanged?.();
    }
  });

  type PilotPendingBody = { target: "takeoff" | "launch"; action: "grant" | "dismiss" };
  const pilotPendingMutation = useApiMutation<{ ok?: boolean; changed?: boolean }, PilotPendingBody>({
    mutationFn: (body) =>
      apiCall(`/v1/session/${encodeURIComponent(sessionId)}/pilot-pending/handle`, {
        method: "POST",
        body: JSON.stringify(body)
      }),
    onSuccess: () => onChanged?.()
  });

  const busy =
    startMutation.isPending ||
    requestMutation.isPending ||
    scrubMutation.isPending ||
    postLiftoffAbortMutation.isPending ||
    pilotPendingMutation.isPending;
  const error =
    startMutation.error?.message ??
    requestMutation.error?.message ??
    scrubMutation.error?.message ??
    postLiftoffAbortMutation.error?.message ??
    pilotPendingMutation.error?.message ??
    null;

  useEffect(() => {
    const tickMs = startsAt ? 200 : 1000;
    const id = window.setInterval(() => setNow(Date.now()), tickMs);
    return () => window.clearInterval(id);
  }, [startsAt]);

  const startMs = startsAt ? Date.parse(startsAt) : null;
  const endMs = startMs != null ? startMs + lengthSec * 1000 : null;
  const liftoffMs = startMs != null ? startMs + lengthSec * 1000 : null;
  const postAbortDeadlineMs = liftoffMs != null ? liftoffMs + POST_LIFTOFF_ABORT_WINDOW_MS : null;
  const inPostLiftoffAbortWindow =
    canSessionChat &&
    liftoffMs != null &&
    postAbortDeadlineMs != null &&
    now >= liftoffMs &&
    now <= postAbortDeadlineMs;
  const postAbortSecondsLeft =
    postAbortDeadlineMs != null ? Math.max(0, Math.ceil((postAbortDeadlineMs - now) / 1000)) : null;

  const isRunning = startMs != null && endMs != null && now < endMs + 5000;
  const hasLaunchRequest = countdownRequest != null && !!countdownRequest.at?.trim();
  const hasTakeoffRequest = takeoffRequest != null && !!takeoffRequest.at?.trim();
  const showStartButton = isController && !isRunning && hasLaunchRequest;
  const showScrubButton = isController && isRunning;
  const remainingSec = startMs != null && endMs != null ? Math.ceil((endMs - now) / 1000) : null;
  const tMinusLabel = (() => {
    if (!isRunning || remainingSec == null) return null;
    if (remainingSec > 0) return `T-${String(remainingSec).padStart(2, "0")}`;
    if (remainingSec >= -3) return `T-00 LIFTOFF`;
    return null;
  })();

  // Beep fallback (ladder of descending pitches). Returns a cleanup that also kills any
  // timer we scheduled, so a `Scrub` mid-countdown doesn't keep beeping.
  const playBeepFallback = useCallback((seconds: number, startedAtMs: number): (() => void) => {
    const AudioCtx =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return () => {};
    const ctx = new AudioCtx();
    void ctx.resume().catch(() => {});
    const cancellers: Array<() => void> = [];
    const beep = (atSec: number, freq: number, durSec: number): void => {
      const fireMs = startedAtMs + atSec * 1000 - Date.now();
      const id = window.setTimeout(() => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durSec);
        o.connect(g).connect(ctx.destination);
        o.start();
        o.stop(ctx.currentTime + durSec + 0.05);
      }, Math.max(0, fireMs));
      cancellers.push(() => window.clearTimeout(id));
    };
    // Final 5 seconds: short beeps. T-0: long sustain.
    for (let s = Math.min(5, seconds); s >= 1; s--) {
      const atSec = seconds - s;
      beep(atSec, 440 + (5 - s) * 60, 0.18);
    }
    beep(seconds, 880, 0.9);
    return () => {
      for (const c of cancellers) c();
      void ctx.close().catch(() => {});
    };
  }, []);

  // Single-shot per (startsAt) effect: try MP3 first; on failure (404 / blocked) drop down to beeps.
  useEffect(() => {
    if (!startsAt || startMs == null) return;
    const key = `${startsAt}|${lengthSec}`;
    if (playedForKeyRef.current === key) return;
    playedForKeyRef.current = key;

    const elapsed = (Date.now() - startMs) / 1000;
    const remaining = lengthSec - elapsed;
    if (remaining < -3) return; // already past T-0 + grace; don't replay history.

    let cleanup: (() => void) | null = null;
    const audio = new Audio(AUDIO_PATH);
    audioRef.current = audio;
    audio.preload = "auto";
    // Position the audio so playback aligns with the remaining countdown. If the file is shorter
    // than `lengthSec` we just let the beep fallback below handle the leftover ticks.
    audio.currentTime = Math.max(0, elapsed);
    audio
      .play()
      .then(() => {
        cleanup = () => {
          audio.pause();
          audio.src = "";
        };
      })
      .catch(() => {
        cleanup = playBeepFallback(Math.max(1, Math.floor(remaining + 0.5)), Date.now());
      });

    return () => {
      cleanup?.();
      if (fallbackTimerRef.current != null) {
        window.clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, [startsAt, startMs, lengthSec, playBeepFallback]);

  return (
    <section className="atc-panel atc-countdown">
      <div className="atc-panel-head">
        <h3>Launch countdown</h3>
        {isController ? (
          <div className="row" style={{ gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
            {showStartButton ? (
              <button type="button" onClick={() => startMutation.mutate()} disabled={busy}>
                {`Start T-${DEFAULT_LENGTH}`}
              </button>
            ) : null}
            {showScrubButton ? (
              <button type="button" onClick={() => scrubMutation.mutate()} disabled={busy}>
                Scrub
              </button>
            ) : null}
            {!showStartButton && !showScrubButton ? (
              <span
                className="room-meta"
                title={
                  hasTakeoffRequest
                    ? "Pilot requested takeoff clearance; rocket countdown still needs a separate launch request."
                    : 'Shown after a pilot taps "Ready for countdown" in this room.'
                }
              >
                {hasTakeoffRequest
                  ? "Takeoff clearance pending — use Cleared for takeoff or Dismiss below"
                  : "Waiting for pilot launch request"}
              </span>
            ) : null}
            {isController && !isRunning && hasLaunchRequest ? (
              <button
                type="button"
                onClick={() => pilotPendingMutation.mutate({ target: "launch", action: "dismiss" })}
                disabled={busy}
                title="Removes the pilot's launch countdown request without starting a count"
              >
                Dismiss launch request
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className={"atc-countdown-clock " + (isRunning ? "running" : "idle")}>
        {tMinusLabel ?? (isRunning ? "HOLDING" : "—")}
      </div>
      <div className="atc-countdown-requests" aria-live="polite">
        {takeoffRequest ? (
          <>
            <p className="atc-countdown-request-line">
              <strong>Takeoff clearance</strong> — {takeoffRequest.label ?? "Pilot"} ·{" "}
              {formatRequestAge(takeoffRequest.at, now) || "just now"}
            </p>
            {isController && !isRunning ? (
              <div className="row" style={{ gap: "0.35rem", flexWrap: "wrap", marginTop: "0.25rem" }}>
                <button
                  type="button"
                  onClick={() => pilotPendingMutation.mutate({ target: "takeoff", action: "grant" })}
                  disabled={busy}
                  title="Clears the request and posts [CLEARANCE] Cleared for takeoff to session chat"
                >
                  Cleared for takeoff
                </button>
                <button
                  type="button"
                  onClick={() => pilotPendingMutation.mutate({ target: "takeoff", action: "dismiss" })}
                  disabled={busy}
                  title="Clears the request without a clearance line (e.g. pilot re-requests later)"
                >
                  Dismiss
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <p className="atc-countdown-request-line room-meta">No pending takeoff request</p>
        )}
        {countdownRequest ? (
          <p className="atc-countdown-request-line">
            <strong>Launch countdown</strong> — {countdownRequest.label ?? "Pilot"} ·{" "}
            {formatRequestAge(countdownRequest.at, now) || "just now"}
          </p>
        ) : (
          <p className="atc-countdown-request-line room-meta">No pending countdown request</p>
        )}
      </div>
      {inPostLiftoffAbortWindow && postAbortSecondsLeft != null ? (
        <div className="atc-countdown-range-abort row" style={{ gap: "0.5rem", alignItems: "center", marginTop: "0.35rem" }}>
          <button
            type="button"
            className="atc-range-abort-btn"
            onClick={() => postLiftoffAbortMutation.mutate()}
            disabled={busy}
            title="Clears countdown state and logs a post-liftoff abort (60s window after T-0)"
          >
            Post-liftoff abort ({postAbortSecondsLeft}s)
          </button>
          <span className="room-meta">Open to all session viewers for now (range officer role later).</span>
        </div>
      ) : null}
      {error ? <pre className="msg error">{error}</pre> : null}
      {!isController ? (
        <div className="row" style={{ gap: "0.4rem", alignItems: "center", marginTop: "0.4rem" }}>
          <button
            type="button"
            className="atc-ready-btn"
            onClick={() => requestMutation.mutate()}
            disabled={busy || isRunning}
            title="Pings the controller in chat that you're ready"
          >
            Ready for countdown
          </button>
          <span className="room-meta">Controller will start the count.</span>
        </div>
      ) : null}
    </section>
  );
}
