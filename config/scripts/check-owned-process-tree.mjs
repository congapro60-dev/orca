import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const launcher = process.argv[2]
const started = performance.now()
assert(process.platform === 'win32', 'Windows-only prototype check')
assert(
  launcher && isAbsolute(launcher) && existsSync(launcher),
  'Pass the compiled local prototype path'
)
const fixture = mkdtempSync(join(tmpdir(), 'orca-job-descendant-'))
const pidFile = join(fixture, 'descendant.pid')
const root = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
child.unref();require('node:fs').writeFileSync(process.argv[1],String(child.pid));`
const { stdout } = await promisify(execFile)(
  launcher,
  [process.execPath, fixture, '-e', root, pidFile],
  {
    timeout: 15000,
    windowsHide: true,
    maxBuffer: 16384
  }
)
const proof = JSON.parse(stdout.trim())
assert.equal(proof.jobVerdict, 'exited')
assert.equal(proof.activeProcesses, 0)
assert.equal(proof.childExitCode, 0)
assert(proof.totalProcesses >= 2, 'Job must have contained both root and detached descendant')
const descendant = Number(readFileSync(pidFile, 'utf8'))
assert(Number.isSafeInteger(descendant) && descendant > 0)
let alive = false
try {
  process.kill(descendant, 0)
  alive = true
} catch (error) {
  assert.equal(error.code, 'ESRCH', 'Unknown process-query error is not exit proof')
}
assert(!alive, 'Detached fixture descendant must no longer be observable')
const crashFixture = mkdtempSync(join(tmpdir(), 'orca-job-owner-crash-'))
const crashFile = join(crashFixture, 'owned-pids.json')
const crashRoot = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
child.unref();require('node:fs').writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);`
const owner = spawn(launcher, [process.execPath, crashFixture, '-e', crashRoot, crashFile], {
  windowsHide: true,
  stdio: 'ignore'
})
const closed = once(owner, 'close')
const delay = () => new Promise((resolve) => setTimeout(resolve, 25))
try {
  const deadline = Date.now() + 3000
  while (!existsSync(crashFile) && Date.now() < deadline) {
    await delay()
  }
  assert(existsSync(crashFile), 'Suspended child must be assigned and resumed before crash check')
  const pids = JSON.parse(readFileSync(crashFile, 'utf8'))
  assert(pids.length === 2 && pids.every((pid) => Number.isSafeInteger(pid) && pid > 0))
  assert(owner.kill('SIGKILL'), 'Kill only the fixture owner through its own handle')
  await closed
  for (const pid of pids) {
    let present = true
    const exitDeadline = Date.now() + 3000
    while (present && Date.now() < exitDeadline) {
      try {
        process.kill(pid, 0)
        await delay()
      } catch (error) {
        assert.equal(error.code, 'ESRCH')
        present = false
      }
    }
    assert(!present, 'Owner death must reap root and detached grandchild without a PID sweep')
  }
} finally {
  if (owner.exitCode === null && owner.signalCode === null) {
    owner.kill('SIGKILL')
  }
}
const timeoutFile = join(crashFixture, 'timeout-pids.json')
const timeoutStarted = performance.now()
await assert.rejects(
  promisify(execFile)(
    launcher,
    ['--timeout-ms=1500', process.execPath, crashFixture, '-e', crashRoot, timeoutFile],
    { windowsHide: true, timeout: 7500, maxBuffer: 16384 }
  ),
  (error) => {
    assert.equal(error.code, 1)
    assert.equal(error.signal, null)
    assert.equal(error.killed, false, 'Native deadline, not fixture kill, bounds the invocation')
    assert.equal(error.stdout.trim(), '', 'Timeout must not fabricate a proof')
    assert.match(error.stderr, /TimeoutException: Bounded root wait did not complete/)
    return true
  }
)
const timeoutMs = performance.now() - timeoutStarted
assert(timeoutMs < 7500)
const timeoutPids = JSON.parse(readFileSync(timeoutFile, 'utf8'))
assert(timeoutPids.length === 2 && timeoutPids.every((pid) => Number.isSafeInteger(pid) && pid > 0))
for (const pid of timeoutPids) {
  assert.throws(
    () => process.kill(pid, 0),
    { code: 'ESRCH' },
    'Native timeout reaps owned processes'
  )
}
console.log(
  JSON.stringify({
    ...proof,
    detachedDescendantAbsent: true,
    ownerCrashReapsDescendants: true,
    nativeTimeoutReapsDescendants: true,
    timeoutMs: Math.round(timeoutMs),
    cases: 3,
    durationMs: Math.round(performance.now() - started),
    fixture,
    crashFixture
  })
)
