import { pool } from "../src/db.js";

// Idempotent seed: a handful of rooms to book against. Safe to run repeatedly.
const rooms = [
  ["Conference Room A", "room"],
  ["Conference Room B", "room"],
  ["Focus Pod 1", "desk"],
];

for (const [name, type] of rooms) {
  await pool.query(
    `INSERT INTO resources (name, type)
     SELECT $1, $2
     WHERE NOT EXISTS (SELECT 1 FROM resources WHERE name = $1)`,
    [name, type],
  );
}

const { rows } = await pool.query("SELECT id, name, type FROM resources ORDER BY name");
console.table(rows);
await pool.end();
