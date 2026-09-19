import Fastify from "fastify";
import { pool } from "./db.js";
import { bookingRoutes } from "./routes/bookings.js";
import { startSweeper } from "./sweeper.js";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    // Load testing produces thousands of lines. Set LOG_LEVEL=warn when running it.
  },
});

app.get("/health", async () => {
  const { rows } = await pool.query<{ db_time: Date }>("SELECT now() AS db_time");
  return { ok: true, db_time: rows[0]!.db_time };
});

await app.register(bookingRoutes, { prefix: "/bookings" });

// Expires abandoned pending holds and prunes stale idempotency keys.
// Coordinated across instances by a Postgres advisory lock, so running several copies of
// this process is safe -- only one sweeps at a time.
const stopSweeper = startSweeper(app.log);

// Shut down cleanly: stop the timer, close the HTTP server, drain the pool. Without this,
// a SIGTERM (a container stop, a deploy) kills in-flight requests mid-transaction.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      app.log.info({ signal }, "shutting down");
      stopSweeper();
      await app.close();
      await pool.end();
      process.exit(0);
    })();
  });
}

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
