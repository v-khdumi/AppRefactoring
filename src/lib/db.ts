import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "@/lib/env";

const globalPool = globalThis as typeof globalThis & { modernizePool?: Pool };

export function database() {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not configured.");
  globalPool.modernizePool ||= new Pool({
    connectionString: env.DATABASE_URL,
    max: 15,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: env.NODE_ENV === "production" ? { rejectUnauthorized: true } : undefined,
    application_name: "modernize-ai",
  });
  return globalPool.modernizePool;
}

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  return database().query<T>(text, values);
}

export async function transaction<T>(operation: (client: PoolClient) => Promise<T>) {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}