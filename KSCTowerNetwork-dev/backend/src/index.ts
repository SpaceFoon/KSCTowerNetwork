import { createServer } from "node:http";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { buildHttpApp } from "./httpApp";
import { getLiveMetricsSnapshot } from "./live/metrics";
import { startUdpLiveWorker } from "./live/udpWorker";
import { startWsLiveTransport } from "./live/wsTransport";
import { startPilotIdleSessionSweep } from "./pilotIdleSessionSweep";

async function bootstrap(): Promise<void> {
  const { app, dbConnected, redisConnected } = await buildHttpApp();
  const server = createServer(app);
  const stopWsLive = startWsLiveTransport(server);
  const stopUdpLive = startUdpLiveWorker();
  const stopPilotIdleSweep = startPilotIdleSessionSweep();
  const metricsTimer = setInterval(() => {
    logger.debug({ live: getLiveMetricsSnapshot() }, "Live transport metrics");
  }, 30_000);

  server.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        nodeEnv: env.NODE_ENV,
        dbConnected,
        redisConnected,
        telemetryDefaults: {
          defaultSeconds: env.TELEMETRY_DEFAULT_SECONDS,
          closeSeconds: env.TELEMETRY_CLOSE_SECONDS,
          closeApproachAglM: env.TELEMETRY_CLOSE_AGL_M
        },
        pilotIdleCloseSeconds: env.PILOT_IDLE_CLOSE_SECONDS,
        pilotIdleSweepIntervalSeconds: env.PILOT_IDLE_SWEEP_INTERVAL_SECONDS
      },
      "KSC tower backend started"
    );
  });

  const shutdown = (): void => {
    clearInterval(metricsTimer);
    stopPilotIdleSweep();
    stopWsLive();
    stopUdpLive();
    server.close();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandledRejection");
  if (env.NODE_ENV === "production") {
    process.exit(1);
  }
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "uncaughtException");
  process.exit(1);
});

bootstrap().catch((error) => {
  logger.error({ err: error }, "Failed to start backend");
  process.exit(1);
});
