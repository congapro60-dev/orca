import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvidenceRecord } from '../../shared/control-evidence-contract'
import type { WorkItem } from '../../shared/control-core-contract'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { hasWorkspaceWriteEvidence, selectedTestEvidence } from './verification-evidence'

const list = vi.hoisted(() => vi.fn())
vi.mock('./control-evidence-store', () => ({
  ControlEvidenceStore: class {
    list = list
  }
}))

const native = {} as OrchestrationDb
const item = { workItemId: 'item', executionId: 'exec' } as WorkItem
let record: EvidenceRecord
beforeEach(() => {
  record = {
    executionId: 'exec',
    verificationStatus: 'READY_FOR_REVIEW',
    baseline: { worktree: '/workspace', baselineCommit: 'abc', workspaceHash: 'before' },
    observed: {
      worktree: '/workspace',
      baselineCommit: 'abc',
      workspaceHash: 'after',
      diffHash: 'diff',
      changedFiles: ['code.ts']
    },
    runtimeReceipt: {
      executionId: 'exec',
      worktree: '/workspace',
      effectiveSandbox: 'WORKSPACE_WRITE',
      approvalPolicy: 'never'
    },
    commands: [{ itemId: 'test', command: 'node --test', exitCode: 0, status: 'completed' }],
    tests: [{ commandItemId: 'test', command: 'node --test', exitCode: 0 }]
  } as EvidenceRecord
  list.mockImplementation(() => [record])
})

describe('workspace-write verification evidence', () => {
  it('requires a successful validation linked to this execution', () => {
    expect(hasWorkspaceWriteEvidence(native, item)).toBe(true)
  })
  it('selects captured commands without inferring tests from display strings', () => {
    record.tests = null
    expect(hasWorkspaceWriteEvidence(native, item)).toBe(false)
    expect(hasWorkspaceWriteEvidence(native, item, ['test'])).toBe(true)
    expect(record.tests).toBeNull()
    expect(selectedTestEvidence(record, ['test'])).toEqual([
      { commandItemId: 'test', command: 'node --test', exitCode: 0 }
    ])
    for (const ids of [[], ['missing'], ['test', 'test']]) {
      expect(() => selectedTestEvidence(record, ids)).toThrow()
    }
    record.commands![0]!.command = 'x'.repeat(2048)
    expect(() => selectedTestEvidence(record, ['test'])).toThrow()
    record.commands![0]!.command = 'node --test'
    record.commands!.push(record.commands![0]!)
    expect(() => selectedTestEvidence(record, ['test'])).toThrow()
  })
  it.each([
    'missing baseline',
    'missing tests',
    'missing commands',
    'failed test',
    'unknown exit',
    'wrong command',
    'wrong id',
    'incomplete command',
    'foreign workspace',
    'changed HEAD',
    'wrong permission',
    'duplicate tests'
  ])('refuses %s even with a non-empty diff', (fault) => {
    switch (fault) {
      case 'missing baseline':
        record.baseline = null
        break
      case 'missing tests':
        record.tests = null
        break
      case 'missing commands':
        record.commands = null
        break
      case 'failed test':
        record.tests![0]!.exitCode = 1
        break
      case 'unknown exit':
        record.commands![0]!.exitCode = null
        break
      case 'wrong command':
        record.tests![0]!.command = 'echo PASS'
        break
      case 'wrong id':
        record.tests![0]!.commandItemId = 'other'
        break
      case 'incomplete command':
        record.commands![0]!.status = 'inProgress'
        break
      case 'foreign workspace':
        record.observed!.worktree = '/other'
        break
      case 'changed HEAD':
        record.observed!.baselineCommit = 'other'
        break
      case 'wrong permission':
        record.runtimeReceipt!.effectiveSandbox = 'READ_ONLY'
        break
      case 'duplicate tests':
        record.tests!.push(record.tests![0]!)
        break
    }
    expect(hasWorkspaceWriteEvidence(native, item)).toBe(false)
  })
})
