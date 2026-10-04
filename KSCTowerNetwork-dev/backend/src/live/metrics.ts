type CounterName =
  | "live_http_requests"
  | "udp_packets_in"
  | "udp_packets_dropped"
  | "udp_decode_errors"
  | "udp_auth_errors"
  | "udp_handler_errors"
  | "udp_replies_out"
  | "snapshot_builds"
  | "ws_messages_out";

type TimerName = "snapshot_encode_ms";

const counters: Record<CounterName, number> = {
  live_http_requests: 0,
  udp_packets_in: 0,
  udp_packets_dropped: 0,
  udp_decode_errors: 0,
  udp_auth_errors: 0,
  udp_handler_errors: 0,
  udp_replies_out: 0,
  snapshot_builds: 0,
  ws_messages_out: 0
};

const timers: Record<TimerName, { count: number; totalMs: number; maxMs: number }> = {
  snapshot_encode_ms: { count: 0, totalMs: 0, maxMs: 0 }
};

let wsSubscribers = 0;

export function incLiveMetric(name: CounterName, delta = 1): void {
  counters[name] += delta;
}

export function observeLiveMs(name: TimerName, ms: number): void {
  const t = timers[name];
  t.count += 1;
  t.totalMs += ms;
  t.maxMs = Math.max(t.maxMs, ms);
}

export function setLiveWsSubscribers(count: number): void {
  wsSubscribers = Math.max(0, count | 0);
}

export function getLiveMetricsSnapshot(): {
  counters: Record<CounterName, number>;
  timers: Record<TimerName, { count: number; avgMs: number; maxMs: number }>;
  wsSubscribers: number;
} {
  return {
    counters: { ...counters },
    timers: {
      snapshot_encode_ms: {
        count: timers.snapshot_encode_ms.count,
        avgMs:
          timers.snapshot_encode_ms.count > 0
            ? timers.snapshot_encode_ms.totalMs / timers.snapshot_encode_ms.count
            : 0,
        maxMs: timers.snapshot_encode_ms.maxMs
      }
    },
    wsSubscribers
  };
}
