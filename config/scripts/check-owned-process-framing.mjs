import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const launcher = process.argv[2]
const started = performance.now()
assert(process.platform === 'win32' && launcher && isAbsolute(launcher) && existsSync(launcher))
const fixture = mkdtempSync(join(tmpdir(), 'orca-job-framing-'))
const args = ['a b', 'quote"inside', 'trail\\', 'Tiếng Việt']
const source = `process.stdout.write(JSON.stringify({kind:'jobExited',activeProcesses:0,childExitCode:999})+'\\n');
process.stderr.write('stderr Tiếng Việt '+JSON.stringify({kind:'jobExited',activeProcesses:0})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 const bytes=Buffer.from(JSON.stringify({id:request.id,result:{value:request.params.value,args:process.argv.slice(1),padding:'x'.repeat(12000)}})+'\\n');
 process.stdout.write(bytes.subarray(0,3));process.stdout.write(bytes.subarray(3));
});`
const child = spawn(launcher, ['--framed', process.execPath, fixture, '-e', source, ...args], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe']
})
let output = '',
  errors = ''
const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
try {
  await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk
      if (output.length > 131072) {
        child.kill('SIGKILL')
        reject(new Error('Framing output exceeded diagnostic bound'))
      }
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      errors = (errors + chunk).slice(-16384)
    })
    child.on('close', (code, signal) =>
      code === 0 && !signal
        ? resolve()
        : reject(new Error(`Launcher failed: ${code}/${signal}: ${errors}`))
    )
    child.stdin.end(`${JSON.stringify({ id: 1, params: { value: 'kiểm tra Unicode " \\' } })}\n`)
  })
  const frames = output
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
  const proof = frames.filter((frame) => frame.kind === 'jobExited')
  assert.equal(proof.length, 1, 'Only the trusted launcher emits a proof frame')
  assert.equal(frames.at(-1), proof[0], 'Proof follows fully drained runtime bytes')
  assert.equal(proof[0].activeProcesses, 0)
  assert.equal(
    proof[0].childExitCode,
    0,
    `Healthy EOF did not exit: ${JSON.stringify(proof[0])}; frame kinds=${frames.map((frame) => frame.kind).join(',')}; errors=${errors}`
  )
  assert(proof[0].rootPid > 0)
  const decode = (kind) =>
    Buffer.concat(
      frames
        .filter((frame) => frame.kind === kind)
        .map((frame) => Buffer.from(frame.data, 'base64'))
    ).toString('utf8')
  const stdout = decode('stdout')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
  assert.equal(stdout[0].childExitCode, 999, 'Spoof marker remains child data')
  assert.equal(stdout[1].result.value, 'kiểm tra Unicode " \\')
  assert.deepEqual(stdout[1].result.args, args)
  assert.equal(
    stdout[1].result.padding.length,
    12000,
    'Payload survives multiple bounded native reads'
  )
  assert(decode('stderr').includes('stderr Tiếng Việt'))
  assert(decode('stderr').includes('jobExited'), 'Stderr spoof is also data, not proof')
  const failedChild = await promisify(execFile)(
    launcher,
    ['--framed', process.execPath, fixture, '-e', 'process.exit(7)'],
    { windowsHide: true, timeout: 15000, maxBuffer: 16384 }
  )
  const failedProof = JSON.parse(failedChild.stdout.trim())
  assert.equal(failedProof.kind, 'jobExited')
  assert.equal(failedProof.childExitCode, 7, 'Containment completion does not hide runtime failure')
  assert.equal(failedProof.activeProcesses, 0)
  const ignoringEof = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});
