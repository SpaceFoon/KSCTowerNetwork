import pino from "pino";
// Loaded sync via require so the dev (pretty) branch can attach pino-pretty as
// a regular stream — the worker-thread `transport` API would route logs through
// a separate process where we can't observe the JSON for the admin tail buffer.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pinoPretty = require("pino-pretty") as (opts?: Record<string, unknown>) => NodeJS.WritableStream;

import { serverLogStream } from "./serverLogBuffer";

const level = process.env.LOG_LEVEL ?? "info";

/**
 * `pino.multistream` lets one logger fan out to several destinations. We always
 * push raw NDJSON into the in-memory ring buffer so the admin SPA can tail
 * recent backend logs (`GET /v1/admin/server-logs`) regardless of how stdout
 * is decorated. In dev we additionally pipe the same JSON through pino-pretty
 * for a colorized stdout; in prod we leave stdout as raw NDJSON for log shipping.
 */
const streams: pino.StreamEntry[] = [
  { level: "trace", stream: serverLogStream }
];

if (process.env.NODE_ENV !== "production") {
  streams.push({
    level: "trace",
    stream: pinoPretty({
      colorize: true,
      translateTime: "SYS:standard",
      // The default pretty output dumps every structured field on its own line beneath
      // the message — for pino-http access logs that means 7 lines per request (req,
      // res, responseTime, …). `singleLine` collapses any leftover fields onto the msg
      // line, and `ignore` drops fields whose contents are already encoded in the
      // customSuccessMessage so the line stays short and scannable.
      singleLine: true,
      ignore: "pid,hostname,req,res,responseTime,reqId,responseSize,reqBytes"
    })
  });
} else {
  streams.push({ level: "trace", stream: process.stdout });
}

/**
 * Hot HTTP paths are omitted in `index.ts`; use `LOG_LEVEL=warn` for quieter stdout.
 * The admin tail buffer always receives every level the logger itself accepts.
 */
export const logger = pino({ level }, pino.multistream(streams));
