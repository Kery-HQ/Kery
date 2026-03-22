import { Pool } from "pg";
import type { StorageAdapter } from "@kery/engine";

export class PostgresAdapter implements StorageAdapter {
  constructor(private pool: Pool) {}

  // ─── Memory ─────────────────────────────────────────────────────────────────

  async loadProjectMemory(projectId: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM memory_entries WHERE scope = 'project' AND project_id = $1 ORDER BY confidence DESC LIMIT 50`,
      [projectId],
    );
    return rows;
  }

  async loadPageMemory(destinationId: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM memory_entries WHERE scope = 'page' AND destination_id = $1 ORDER BY confidence DESC LIMIT 50`,
      [destinationId],
    );
    return rows;
  }

  async saveProjectMemoryEntries(projectId: string, entries: any[]) {
    for (const e of entries) {
      await this.pool.query(
        `INSERT INTO memory_entries (scope, project_id, type, summary, content, region, source, confidence) VALUES ('project', $1, $2, $3, $4, $5, $6, $7)`,
        [projectId, e.type, e.summary, e.content, e.region ? JSON.stringify(e.region) : null, e.source ?? "agent", e.confidence ?? 50],
      );
    }
  }

  async savePageMemoryEntries(destinationId: string, entries: any[]) {
    for (const e of entries) {
      await this.pool.query(
        `INSERT INTO memory_entries (scope, destination_id, type, summary, content, region, source, confidence) VALUES ('page', $1, $2, $3, $4, $5, $6, $7)`,
        [destinationId, e.type, e.summary, e.content, e.region ? JSON.stringify(e.region) : null, e.source ?? "agent", e.confidence ?? 50],
      );
    }
  }

  async boostConfidence(ids: string[], amount = 5) {
    for (const id of ids) {
      await this.pool.query(
        `UPDATE memory_entries SET confidence = LEAST(100, confidence + $1), updated_at = now() WHERE id = $2`,
        [amount, id],
      );
    }
  }

  // ─── Bugs ───────────────────────────────────────────────────────────────────

  async persistBugsFromRun(projectId: string, runId: string, runLabel: string | null, reportedAt: string, environmentId: string | null, environmentName: string | null, enrichedBugs: any[]) {
    let inserted = 0;
    let skipped = 0;
    for (const bug of enrichedBugs) {
      // Simple dedup: same name + url + category within project
      const { rows: existing } = await this.pool.query(
        `SELECT id FROM bugs WHERE project_id = $1 AND name = $2 AND url IS NOT DISTINCT FROM $3 AND category = $4 LIMIT 1`,
        [projectId, bug.name, bug.url, bug.category],
      );
      if (existing.length > 0) { skipped++; continue; }

      await this.pool.query(
        `INSERT INTO bugs (project_id, run_id, environment_id, name, description, category, severity, status, steps_to_reproduce, url, run_label, reported_at, environment, step_index, screenshot_base64) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [projectId, runId, environmentId, bug.name, bug.description, bug.category, bug.severity, bug.status ?? "open", JSON.stringify(bug.stepsToReproduce ?? []), bug.url, runLabel, reportedAt, environmentName, bug.index ?? null, bug.screenshotBase64 ?? null],
      );
      inserted++;
    }
    return { inserted, skipped };
  }

  async listBugs(projectId: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM bugs WHERE project_id = $1 ORDER BY reported_at DESC LIMIT 200`,
      [projectId],
    );
    return rows;
  }

  // ─── Runs ───────────────────────────────────────────────────────────────────

  async getTestRun(runId: string) {
    const { rows } = await this.pool.query(`SELECT * FROM test_runs WHERE id = $1`, [runId]);
    return rows[0] ?? null;
  }

  async updateTestRun(runId: string, data: Record<string, any>) {
    const keys = Object.keys(data);
    const values = Object.values(data).map(v => typeof v === "object" && v !== null ? JSON.stringify(v) : v);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    await this.pool.query(`UPDATE test_runs SET ${sets} WHERE id = $1`, [runId, ...values]);
  }

  async createTestRun(data: Record<string, any>) {
    const keys = Object.keys(data);
    const values = Object.values(data).map(v => typeof v === "object" && v !== null ? JSON.stringify(v) : v);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await this.pool.query(
      `INSERT INTO test_runs (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`,
      values,
    );
    return rows[0];
  }

  // ─── Destinations ───────────────────────────────────────────────────────────

  async getDestination(id: string) {
    const { rows } = await this.pool.query(`SELECT * FROM app_tree_destinations WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async upsertDestinations(_projectId: string, _destinations: any[]) {
    // Implemented via buildAppTree
  }

  // ─── Coverage ───────────────────────────────────────────────────────────────

  async getProjectCoverage(projectId: string) {
    const { rows } = await this.pool.query(
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
    const { rows: coverage } = await this.pool.query(
      `SELECT run_id FROM run_coverage WHERE destination_id = $1 ORDER BY inspected_at DESC LIMIT $2`,
      [destinationId, limit],
    );
    if (coverage.length === 0) return [];
    const runIds = coverage.map((r: any) => r.run_id);
    const { rows } = await this.pool.query(
      `SELECT id, status, summary, steps_json FROM test_runs WHERE id = ANY($1)`,
      [runIds],
    );
    return rows;
  }

  async getOpenBugs(projectId: string, limit: number) {
    const { rows } = await this.pool.query(
      `SELECT name, description, category, severity, url FROM bugs WHERE project_id = $1 AND status = 'open' ORDER BY reported_at DESC LIMIT $2`,
      [projectId, limit],
    );
    return rows;
  }

  // ─── Regression Plans ───────────────────────────────────────────────────────

  async getRegressionPlan(table: string, id: string) {
    const { rows } = await this.pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async updateRegressionPlan(table: string, id: string, data: Record<string, any>) {
    const keys = Object.keys(data);
    const values = Object.values(data).map(v => typeof v === "object" && v !== null ? JSON.stringify(v) : v);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    await this.pool.query(`UPDATE ${table} SET ${sets} WHERE id = $1`, [id, ...values]);
  }

  // ─── Crawl ──────────────────────────────────────────────────────────────────

  async getCrawlEnvironment(_projectId: string, environmentId: string) {
    const { rows } = await this.pool.query(`SELECT * FROM environments WHERE id = $1`, [environmentId]);
    return rows[0] ?? null;
  }

  async createCrawlRun(data: Record<string, any>) {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await this.pool.query(
      `INSERT INTO crawl_runs (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`,
      values,
    );
    return rows[0];
  }

  async updateCrawlRun(id: string, data: Record<string, any>) {
    const keys = Object.keys(data);
    const values = Object.values(data).map(v => typeof v === "object" && v !== null ? JSON.stringify(v) : v);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    await this.pool.query(`UPDATE crawl_runs SET ${sets} WHERE id = $1`, [id, ...values]);
  }

  async getExistingTestNames(projectId: string) {
    const { rows } = await this.pool.query(`SELECT name FROM saved_tests WHERE project_id = $1`, [projectId]);
    return rows.map((r: any) => r.name);
  }

  async getAuthConfig(projectId: string, environmentId: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM auth_configs WHERE project_id = $1 AND environment_id = $2`,
      [projectId, environmentId],
    );
    return rows[0] ?? null;
  }

  async buildAppTree(projectId: string, crawlRunId: string, sitemap: any[]) {
    const now = new Date().toISOString();
    let added = 0, updated = 0;

    for (const page of sitemap) {
      if (!page.route) continue;
      const { rows: existing } = await this.pool.query(
        `SELECT id FROM app_tree_destinations WHERE project_id = $1 AND normalized_route = $2`,
        [projectId, page.route],
      );
      if (existing.length > 0) {
        await this.pool.query(
          `UPDATE app_tree_destinations SET title = $1, forms_json = $2, buttons_json = $3, interactions_json = $4, nav_links = $5, last_crawled_at = $6, crawl_run_id = $7, updated_at = $6 WHERE id = $8`,
          [page.title, JSON.stringify(page.forms), JSON.stringify(page.buttons), JSON.stringify(page.interactions), JSON.stringify(page.navLinks), now, crawlRunId, existing[0].id],
        );
        updated++;
      } else {
        await this.pool.query(
          `INSERT INTO app_tree_destinations (project_id, normalized_route, title, forms_json, buttons_json, interactions_json, nav_links, last_crawled_at, crawl_run_id, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)`,
          [projectId, page.route, page.title, JSON.stringify(page.forms), JSON.stringify(page.buttons), JSON.stringify(page.interactions), JSON.stringify(page.navLinks), now, crawlRunId],
        );
        added++;
      }
    }
    return { added, updated };
  }

  async upsertCrawlNodes(_projectId: string, _crawlRunId: string, _result: any) {
    // Simplified for OSS — handled by buildAppTree
  }

  // ─── Run Coverage ───────────────────────────────────────────────────────────

  async upsertRunCoverage(runId: string, destinationId: string, bugsFound: number) {
    await this.pool.query(
      `INSERT INTO run_coverage (run_id, destination_id, bugs_found) VALUES ($1, $2, $3) ON CONFLICT (run_id, destination_id) DO UPDATE SET bugs_found = $3`,
      [runId, destinationId, bugsFound],
    );
  }

  async updateDestinationHealth(destinationId: string, data: Record<string, any>) {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    await this.pool.query(`UPDATE app_tree_destinations SET ${sets} WHERE id = $1`, [destinationId, ...values]);
  }

  // ─── Saved Tests ────────────────────────────────────────────────────────────

  async getSavedTest(id: string) {
    const { rows } = await this.pool.query(`SELECT * FROM saved_tests WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async updateSavedTest(id: string, data: Record<string, any>) {
    const keys = Object.keys(data);
    const values = Object.values(data).map(v => typeof v === "object" && v !== null ? JSON.stringify(v) : v);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    await this.pool.query(`UPDATE saved_tests SET ${sets} WHERE id = $1`, [id, ...values]);
  }
}