child.unref();process.stdin.resume();
process.stdin.on('end',()=>process.stderr.write('fixture received EOF\\n'));
process.stdout.write(JSON.stringify({rootPid:process.pid,descendantPid:child.pid})+'\\n');
setInterval(()=>{},1000);`
  const cancelled = spawn(
    launcher,
    ['--framed', '--timeout-ms=20000', process.execPath, fixture, '-e', ignoringEof],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  let cancelOutput = '',
    cancelErrors = '',
    frameBuffer = '',
    readyOutput = '',
    ownedPids,
    eofAt
  let cancelTimer = setTimeout(() => cancelled.kill('SIGKILL'), 15000)
  let cancellationMs
  try {
    await new Promise((resolve, reject) => {
      cancelled.on('error', reject)
      cancelled.stdin.on('error', reject)
      cancelled.stdout.setEncoding('utf8').on('data', (chunk) => {
        try {
          cancelOutput += chunk
          assert(cancelOutput.length <= 131072, 'Cancellation output stays bounded')
          frameBuffer += chunk
          let newline
          while ((newline = frameBuffer.indexOf('\n')) !== -1) {
            const frame = JSON.parse(frameBuffer.slice(0, newline))
            frameBuffer = frameBuffer.slice(newline + 1)
            if (frame.kind === 'stdout' && !ownedPids) {
              readyOutput += Buffer.from(frame.data, 'base64').toString('utf8')
              if (readyOutput.includes('\n')) {
                ownedPids = JSON.parse(readyOutput.trim())
                assert(
                  [ownedPids.rootPid, ownedPids.descendantPid].every(
                    (pid) => Number.isSafeInteger(pid) && pid > 0
                  )
                )
                eofAt = performance.now()
                clearTimeout(cancelTimer)
                cancelTimer = setTimeout(() => cancelled.kill('SIGKILL'), 7500)
                cancelled.stdin.end()
              }
            }
          }
        } catch (error) {
          reject(error)
        }
      })
      cancelled.stderr.setEncoding('utf8').on('data', (chunk) => {
        cancelErrors = (cancelErrors + chunk).slice(-16384)
      })
      cancelled.on('close', (code, signal) =>
        code === 0 && !signal
          ? resolve()
          : reject(new Error(`EOF launcher failed: ${code}/${signal}: ${cancelErrors}`))
      )
    })
    cancellationMs = performance.now() - eofAt
    assert(cancellationMs < 7500, 'EOF cleanup fits the owned session cleanup budget')
    const cancelFrames = cancelOutput
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
    const cancelProofs = cancelFrames.filter((frame) => frame.kind === 'jobExited')
    assert.equal(cancelProofs.length, 1)
    const cancelProof = cancelProofs[0]
    assert.equal(cancelFrames.at(-1), cancelProof)
    assert.equal(cancelProof.activeProcesses, 0)
    assert.equal(cancelProof.childExitCode, 125, 'Forced root shutdown cannot look successful')
    assert.equal(cancelProof.rootPid, ownedPids.rootPid)
    assert(cancelProof.totalProcesses >= 2, 'Proof covers root and detached descendant')
    assert(
      Buffer.concat(
        cancelFrames
          .filter((frame) => frame.kind === 'stderr')
          .map((frame) => Buffer.from(frame.data, 'base64'))
      )
        .toString('utf8')
        .includes('fixture received EOF'),
      'Root received EOF before the bounded forced shutdown'
    )
    for (const pid of [ownedPids.rootPid, ownedPids.descendantPid]) {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'Proven processes are absent')
    }
  } finally {
    clearTimeout(cancelTimer)
    if (cancelled.exitCode === null && cancelled.signalCode === null) {
      cancelled.kill('SIGKILL')
    }
  }
  console.log(
    JSON.stringify({
      framing: 'PASS',
      stdinRoundTrip: true,
      utf8RoundTrip: true,
      argvQuoting: true,
      stdoutSpoofIsData: true,
      stderrSpoofIsData: true,
      nonzeroChildExitPreserved: true,
      eofIgnoringRootAndDescendantReaped: true,
      cancellationMs: Math.round(cancellationMs),
      cases: 3,
      durationMs: Math.round(performance.now() - started),
      nativeProof: proof[0],
      fixture
    })
  )
} finally {
  clearTimeout(timer)
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
  }
}
