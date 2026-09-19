import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "../src/db.js";

// Applies db/*.sql in filename order, once each, tracked in schema_migrations.
// Each file runs inside a transaction — in Postgres, DDL is transactional, so a
// migration that fails halfway leaves no partial schema behind. (MySQL cannot do this.)

const DIR = path.join(process.cwd(), "db");

await pool.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);

const files = (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort();
const { rows } = await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations");
const applied = new Set(rows.map((r) => r.filename));

for (const file of files) {
  if (applied.has(file)) {
    console.log(`  skip   ${file}`);
    continue;
  }
  const sql = await readFile(path.join(DIR, file), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
    await client.query("COMMIT");
    console.log(`  apply  ${file}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`  FAILED ${file}`);
    throw err;
  } finally {
    client.release();
  }
}

console.log("migrations up to date");
await pool.end();
