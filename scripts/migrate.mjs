import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : undefined });
await client.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtext('modernize-ai-schema-migrations'))");
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = (await readdir(path.resolve("database"))).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const applied = await client.query("SELECT 1 FROM schema_migrations WHERE name=$1", [file]);
    if (applied.rowCount) continue;
    const sql = await readFile(path.resolve("database", file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`Applied ${file}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('modernize-ai-schema-migrations'))").catch(() => undefined);
  await client.end();
}