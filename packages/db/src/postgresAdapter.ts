import * as fs from "fs";
import * as path from "path";
import { Pool, PoolClient } from "pg";
import type { StorageAdapter } from "@kery/engine";
import { decryptConfigJson } from "./crypto.js";

const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || path.join(process.cwd(), "data", "screenshots");

/** Queryable — either the Pool or a PoolClient (transaction) */
type Queryable = Pool | PoolClient;

export class PostgresAdapter implements StorageAdapter {
  constructor(private pool: Pool, private client?: Queryable) {}

  /** Get the active queryable (transaction client or pool) */
  private get db(): Queryable {
    return this.client ?? this.pool;
  }

  async withTransaction<T>(fn: (txStorage: StorageAdapter) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const txAdapter = new PostgresAdapter(this.pool, client);
      const result = await fn(txAdapter);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  getPool(): Pool {
    return this.pool;
  }

  // ─── Memory ─────────────────────────────────────────────────────────────────

  async loadProjectMemory(projectId: string) {
    const { rows } = await this.db.query(
      `SELECT * FROM memory_entries WHERE scope = 'project' AND project_id = $1 ORDER BY confidence DESC LIMIT 50`,
      [projectId],
    );
    return rows;
  }

  async saveProjectMemoryEntries(projectId: string, entries: any[]) {
    if (entries.length === 0) return;
    const values: any[] = [];
    const placeholders: string[] = [];
    let idx = 1;
    for (const e of entries) {
      placeholders.push(`('project', $${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5}, $${idx+6})`);
      values.push(projectId, e.type, e.summary, e.content, e.region ? JSON.stringify(e.region) : null, e.source ?? "agent", e.confidence ?? 50);
      idx += 7;
    }
    await this.db.query(
      `INSERT INTO memory_entries (scope, project_id, type, summary, content, region, source, confidence) VALUES ${placeholders.join(", ")}`,
      values,
    );
  }

  async boostConfidence(ids: string[], amount = 5) {
    if (ids.length === 0) return;
    await this.db.query(
      `UPDATE memory_entries SET confidence = LEAST(100, confidence + $1), updated_at = now() WHERE id = ANY($2)`,
      [amount, ids],
    );
  }

  async deleteMemoryEntries(ids: string[]) {
    if (ids.length === 0) return;
    await this.db.query(`DELETE FROM memory_entries WHERE id = ANY($1)`, [ids]);
  }

  async updateMemoryEntry(
    id: string,
    data: { summary?: string; content?: string; confidence?: number },
  ) {
    const parts: string[] = [];
    const vals: unknown[] = [];
    let n = 1;
    if (data.summary !== undefined) {
      parts.push(`summary = $${n++}`);
      vals.push(data.summary);
    }
    if (data.content !== undefined) {
      parts.push(`content = $${n++}`);
      vals.push(data.content);
    }
    if (data.confidence !== undefined) {
      parts.push(`confidence = $${n++}`);
      vals.push(data.confidence);
    }
    if (parts.length === 0) return;
    parts.push("updated_at = now()");
    vals.push(id);
    await this.db.query(
      `UPDATE memory_entries SET ${parts.join(", ")} WHERE id = $${n}`,
      vals,
    );
  }

  // ─── Bugs ───────────────────────────────────────────────────────────────────

  async persistBugsFromRun(projectId: string, runId: string, runLabel: string | null, reportedAt: string, environmentId: string | null, environmentName: string | null, enrichedBugs: any[]) {
    let inserted = 0;
    let skipped = 0;
    const insertedBugs: Array<{ id: string; screenshotPath: string | null }> = [];
    for (const bug of enrichedBugs) {
      // Simple dedup: same name + url + category within project
      const { rows: existing } = await this.db.query(
        `SELECT id FROM bugs WHERE project_id = $1 AND name = $2 AND url IS NOT DISTINCT FROM $3 AND category = $4 LIMIT 1`,
        [projectId, bug.name, bug.url, bug.category],
      );
      if (existing.length > 0) {
        await this.db.query(
          `UPDATE bugs SET occurrence_count = occurrence_count + 1 WHERE id = $1`,
          [existing[0].id],
        );
        skipped++;
        continue;
      }

      const { rows: [newBug] } = await this.db.query(
        `INSERT INTO bugs (project_id, run_id, environment_id, name, description, category, severity, status, url, run_label, reported_at, environment, step_index, screenshot_path, region) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [projectId, runId, environmentId, bug.name, bug.description, bug.category, bug.severity, bug.status ?? "open", bug.url, runLabel, reportedAt, environmentName, bug.index ?? null, bug.screenshotPath ?? null, bug.region ?? null],
      );
      insertedBugs.push({ id: newBug.id, screenshotPath: bug.screenshotPath ?? null });
      inserted++;
    }
    return { inserted, skipped, insertedBugs };
  }

  async updateBugScreenshotPath(bugId: string, newPath: string): Promise<void> {
    await this.db.query(`UPDATE bugs SET screenshot_path = $1 WHERE id = $2`, [newPath, bugId]);
  }

  async listBugs(projectId: string) {
    const { rows } = await this.db.query(
      `SELECT b.id, b.project_id, b.run_id, b.environment_id, b.name, b.description, b.category, b.severity, b.status, b.url, b.run_label, b.reported_at, b.environment, b.step_index, b.created_at, b.screenshot_path, b.region, b.occurrence_count,
              tr.test_id,
              st.name AS test_name
       FROM bugs b
       LEFT JOIN test_runs tr ON tr.id = b.run_id
       LEFT JOIN saved_tests st ON st.id = tr.test_id
       WHERE b.project_id = $1
       ORDER BY b.reported_at DESC
       LIMIT 200`,
      [projectId],
    );
    return rows;
  }

  async getBugScreenshot(bugId: string): Promise<string | null> {
    const { rows } = await this.db.query(
      `SELECT run_id, screenshot_path FROM bugs WHERE id = $1`,
      [bugId],
    );
    const r = rows[0];
    if (!r?.screenshot_path) return null;
    const basename = path.basename(r.screenshot_path);
    // New location: independent of run
    const newFp = path.join(SCREENSHOTS_DIR, "bugs", basename);
    // Old location: inside run directory (backward compat)
    const oldFp = path.join(SCREENSHOTS_DIR, r.run_id, basename);
    const fp = fs.existsSync(newFp) ? newFp : oldFp;
    try {
      if (!fs.existsSync(fp)) return null;
      return fs.readFileSync(fp).toString("base64");
    } catch {
      return null;
    }
  }

  // ─── Runs ───────────────────────────────────────────────────────────────────

  async getTestRun(runId: string) {
    const { rows } = await this.db.query(`SELECT * FROM test_runs WHERE id = $1`, [runId]);
    return rows[0] ?? null;
  }

  async updateTestRun(runId: string, data: Record<string, any>) {
    const keys = Object.keys(data);
    const values = Object.values(data).map(v => typeof v === "object" && v !== null ? JSON.stringify(v) : v);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    await this.db.query(`UPDATE test_runs SET ${sets} WHERE id = $1`, [runId, ...values]);
  }

  /**
   * Incrementally append steps to steps_json (JSONB concat).
   * Safe to call mid-run — COALESCE initializes if null.
   */
  async appendRunSteps(runId: string, steps: any[]): Promise<void> {
    if (steps.length === 0) return;
    await this.db.query(
      `UPDATE test_runs
          SET steps_json = COALESCE(steps_json, '[]'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [runId, JSON.stringify(steps)],
    );
  }

  /**
   * Incrementally append LLM calls to llm_calls_json (JSONB concat).
   * Safe to call mid-run — COALESCE initializes if null.
   */
  async appendRunLlmCalls(runId: string, calls: any[]): Promise<void> {
    if (calls.length === 0) return;
    await this.db.query(
      `UPDATE test_runs
          SET llm_calls_json = COALESCE(llm_calls_json, '[]'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [runId, JSON.stringify(calls)],
    );
  }

  async createTestRun(data: Record<string, any>) {
    const keys = Object.keys(data);
    const values = Object.values(data).map(v => typeof v === "object" && v !== null ? JSON.stringify(v) : v);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await this.db.query(
      `INSERT INTO test_runs (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`,
      values,
    );
    return rows[0];
  }

  async getOpenBugs(projectId: string, limit: number) {
    const { rows } = await this.db.query(
      `SELECT name, description, category, severity, url FROM bugs WHERE project_id = $1 AND status = 'open' ORDER BY reported_at DESC LIMIT $2`,
      [projectId, limit],
    );
    return rows;
  }

  // ─── Regression Plans ───────────────────────────────────────────────────────

  async getRegressionPlan(table: string, id: string) {
    const { rows } = await this.db.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async updateRegressionPlan(table: string, id: string, data: Record<string, any>) {
    const keys = Object.keys(data);
    const values = Object.values(data).map(v => typeof v === "object" && v !== null ? JSON.stringify(v) : v);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    await this.db.query(`UPDATE ${table} SET ${sets} WHERE id = $1`, [id, ...values]);
  }

  async getExistingTests(projectId: string) {
    const { rows } = await this.db.query(`SELECT name, intent FROM saved_tests WHERE project_id = $1`, [projectId]);
    return rows.map((r: any) => ({ name: r.name as string, intent: r.intent as string }));
  }

  async getAuthConfig(projectId: string, environmentId: string) {
    const { rows } = await this.db.query(
      `SELECT * FROM auth_configs WHERE project_id = $1 AND environment_id = $2`,
      [projectId, environmentId],
    );
    if (!rows[0]) return null;
    // Decrypt sensitive fields on read
    if (rows[0].config_json && typeof rows[0].config_json === "object") {
      rows[0].config_json = decryptConfigJson(rows[0].config_json);
    }
    return rows[0];
  }

  // ─── Settings ─────────────────────────────────────────────────────────────────

  async getSettings(): Promise<Record<string, string>> {
    const { rows } = await this.db.query(`SELECT key, value FROM settings`);
    const result: Record<string, string> = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  }

  async saveSetting(key: string, value: string): Promise<void> {
    await this.db.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [key, value],
    );
  }

  async deleteSettings(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.db.query(`DELETE FROM settings WHERE key = ANY($1)`, [keys]);
  }

  // ─── Saved Tests ────────────────────────────────────────────────────────────

  async getSavedTest(id: string) {
    const { rows } = await this.db.query(`SELECT * FROM saved_tests WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async createSavedTest(data: { project_id: string; name: string; intent: string; context?: string; discovery_source?: string; discovery_run_id?: string }) {
    const { rows } = await this.db.query(
      `INSERT INTO saved_tests (project_id, name, intent, context, save_screenshots, discovery_source, discovery_run_id)
       VALUES ($1, $2, $3, $4, true, $5, $6) RETURNING *`,
      [data.project_id, data.name, data.intent, data.context ?? null, data.discovery_source ?? "manual", data.discovery_run_id ?? null],
    );
    return rows[0];
  }

  async updateSavedTest(id: string, data: Record<string, any>) {
    const keys = Object.keys(data);
    const values = Object.values(data).map(v => typeof v === "object" && v !== null ? JSON.stringify(v) : v);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    await this.db.query(`UPDATE saved_tests SET ${sets} WHERE id = $1`, [id, ...values]);
  }
}
