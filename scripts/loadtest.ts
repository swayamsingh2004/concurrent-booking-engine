import http from "node:http";
import { randomUUID } from "node:crypto";
import { pool } from "../src/db.js";

/**
 * Concurrency proof.
 *
 * Fires N simultaneous booking requests at ONE slot and asserts that exactly one wins.
 * This is a correctness test, not a throughput benchmark -- autocannon/k6 measure
 * requests-per-second, but neither can check "did the database end up with exactly one row".
 *
 * Run the API with the sweeper off and logging quiet so neither pollutes the numbers:
 *   RUN_SWEEPER=false LOG_LEVEL=warn npm run dev
 *   npm run loadtest
 */

const N = Number(process.env.CONCURRENCY ?? 500);
const HOST = process.env.TARGET_HOST ?? "127.0.0.1";
const PORT = Number(process.env.TARGET_PORT ?? 3000);

// Node's default agent caps sockets per host. Without raising it, a Promise.all of 500
// requests would trickle out in batches and we would not be testing concurrency at all.
const agent = new http.Agent({ keepAlive: true, maxSockets: N, maxFreeSockets: N });

type Result = { status: number; ms: number; body: string };

function post(path: string, payload: unknown): Promise<Result> {
  const data = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path,
        method: "POST",
        agent,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            ms: Number(process.hrtime.bigint() - started) / 1e6,
            body,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

// ---------------------------------------------------------------------------------------

const { rows: resources } = await pool.query<{ id: string; name: string }>(
  "SELECT id, name FROM resources ORDER BY name LIMIT 1",
);
const resource = resources[0];
if (!resource) {
  console.error("No resources. Run `npm run seed` first.");
  process.exit(1);
}

// A slot far in the future so it cannot collide with anything left over.
const startAt = "2030-01-01T09:00:00Z";
const endAt = "2030-01-01T10:00:00Z";

await pool.query("DELETE FROM bookings WHERE start_at = $1", [startAt]);

// Warm up on a DIFFERENT slot: the first request pays for TCP setup, JIT and pool
// initialisation, which would otherwise show up as a fake p99 spike.
for (let i = 0; i < 10; i++) {
  await post("/bookings", {
    resource_id: resource.id,
    user_id: randomUUID(),
    start_at: "2030-01-02T09:00:00Z",
    end_at: "2030-01-02T10:00:00Z",
  });
}
await pool.query("DELETE FROM bookings WHERE start_at = $1", ["2030-01-02T09:00:00Z"]);

console.log(`\n  ${N} concurrent requests -> "${resource.name}", ${startAt} - ${endAt}\n`);

// Build every request object first, THEN release them, so setup cost is not staggered
// across the burst.
const fire = Array.from({ length: N }, () =>
  post("/bookings", {
    resource_id: resource.id,
    user_id: randomUUID(),
    start_at: startAt,
    end_at: endAt,
  }),
);

const wallStart = process.hrtime.bigint();
const settled = await Promise.allSettled(fire);
const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;

const byStatus = new Map<string, number>();
const latencies: number[] = [];

for (const s of settled) {
  if (s.status === "fulfilled") {
    byStatus.set(String(s.value.status), (byStatus.get(String(s.value.status)) ?? 0) + 1);
    latencies.push(s.value.ms);
  } else {
    byStatus.set("network error", (byStatus.get("network error") ?? 0) + 1);
  }
}
latencies.sort((a, b) => a - b);

const LABELS: Record<string, string> = {
  "201": "201 Created      booking won",
  "409": "409 Conflict     slot already taken",
  "400": "400 Bad Request  MALFORMED - should not happen",
  "500": "500 Server Error SHOULD NOT HAPPEN",
};

console.log("  outcomes");
for (const [status, count] of [...byStatus.entries()].sort()) {
  console.log(`    ${(LABELS[status] ?? status).padEnd(40)} ${String(count).padStart(5)}`);
}

console.log("\n  latency (ms)");
for (const p of [50, 90, 95, 99] as const) {
  console.log(`    p${String(p).padEnd(38)} ${percentile(latencies, p).toFixed(1).padStart(8)}`);
}
console.log(`    ${"max".padEnd(39)} ${(latencies.at(-1) ?? 0).toFixed(1).padStart(8)}`);
console.log(`    ${"wall clock for the whole burst".padEnd(39)} ${wallMs.toFixed(1).padStart(8)}`);
console.log(`    ${"throughput (req/s)".padEnd(39)} ${((N / wallMs) * 1000).toFixed(0).padStart(8)}`);

// The actual assertion. HTTP responses are what the API CLAIMS happened; this is what the
// database actually holds. They must agree.
const { rows: check } = await pool.query<{ count: string }>(
  "SELECT count(*) FROM bookings WHERE start_at = $1 AND status IN ('pending','confirmed')",
  [startAt],
);
const bookingsInDb = Number(check[0]?.count ?? -1);
const created = byStatus.get("201") ?? 0;
const serverErrors = (byStatus.get("500") ?? 0) + (byStatus.get("network error") ?? 0);

console.log("\n  verification");
console.log(`    bookings actually in the database        ${String(bookingsInDb).padStart(8)}`);
console.log(`    201 responses returned                   ${String(created).padStart(8)}`);
console.log(`    5xx / network errors                     ${String(serverErrors).padStart(8)}`);

const ok = bookingsInDb === 1 && created === 1 && serverErrors === 0;
console.log(
  ok
    ? `\n  PASS - exactly one of ${N} succeeded, no double booking, no server errors\n`
    : `\n  FAIL - expected exactly 1 booking and 1x201 with no 5xx\n`,
);

await pool.query("DELETE FROM bookings WHERE start_at = $1", [startAt]);
await pool.end();
agent.destroy();
process.exit(ok ? 0 : 1);
