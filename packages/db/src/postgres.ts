import { Pool } from "pg";

let _pool: Pool | null = null;

export function initPool(connectionString: string): Pool {
  _pool = new Pool({ connectionString, max: 20, idleTimeoutMillis: 30000 });
  return _pool;
}

export function getPool(): Pool {
  if (!_pool) throw new Error("Database pool not initialized — call initPool() first");
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
