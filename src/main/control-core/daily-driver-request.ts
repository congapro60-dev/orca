import { z } from 'zod'
const Id = z.string().trim().min(1).max(4096)
export const DailyDriverRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('projects') }).strict(),
  z.object({ method: z.literal('sessions'), projectId: Id }).strict(),
  z.object({ method: z.literal('workspaceInfo'), projectId: Id, workspaceId: Id }).strict(),
  z
    .object({
      method: z.literal('create'),
      projectId: Id,
      workspaceId: Id,
      objective: z.string().trim().min(1).max(8000),
      permissionMode: z.enum(['READ_ONLY', 'WORKSPACE_WRITE']).default('READ_ONLY')
    })
    .strict(),
  z.object({ method: z.literal('open'), sessionId: z.string().uuid() }).strict(),
  z.object({
    method: z.literal('followup'),
    sessionId: z.string().uuid(),
    objective: z.string().trim().min(1).max(8000),
    permissionMode: z.enum(['READ_ONLY', 'WORKSPACE_WRITE']).optional()
  }).strict(),
  z
    .object({
      method: z.literal('start'),
      sessionId: z.string().uuid(),
      expectedRevision: z.number().int().nonnegative()
    })
    .strict(),
  z.object({ method: z.literal('cancel'), sessionId: z.string().uuid() }).strict(),
  z.object({ method: z.literal('reconcile'), sessionId: z.string().uuid() }).strict(),
  z
    .object({
      method: z.literal('verify'),
      sessionId: z.string().uuid(),
      expectedRevision: z.number().int().nonnegative(),
      reviewedResultHash: z.string().regex(/^[a-f0-9]{64}$/),
      reviewedEvidenceHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      testCommandItemIds: z
        .array(z.string().min(1).max(256))
        .max(64)
        .refine((ids) => new Set(ids).size === ids.length, 'Duplicate test command IDs')
        .optional()
    })
    .strict()
])
