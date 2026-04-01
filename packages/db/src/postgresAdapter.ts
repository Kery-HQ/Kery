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

  async loadPageMemory(destinationId: string) {
    const { rows } = await this.db.query(
      `SELECT * FROM memory_entries WHERE scope = 'page' AND destination_id = $1 ORDER BY confidence DESC LIMIT 50`,
      [destinationId],
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

  async savePageMemoryEntries(destinationId: string, entries: any[]) {
    if (entries.length === 0) return;
    const values: any[] = [];
    const placeholders: string[] = [];
    let idx = 1;
    for (const e of entries) {
      placeholders.push(`('page', $${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5}, $${idx+6})`);
      values.push(destinationId, e.type, e.summary, e.content, e.region ? JSON.stringify(e.region) : null, e.source ?? "agent", e.confidence ?? 50);
      idx += 7;
    }
    await this.db.query(
      `INSERT INTO memory_entries (scope, destination_id, type, summary, content, region, source, confidence) VALUES ${placeholders.join(", ")}`,
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
    for (const bug of enrichedBugs) {
      // Simple dedup: same name + url + category within project
      const { rows: existing } = await this.db.query(
        `SELECT id FROM bugs WHERE project_id = $1 AND name = $2 AND url IS NOT DISTINCT FROM $3 AND category = $4 LIMIT 1`,
        [projectId, bug.name, bug.url, bug.category],
      );
      if (existing.length > 0) { skipped++; continue; }

      await this.db.query(
        `INSERT INTO bugs (project_id, run_id, environment_id, name, description, category, severity, status, url, run_label, reported_at, environment, step_index, screenshot_path, region) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [projectId, runId, environmentId, bug.name, bug.description, bug.category, bug.severity, bug.status ?? "open", bug.url, runLabel, reportedAt, environmentName, bug.index ?? null, bug.screenshotPath ?? null, bug.region ?? null],
      );
      inserted++;
    }
    return { inserted, skipped };
  }

  async listBugs(projectId: string) {
    const { rows } = await this.db.query(
      `SELECT id, project_id, run_id, environment_id, name, description, category, severity, status, url, run_label, reported_at, environment, step_index, created_at, screenshot_path, region FROM bugs WHERE project_id = $1 ORDER BY reported_at DESC LIMIT 200`,
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
    const fp = path.join(SCREENSHOTS_DIR, r.run_id, path.basename(r.screenshot_path));
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

  // ─── Destinations ───────────────────────────────────────────────────────────

  async getDestination(id: string) {
    const { rows } = await this.db.query(`SELECT * FROM app_tree_destinations WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async upsertDestinations(_projectId: string, _destinations: any[]) {
    // Implemented via buildAppTree
  }

  // ─── Coverage ───────────────────────────────────────────────────────────────

  async getProjectCoverage(projectId: string) {
    const { rows } = await this.db.query(
      `SELECT health_status FROM app_tree_destinations WHERE project_id = $1`,
      [projectId],
    );
    const total = rows.length;
    const clean = rows.filter((d: any) => d.health_status === "clean").length;
    const withIssues = rows.filter((d: any) => d.health_status === "issues").length;
    const stale = rows.filter((d: any) => d.health_status === "stale").length;
    const untested = rows.filter((d: any) => d.health_status === "untested").length;
    return { total, tested: clean + withIssues, clean, withIssues, stale, untested };
  }

  // ─── Path Generator ─────────────────────────────────────────────────────────

  async getPastRunsForDestination(destinationId: string, limit: number) {
    const { rows: coverage } = await this.db.query(
      `SELECT run_id FROM run_coverage WHERE destination_id = $1 ORDER BY inspected_at DESC LIMIT $2`,
      [destinationId, limit],
    );
    if (coverage.length === 0) return [];
    const runIds = coverage.map((r: any) => r.run_id);
    const { rows } = await this.db.query(
      `SELECT id, status, summary, steps_json FROM test_runs WHERE id = ANY($1)`,
      [runIds],
    );
    return rows;
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

  // ─── Crawl ──────────────────────────────────────────────────────────────────

  async getCrawlEnvironment(_projectId: string, environmentId: string) {
    const { rows } = await this.db.query(`SELECT * FROM environments WHERE id = $1`, [environmentId]);
    return rows[0] ?? null;
  }

  async createCrawlRun(data: Record<string, any>) {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await this.db.query(
      `INSERT INTO crawl_runs (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`,
      values,
    );
    return rows[0];
  }

  async updateCrawlRun(id: string, data: Record<string, any>) {
    const keys = Object.keys(data);
    const values = Object.values(data).map(v => typeof v === "object" && v !== null ? JSON.stringify(v) : v);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    await this.db.query(`UPDATE crawl_runs SET ${sets} WHERE id = $1`, [id, ...values]);
  }

  async getExistingTestNames(projectId: string) {
    const { rows } = await this.db.query(`SELECT name FROM saved_tests WHERE project_id = $1`, [projectId]);
    return rows.map((r: any) => r.name);
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

  async buildAppTree(projectId: string, crawlRunId: string, sitemap: any[]) {
    const now = new Date().toISOString();
    const validPages = sitemap.filter(p => p.route);
    if (validPages.length === 0) return { added: 0, updated: 0 };

    const routesThisRun = validPages.map((p: any) => p.route);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Batch upsert: single INSERT ... ON CONFLICT DO UPDATE
      const values: any[] = [];
      const placeholders: string[] = [];
      let idx = 1;
      for (const page of validPages) {
        placeholders.push(
          `($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8}, 0, true)`,
        );
        values.push(
          projectId, page.route, page.title,
          JSON.stringify(page.forms), JSON.stringify(page.buttons),
          JSON.stringify(page.interactions), JSON.stringify(page.navLinks),
          now, crawlRunId,
        );
        idx += 9;
      }

      const { rows } = await client.query(
        `INSERT INTO app_tree_destinations (project_id, normalized_route, title, forms_json, buttons_json, interactions_json, nav_links, last_crawled_at, crawl_run_id, crawl_miss_streak, enabled)
         VALUES ${placeholders.join(", ")}
         ON CONFLICT (project_id, normalized_route) DO UPDATE SET
           title = EXCLUDED.title,
           forms_json = EXCLUDED.forms_json,
           buttons_json = EXCLUDED.buttons_json,
           interactions_json = EXCLUDED.interactions_json,
           nav_links = EXCLUDED.nav_links,
           last_crawled_at = EXCLUDED.last_crawled_at,
           crawl_run_id = EXCLUDED.crawl_run_id,
           crawl_miss_streak = 0,
           health_status = CASE
             WHEN app_tree_destinations.health_status = 'stale' THEN 'untested'
             ELSE app_tree_destinations.health_status
           END,
           updated_at = EXCLUDED.last_crawled_at
         RETURNING (xmax = 0) AS inserted`,
        values,
      );
      const added = rows.filter((r: any) => r.inserted).length;

      await client.query(
        `UPDATE app_tree_destinations
         SET crawl_miss_streak = crawl_miss_streak + 1,
             updated_at = now()
         WHERE project_id = $1
           AND NOT (normalized_route = ANY($2::text[]))`,
        [projectId, routesThisRun],
      );

      await client.query(
        `UPDATE app_tree_destinations
         SET health_status = 'stale',
             updated_at = now()
         WHERE project_id = $1
           AND crawl_miss_streak >= 3`,
        [projectId],
      );

      await client.query("COMMIT");
      return { added, updated: rows.length - added };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async upsertCrawlNodes(_projectId: string, _crawlRunId: string, _result: any) {
    // Simplified for OSS — handled by buildAppTree
  }

  // ─── Run Coverage ───────────────────────────────────────────────────────────

  async upsertRunCoverage(runId: string, destinationId: string, bugsFound: number) {
    await this.db.query(
      `INSERT INTO run_coverage (run_id, destination_id, bugs_found) VALUES ($1, $2, $3) ON CONFLICT (run_id, destination_id) DO UPDATE SET bugs_found = $3`,
      [runId, destinationId, bugsFound],
    );
  }

  async updateDestinationHealth(destinationId: string, data: Record<string, any>) {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    await this.db.query(`UPDATE app_tree_destinations SET ${sets} WHERE id = $1`, [destinationId, ...values]);
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

  async updateSavedTest(id: string, data: Record<string, any>) {
    const keys = Object.keys(data);
    const values = Object.values(data).map(v => typeof v === "object" && v !== null ? JSON.stringify(v) : v);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    await this.db.query(`UPDATE saved_tests SET ${sets} WHERE id = $1`, [id, ...values]);
  }
}
