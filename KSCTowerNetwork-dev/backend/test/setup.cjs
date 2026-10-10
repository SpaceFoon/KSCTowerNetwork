// Load before TypeScript imports so integration fixtures stay in memory.
process.env.NODE_ENV = "test";
process.env.DEV_IN_MEMORY = "1";
process.env.APP_JWT_SECRET = "backend-test-secret-backend-test-secret";
process.env.LIVEKIT_API_KEY = "";
process.env.LIVEKIT_API_SECRET = "";
process.env.LIVEKIT_WS_URL = "";
process.env.LIVEKIT_URL = "";

if (process.env.NODE_TEST_CONTEXT) require("node:test").after(async () => {
  const { markDbUnavailable } = require("../src/lib/db.ts");
  const { markRedisUnavailable } = require("../src/lib/redis.ts");
  await markDbUnavailable(new Error("Test cleanup"));
  markRedisUnavailable(new Error("Test cleanup"));
});
