import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { coreFixture } from './control-core-test-fixture'
import { ControlCoreFacade } from './control-core-facade'
import { checkpointRuntime } from './checkpoint-runtime'
import { ControlWorkStore } from './control-work-store'
import { ControlEvidenceStore } from './control-evidence-store'
import { readLatestHandoff } from './handoff-integrity'
import { hasReadOnlyCheckpointEvidence } from './verification-evidence'
import { CodexRuntimeAdapterV0 } from '../codex/codex-runtime-adapter'
import { CodexExecutionSupervisor } from '../runtime/orchestration/codex-execution-supervisor'
import { runOwnedCodexSession } from '../codex/codex-owned-process-transport'
import type { runCodexAppServerSession } from '../codex/codex-app-server-session'

const fixtures: ReturnType<typeof coreFixture>[] = []
afterEach(() => fixtures.splice(0).forEach((f) => f.dispose()))

// Real child/Job/JSON-RPC/SQLite lifecycle; the child emulates Codex without account/model access.
function protocolFixture(fail: boolean): string {
  return String.raw`
    const readline = require('node:readline');
    const send = value => process.stdout.write(JSON.stringify(value)+'\n');
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line); if(m.id===undefined)return;
      let result={};
      switch(m.method){
        case 'initialize': break;
        case 'account/read': result={account:{type:'chatgpt'}};break;
        case 'config/read': result={config:{}};break;
        case 'hooks/list': result={data:[{hooks:[]}]};break;
        case 'mcpServerStatus/list': result={data:[],nextCursor:null};break;
        case 'thread/start': result={thread:{id:'fixture-thread'},cwd:process.cwd(),
          model:'fixture',approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false}};break;
        case 'turn/start':
          if(${fail}){
            process.stdout.write(JSON.stringify({id:m.id,result:{turn:{id:'fixture-turn'}}})+'\n',()=>process.exit(0));
            return;
          }
          send({method:'item/completed',params:{threadId:'fixture-thread',turnId:'fixture-turn',
            item:{type:'agentMessage',phase:'final_answer',text:'Fixture result after recovery'}}});
          send({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'fixture-turn',status:'completed'}}});
          result={turn:{id:'fixture-turn'}};break;
        default: throw new Error('Unexpected fixture method '+m.method);
      }
      send({id:m.id,result});
    });
  `
}

describe.runIf(process.platform === 'win32')(
  'Native owned-process recovery across DB restart',
  () => {
    it('recovers an unknown outcome using real containment proof and retains the source and handoff', async () => {
      const f = coreFixture()
      fixtures.push(f)
      const worktree = join(f.directory, 'workspace')
      mkdirSync(worktree)
      const artifact = join(process.cwd(), 'out', 'owned-process')
      const manifest = JSON.parse(readFileSync(join(artifact, 'launcher.json'), 'utf8'))
      const identity = {
        ...manifest,
        executablePath: join(artifact, 'orca-owned-process-tree.exe')
      }
      const prepare = async () => ({
        executable: process.execPath,
        version: 'native-node-protocol-fixture',
        worktree,
        codexHome: f.environment.codexHome
      })
      const runtime = (epoch: string, fail: boolean) => {
        const owned: typeof runCodexAppServerSession = (invocation, body) =>
          runOwnedCodexSession(
            identity,
            {
              ...invocation,
              command: process.execPath,
              cliPath: null,
              args: ['-e', protocolFixture(fail)]
            },
            body
          )
        const supervisor = new CodexExecutionSupervisor(
          f.db,
          epoch,
          new CodexRuntimeAdapterV0({ prepare, session: owned }),
          prepare
        )
        const core = new ControlCoreFacade(
          f.db,
          checkpointRuntime(f.db, {
            start: (taskId, request, signal, _checkpoint, beforeDispatch) =>
              supervisor.start(taskId, request, undefined, signal, beforeDispatch),
            get: (id) => supervisor.get(id),
            result: (id) => supervisor.result(id),
            cancel: (id) => supervisor.cancel(id)
          }),
          f.environment,
          {
            verify: async ({ item }) => ({
              passed: hasReadOnlyCheckpointEvidence(f.db, item),
              evidenceRefs: ['fixture:reviewed']
            })
          }
        )
        return { supervisor, core }
      }
      const first = runtime('before-restart', true)
      const session = first.core.createSession({
        projectId: 'native-owned',
        worktree,
        objective: 'Recover fixture'
      })
      const item = first.core
        .openSession(session.logicalWorkSessionId)
        .items.find((row) => row.branchId === 'main')!
      await first.core.start(item.workItemId, item.revision)
      const interrupted = await first.core.wait(item.workItemId)
      expect(interrupted.status).toBe('BLOCKED')
      const source = first.supervisor.get(interrupted.executionId!)
      expect(source.status).toBe('OUTCOME_UNKNOWN')
      expect(source.processObservations?.at(-1)).toMatchObject({
        scope: 'owned-process-launcher',
        verdict: 'exited',
        treeVerdict: 'exited',
        ownedTree: { launcherSha256: identity.binarySha256, activeProcesses: 0, childExitCode: 0 }
      })
      const sourceEvidence = new ControlEvidenceStore(new ControlWorkStore(f.db)).list(
        item.workItemId
      )
      expect(sourceEvidence[0].verificationStatus).toBe('UNVERIFIABLE')
      f.reopen()
      const second = runtime('after-restart', false)
      const blocked = second.core
        .openSession(session.logicalWorkSessionId)
        .items.find((row) => row.workItemId === item.workItemId)!
      expect(blocked.status).toBe('BLOCKED')
      const replacement = await second.core.start(item.workItemId, blocked.revision)
      expect(replacement.executionId).not.toBe(source.executionId)
      const ready = await second.core.wait(item.workItemId)
      expect(ready.status).toBe('READY_FOR_REVIEW')
      expect(second.supervisor.get(source.executionId)).toEqual(source)
      const handoff = readLatestHandoff(new ControlWorkStore(f.db), item.workItemId)!
      expect(handoff).toMatchObject({
        sourceExecutionId: source.executionId,
        targetExecutionId: ready.executionId
      })
      await second.core.verify(item.workItemId, ready.revision)
      f.reopen()
      const fresh = runtime('verified-reopen', false)
      expect(fresh.core.openSession(session.logicalWorkSessionId).session.status).toBe('COMPLETED')
      expect(fresh.supervisor.get(source.executionId)).toEqual(source)
      expect(fresh.supervisor.get(ready.executionId!).result).toBe('Fixture result after recovery')
      expect(readLatestHandoff(new ControlWorkStore(f.db), item.workItemId)).toEqual(handoff)
      for (const record of sourceEvidence) {
        expect(new ControlEvidenceStore(new ControlWorkStore(f.db)).get(record.evidenceId)).toEqual(
          record
        )
      }
    })
  }
)
