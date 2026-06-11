import { FastifyInstance } from "fastify";
import { z } from "zod";
import { Pool } from "pg";
import type { StorageAdapter } from "@kery/engine";
import { ProjectIdParams } from "./params.js";

const GroupIdParams = z.object({ projectId: z.string().uuid(), groupId: z.string().uuid() });

export function registerGroupRoutes(app: FastifyInstance, storage: StorageAdapter) {
  const pool = storage.getPool() as Pool;

  // List groups with tests nested
  app.get("/api/projects/:projectId/groups", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);

    const { rows: groups } = await pool.query(
      `SELECT tg.*,
              COUNT(st.id)::int AS test_count
       FROM test_groups tg
       LEFT JOIN saved_tests st ON st.group_id = tg.id
       WHERE tg.project_id = $1
       GROUP BY tg.id
       ORDER BY tg.is_default DESC, tg.is_auto_scan DESC, tg.created_at ASC`,
      [projectId],
    );

    // If no groups exist yet (pre-migration projects), auto-create the default group
    if (groups.length === 0) {
      await (storage as any).ensureDefaultGroup(projectId);
      const { rows: newGroups } = await pool.query(
        `SELECT *, 0::int AS test_count FROM test_groups WHERE project_id = $1 ORDER BY is_default DESC`,
        [projectId],
      );
      const testsWithGroups = await pool.query(
        `SELECT st.*,
                COUNT(DISTINCT b.id) FILTER (WHERE b.status NOT IN ('resolved', 'wont_fix')) AS issues_count
         FROM saved_tests st
         LEFT JOIN test_runs tr ON tr.test_id = st.id
         LEFT JOIN bugs b ON b.run_id = tr.id
         WHERE st.project_id = $1
         GROUP BY st.id
         ORDER BY st.created_at DESC`,
        [projectId],
      );
      reply.send({ groups: newGroups, tests: testsWithGroups.rows.map(r => ({ ...r, issues_count: Number(r.issues_count) })) });
      return;
    }

    // Fetch all tests for the project
    const { rows: tests } = await pool.query(
      `SELECT st.*,
              COUNT(DISTINCT b.id) FILTER (WHERE b.status NOT IN ('resolved', 'wont_fix')) AS issues_count
       FROM saved_tests st
       LEFT JOIN test_runs tr ON tr.test_id = st.id
       LEFT JOIN bugs b ON b.run_id = tr.id
       WHERE st.project_id = $1
       GROUP BY st.id
       ORDER BY st.created_at DESC`,
      [projectId],
    );

    reply.send({
      groups,
      tests: tests.map(r => ({ ...r, issues_count: Number(r.issues_count) })),
    });
  });

  // Create a group
  app.post("/api/projects/:projectId/groups", async (req, reply) => {
    const { projectId } = ProjectIdParams.parse(req.params);
    const { name } = z.object({ name: z.string().min(1).max(64) }).parse(req.body);
    const group = await (storage as any).createGroup(projectId, name);
    reply.send({ group });
  });

  // Rename a group (not allowed for auto-scan or default)
  app.put("/api/projects/:projectId/groups/:groupId", async (req, reply) => {
    const { groupId } = GroupIdParams.parse(req.params);
    const { name } = z.object({ name: z.string().min(1).max(64) }).parse(req.body);
    const { rows } = await pool.query(`SELECT * FROM test_groups WHERE id = $1`, [groupId]);
    if (!rows[0]) { reply.code(404).send({ error: "not found" }); return; }
    if (rows[0].is_auto_scan) { reply.code(403).send({ error: "Auto-Scan group cannot be renamed" }); return; }
    const group = await (storage as any).renameGroup(groupId, name);
    reply.send({ group });
  });

  // Delete a group
  app.delete("/api/projects/:projectId/groups/:groupId", async (req, reply) => {
    const { projectId, groupId } = GroupIdParams.parse(req.params);
    const { deleteTests } = z.object({ deleteTests: z.boolean().default(false) }).parse(req.body ?? {});
    const { rows } = await pool.query(`SELECT * FROM test_groups WHERE id = $1`, [groupId]);
    if (!rows[0]) { reply.code(404).send({ error: "not found" }); return; }
    if (rows[0].is_default) { reply.code(403).send({ error: "Default group cannot be deleted" }); return; }
    if (rows[0].is_auto_scan) { reply.code(403).send({ error: "Auto-Scan group cannot be deleted" }); return; }
    const defaultGroupId = await (storage as any).ensureDefaultGroup(projectId);
    await (storage as any).deleteGroup(groupId, deleteTests, defaultGroupId);
    reply.send({ ok: true });
  });

  // Move a test to a group
  app.patch("/api/projects/:projectId/tests/:testId/group", async (req, reply) => {
    const { testId } = z.object({ projectId: z.string().uuid(), testId: z.string().uuid() }).parse(req.params);
    const { groupId } = z.object({ groupId: z.string().uuid() }).parse(req.body);
    await (storage as any).moveTest(testId, groupId);
    reply.send({ ok: true });
  });
}
