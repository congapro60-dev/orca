import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { runCodexAppServerSession } from './codex-app-server-session'

function invocation(body: string, timeoutMs = 5000) {
  return {
    command: process.execPath,
    cliPath: null,
    args: [
      '-e',
      `
      const readline = require('node:readline');
      const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const m = JSON.parse(line);
        if (m.method === 'initialize') { send({ id: m.id, result: {} }); return; }
        ${body}
      });
    `
    ],
    timeoutMs
  }
}

describe('Codex app-server streaming lifecycle', () => {
  it('delivers notifications and uses the explicit workspace cwd', async () => {
    const events: unknown[] = []
    const result = await runCodexAppServerSession(
      {
        ...invocation(`if (m.method === 'probe') {
          send({method:'turn/started', params:{text:'Tiếng Việt'}});
          send({id:m.id, result:{cwd:process.cwd()}});
        }`),
        cwd: tmpdir(),
        onNotification: (method, params) => events.push({ method, params })
      },
      ({ request }) => request('probe')
    )
    expect(result).toEqual({ cwd: tmpdir().replace(/[\\/]$/, '') })
    expect(events).toEqual([{ method: 'turn/started', params: { text: 'Tiếng Việt' } }])
  })

  it('does not mistake a server approval request for a response with the same ID', async () => {
    await expect(
      runCodexAppServerSession(
        invocation(
          `if (m.method === 'probe') send({id:m.id, method:'item/commandExecution/requestApproval', params:{}});`
        ),
        ({ request }) => request('probe')
      )
    ).rejects.toThrow(/unsupported interaction/)
  })

  it('propagates a child exit while body waits on notifications instead of an RPC', async () => {
    await expect(
      runCodexAppServerSession(
        invocation(`if (m.method === 'initialized') process.exit(1);`),
        () => new Promise<never>(() => {})
      )
    ).rejects.toThrow(/exited before completing/)
  })

  it('propagates a consumer policy rejection without an uncaught event exception', async () => {
    await expect(
      runCodexAppServerSession(
        {
          ...invocation(`if (m.method === 'initialized') send({method:'bad',params:{}});`),
          onNotification: () => {
            throw new Error('policy rejected')
          }
        },
        () => new Promise<never>(() => {})
      )
    ).rejects.toThrow('policy rejected')
  })

  it('aborts an in-flight session waiting for a turn event', async () => {
    const controller = new AbortController()
    await expect(
      runCodexAppServerSession({ ...invocation(''), signal: controller.signal }, () => {
        controller.abort()
        return new Promise<never>(() => {})
      })
    ).rejects.toThrow(/aborted/)
  })

  it('does not spawn when already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      runCodexAppServerSession(
        { ...invocation(''), command: 'missing-command', signal: controller.signal },
        async () => true
      )
    ).rejects.toThrow(/abort/i)
  })
})
