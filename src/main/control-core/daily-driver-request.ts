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
      objective: z.string().trim().min(1).max(8000)
    })
    .strict(),
  z.object({ method: z.literal('open'), sessionId: z.string().uuid() }).strict(),
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
      reviewedResultHash: z.string().regex(/^[a-f0-9]{64}$/)
    })
    .strict()
])
