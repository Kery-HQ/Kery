import { z } from "zod";

export const ProjectIdParams = z.object({ projectId: z.string().uuid() });
export const RunIdParams = z.object({ runId: z.string().uuid() });
export const BugIdParams = z.object({ bugId: z.string().uuid() });
export const TestIdParams = z.object({ testId: z.string().uuid() });
export const DestinationIdParams = z.object({ destinationId: z.string().uuid() });

export const ProjectTestParams = z.object({
  projectId: z.string().uuid(),
  testId: z.string().uuid(),
});

export const ProjectEnvParams = z.object({
  projectId: z.string().uuid(),
  environmentId: z.string().uuid(),
});

export const RunFilenameParams = z.object({
  runId: z.string().uuid(),
  filename: z.string(),
});

export const ProjectDestParams = z.object({
  projectId: z.string().uuid(),
  destinationId: z.string().uuid(),
});

export const ProjectCrawlRunParams = z.object({
  projectId: z.string().uuid(),
  crawlRunId: z.string().uuid(),
});

export const ProjectDestMemoryEntryParams = z.object({
  projectId: z.string().uuid(),
  destinationId: z.string().uuid(),
  entryId: z.string().uuid(),
});

export const ProjectMemoryEntryParams = z.object({
  projectId: z.string().uuid(),
  entryId: z.string().uuid(),
});

export const ProjectBugParams = z.object({
  projectId: z.string().uuid(),
  bugId: z.string().uuid(),
});

export const BugPatchBody = z.object({
  status: z.enum(["open", "in_progress", "resolved", "wont_fix"]),
});

export const BugBulkDeleteBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});

export const TestUpdateBody = z.object({
  name: z.string().min(2).optional(),
  intent: z.string().min(3).optional(),
  context: z.string().nullable().optional(),
  /** Clear saved replay plan (regression script) for this flow */
  reset_script: z.boolean().optional(),
});

export const ProjectUpdateBody = z.object({
  name: z.string().min(2),
});
