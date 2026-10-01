# Plan: ORCA Daily Driver Alpha — master execution

Status: approved-for-autonomous-build. Owner's `C:\Users\ADMIN\.codex\attachments\7d151ad2-5fdb-4b5c-a597-44ae641ec69a\pasted-text-1.txt` supersedes the earlier A1-only scope below. Phase gates 0–6 and experimental Phase 7 are authorized; no push/deploy, global Codex security change, trust expansion, secret extraction, protected-WIP destruction, or FULL_ACCESS. C:\oa is the implementation worktree; ORCA/Control Core remains canonical authority and Codex is a runtime. Each phase requires deterministic, integration, live (where applicable), and fresh-context review evidence before its local checkpoint commit. The older Slice A record below is historical context, not a current scope limit.

Current phase: 4 — daily driver UI and Vietnamese localization; Phase 3 checkpoint `534c8c2a`. Evidence root: `C:\Users\ADMIN\Documents\Codex\orca-alpha-evidence\2026-09-27_13-51-27`. Phase 3 passed 636 relevant tests (1 existing Windows skip), typecheck/build/native/lint and independent review. Phases 4–6 follow the owner's detailed master plan; Phase 7 cannot invalidate a certified Phase 6. See external `MASTER_EXECUTION_STATUS.md` for live gate state.

## Phase 2 implementation contract — approved master plan, 2026-09-29

Phase 1 checkpoint: `8f057ed2`; live gate/review provenance in external `PHASE_1_GATE_FINAL.md`. Phase 2 is now active. Reuse native OrchestrationDb/Run/Task/Dispatch; add logical session, WorkItem, work-event and mailbox tables in the same SQLite connection. ControlCoreFacade is the only future user-facing workflow entry. Runtime completion maps to READY_FOR_REVIEW; explicit evidence-backed core verification alone creates VERIFIED. Root CompletionBarrier requires all required children/dependencies VERIFIED. Mailbox envelopes never mutate work status. Runtime replacements create a new native task/attempt but retain the same logical session/item IDs. WorkPacketCompiler uses bounded selected context and constraints; canonical knowledge is not overwritten by injected context. Local/folder workspaces supported; no new remote execution or provider in this phase. Deterministic/integration tests cover the exact six master acceptance cases plus restart and illegal state transitions. No Phase 3/4 implementation until Phase 2 gate passes. User has authorized autonomous execution after each gate.

## Owner-added objective: Vietnamese localization (queued for Phase 4)

Owner explicitly requests Vietnamese UI because the English interface is difficult to use. Add to the product goal; implement when the Phase 4 daily-driver UI is ready, not by delaying the current runtime gate. Reuse Orca's localization mechanism. First cover project/task/session navigation, task composer, permissions, Start/Cancel, progress states, result/evidence, actionable errors, onboarding and relevant settings. Preserve code/API/model names and raw technical errors with understandable Vietnamese guidance alongside them. Language selection must persist across restart. Follow with broader native UI coverage; record any untranslated areas rather than claiming whole-app localization from a partial catalog. Verify representative screens and language persistence before reporting this objective complete. No global Codex configuration change.

## Phase 3 implementation contract - active after Phase 2 PASS

Reuse the same OrchestrationDb connection and ControlCoreFacade host boundary. Add a durable TaskJournal that references logical objective, WorkEvents, attempts, artifacts/evidence, verification and explicit decisions; never copy full transcripts. Journal snapshots/versioning must not overwrite historical evidence. Distinguish bounded working context from persisted CandidateMemory and Canonical Memory. Candidates carry project/session identity, statement/kind, source evidence/artifact references, revision, content hash, status and timestamps. Candidate creation validates source ownership/provenance. Runtime-facing mailbox/context does not expose canonical writes.

## Phase 4 implementation contract - active after Phase 3 PASS

Reuse the existing Orca desktop shell, project/workspace registry, UI primitives and i18n persistence. Add one discoverable daily-driver view for selecting a registered local Project + workspace (Git worktree or folder), composing a bounded task and choosing READ_ONLY, observing Control Core WorkItem state/native execution events, seeing final result/basic host evidence, cancelling and reopening an existing LogicalWorkSession after app restart. A main-process-only bridge constructs one ControlCoreFacade over native OrchestrationDb/CodexExecutionSupervisor. UI never calls the old flat workerStart/Codex RPC for this flow. Host resolves worktree/Project IDs from Orca's registry and rejects remote/SSH ownership before dispatch; no client-supplied executable/home/path authority. Explicit user verification after a completed result must check native execution/task/dispatch linkage and read-only runtime policy before marking VERIFIED. Missing evidence stays READY_FOR_REVIEW or BLOCKED with a visible recovery message. Do not expose unfinished providers or workspace-write yet.

Add Vietnamese as a persisted built-in UI language. Localize the daily-driver flow, its permission/status/error/recovery text, project/task/session navigation and relevant language settings first. Keep technical IDs/API/model names literal and show source errors alongside clear Vietnamese guidance. Other catalog areas may retain English fallback until broader localization; report exact coverage. Verify persisted selection after restart. Follow docs/STYLEGUIDE.md tokens/primitives, keyboard/focus and Windows/macOS/Linux placement. Acceptance is a real Orca UI canary on the isolated smoke project, one real READ_ONLY Codex run and result/evidence in the UI, no manual CLI orchestration of success, then app restart showing the same session/result. Capture screenshot evidence, tests/typecheck/lint/build, fresh review and local checkpoint before Phase 5.

PromotionGate is an explicit host-owned operation, with expected candidate revision/hash and expected canonical revision/hash; conflicting or stale writes fail atomically. Reuse the existing redactor. Preserve rejected/superseded candidates and historical source references, never rewrite old evidence. No autonomous promotion, Dreaming, new provider, or UI in Phase 3. Acceptance: completion produces a durable journal; evidence-backed candidate creation; no canonical row before explicit promotion; stale revision rejection; supersession preserves old evidence; reopen restores identities/state. Run deterministic/native integration, typecheck/lint/build and fresh-context read-only review, then the approved local checkpoint before Phase 4.

## Prior Slice A plan (superseded where scope conflicts)

## Phase 1 implementation contract (2026-09-27)

- Phase 0 checkpoint: `d74f4664`. Substrate: installed Codex app-server JSONL; reuse `runCodexAppServerSession` framing/deadline/reap and the shared child-process boundary. Extend transport with cwd, notifications and cancellation/failure propagation; do not revive TUI worker permission capability.
- Adapter V0 owns only runtime execution identity/status/events/result, never Orca Task authority. Native Orca DB owns Run/Task/Dispatch; a persistent execution linkage joins one Dispatch to one execution. No worker_done hook is canonical completion.
- Start only from host-resolved absolute executable, explicit canonical worktree and dedicated CODEX_HOME. Read-only mode plus approval never; verify returned sandbox/cwd before turn/start; no fabricated actual model. Reject requests for interaction. No global config/trust edit or credential read.
- Deterministic fake-protocol tests must cover notification/request ID collisions, early process exit, timeout/cancel, receipt policy mismatch, bounded events/result, and durable terminal state. Live/restart proof is mandatory before Phase 1 PASS; auth/quota failure is not model success.
- Current live diagnostic after v0.158 update: thread/turn policy confirmed; turn failed with routing discovery 401. Managed account refresh returned account=null. Official dedicated-profile login started; awaiting owner sign-in. Native integration may be built/tested while live auth is unresolved, but no Phase 1 certification until real canary and write denial pass.

### Historical A1 scope

Status: approved-A1-only; owner authorized completing Slice A with a dedicated profile and the inherited Interrupt hook explicitly disabled. F1/F2 and UI are out of scope for this iteration even if A0–A10 pass.
Source of truth: attached user request `Văn bản đã dán.txt`; current `ce4df077` source and installed Orca v1.4.192.

## 2026-09-25 short-path decision

Owner attachment `db75b5a9-acf3-4d44-9ade-4340d3c9462e/pasted-text-1.txt` approves one reversible temporary `subst` mapping for only this Alpha worktree to test the `C1258`/262-character native rebuild path hypothesis. O: is unused in the observed FileSystem drive list and no existing `subst` mapping was reported. Map the existing physical worktree without copying or relocating it, run the same native-readiness script and dependencies from the mapped root, then remove and verify the mapping after build/canary work or at any STOP. Keep the physical path as canonical identity. If C1258 remains or a different native-module error appears, classify and stop rather than stacking workarounds. Once native readiness passes, review the current global Codex config semantically under its stable observed SHA-256 baseline, rerun full current-source preflight, then attempt only the authorized safe A1 canary; F1/F2 and UI remain deferred.

## 2026-09-25 toolchain remediation authorization

Owner attachment `9513540f-c0a3-4d97-9462-a2fb2796d759/pasted-text-1.txt` authorizes only Microsoft components strictly needed for Electron native rebuild, then current-source preflight and one safe A1 canary. Read-only inventory before installation: Visual Studio Build Tools 2022 `17.14.37027.9`, channel `VisualStudio.17.Release`, at `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools`; default MSVC v143 `14.44.35207`, x64 and x86 compiler binaries present; project requests v143 with `<SpectreMitigation>Spectre</SpectreMitigation>` and Windows SDK `10.0.26100.0`. Neither `lib\spectre\x64` nor `lib\spectre\x86` is present. Installed instance selected 18 components, including `Microsoft.VisualStudio.Component.VC.Tools.x86.x64`, but no Spectre component. Both the local VS catalog and Microsoft's official component list identify the matching optional component as `Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64.Spectre`; local catalog version `17.14.36510.44`. This one ID is the requested install target, without optional/recommended workloads. Its catalog declares x86/x64 ATL and CRT Spectre dependencies; accept only Installer-required dependencies, not unrelated workloads/ARM/MFC. If UAC requests owner action, stop at that prompt. No source or security-policy workaround.

## Objective and scope

Prove a bounded, read-only chain through native Orca: Run → Task → `workerStart(agent=codex)` → real Codex process → result/output → persistent `OrchestrationDb`. Fix only a concrete blocker in this chain. Do not build Alpha UI or use OpenCode Desk/bridge as a backend.

## A0 safety

- Original checkout: `C:\Users\ADMIN\Documents\Codex\2026-09-13\orca-v1.4.192-p0.2a`, detached `ce4df077`, 11 tracked modified files.
- Snapshot: `C:\Users\ADMIN\Documents\Codex\orca-alpha-safety-2026-09-23`; binary patch and byte-identical copies of all 11 files. Original/source copy SHA-256 comparisons: 11/11 match.
- Isolated checkout: `C:\Users\ADMIN\.config\superpowers\worktrees\orca-daily-driver-alpha`, branch `codex/orca-daily-driver-alpha`, clean at `ce4df077`.
- Recheck original hashes and status after canary. No commit/push of original WIP.

## Existing native path

1. Start packaged Orca v1.4.192 through `orca open` and drive it through the CLI as a headless canary harness. Confirm `orca status --json` reports ready. The packaged app does not honor an inherited `ORCA_USER_DATA_PATH` as its Electron `userData` setting; `orca serve` binds WebSocket to `0.0.0.0` even with `--no-pairing`. The ordinary desktop runtime binds loopback by default. Before launch, verify the default `%APPDATA%\orca` profile has no existing data or record what exists; use only the smoke project and do not alter other project registrations. This is a CLI-driven canary, not a UI Alpha implementation.
2. Register the clean smoke project `C:\Users\ADMIN\Documents\Codex\poc\orca-opencode-desk-2026-08-30\poc-workspace\orca-smoke-project` in this isolated Orca profile. Use an existing managed worktree or create one only if runtime requires it. Keep its files read-only by instruction and verify Git status before/after.
3. Create a native coordinator terminal; `orchestration.runCreate` requires its live terminal handle and stable pane key (`src/main/runtime/rpc/methods/orchestration-runs.ts`, `orchestration-run-scope.ts`). Its binding is held in `OrchestrationDb`.
4. `orchestration.taskCreate` creates a task tied to that Run and coordinator identity (`orchestration.ts`, `db/tasks/task-store.ts`).
5. `orchestration.workerStart` with `agent=codex`, explicit worktree and bounded timeout creates a Codex terminal, waits for ready, creates Dispatch and injects its bounded read-only task preamble (`orchestration-workers.ts`, `orchestration-worker-topology.ts`). Do not force model selection. Record requested model as absent; actual model remains `UNKNOWN/UNVERIFIED` unless a Codex-produced execution/session record or response identifies the model. A launch flag, process environment, or Orca catalog label alone does not prove the actual model.
6. Poll `workerShow`, `workerRead`, `taskList`/`runShow` and inspect Codex process/session identity. The task may reach terminal state via the native lifecycle/report protocol; do not mark completed merely because TUI is idle or printed an answer.
7. Read native `orchestration.db` and reopen it/runtime to prove Run/Task/Dispatch/result survive restart. Keep original installed Orca profile and Desk untouched.

## Acceptance gates

A0: original source WIP preserved, clean isolated Alpha checkout.
A1: Run/Task in native `OrchestrationDb`.
A2: native Orca starts a real Codex process.
A3: Run/Task/Dispatch IDs form one chain.
A4: Codex result/output retrievable through native Orca.
A5: completed Run/Task/result readable after DB/runtime reopen.
A6: smoke repo remains clean.
A7: targeted tests, typecheck, lint/build where safe; record exact exit codes and any prerequisite limits.
A8: exact paths, symbols, commands, IDs and model identity evidence. Never infer actual model from requested launch setting.

## Stop and fallback

- First try native installed runtime with no source edit. Codex CLI `login status` reports ChatGPT login, but Orca may use another home. A Codex login/device-code prompt, explicit auth failure, approval prompt, or `workerStart` readiness timeout with an interactive wait is a stop signal; preserve its exact CLI/worker output. Do not bypass permissions.
- If the installed native path fails, locate the narrow source blocker in the Alpha worktree, implement only that fix, then test against the Alpha build. Do not modify installed app or original dirty source.
- Do not claim PASS for `workerStart` without process evidence, or for completion without native task/dispatch/result persistence.
- After Slice A, stop before Task Composer/UI work.

## Risks and open facts

- The packaged Orca v1.4.192 and source baseline share version, but live behavior must still be verified.
- Codex CLI auth/model entitlement is unproven. A login prompt, quota error or uncertain provider identity stays visible as a blocker, not a PASS.
- The packaged desktop runtime writes `%APPDATA%\orca` and may open an Orca window; inspect that profile before first launch. Stop if it already contains unrelated user state that would make the canary intrusive. Report the profile and leave it intact after the canary.
- If a windowless runtime becomes necessary, use an isolated source/dev build with a verified loopback bind and explicit Codex auth boundary. Do not use packaged `orca serve --no-pairing` under the false assumption that it is loopback-only.
- Source checkout currently lacks `node_modules`; dependency setup and native build may be needed only if a source fix is required. Keep all such operations inside the isolated Alpha worktree and document them.

## Review decision

OpenCode CLI read-only reviewer `opencode/nemotron-3-ultra-free` returned `APPROVE` on 2026-09-23 with four notes. Reconciled:

1. Actual model proof is specified in step 5; requested launch model is never copied to actual.
2. The smoke repo path contains `opencode-desk` only as a historical folder name. The canary uses native Orca CLI/RPC and does not load Desk or the bridge.
3. Version equality does not prove binary/source parity. The first canary exercises the installed Orca v1.4.192 binary only; if a source fix is needed, verify the resulting Alpha build separately. Requiring an Alpha build before a no-edit canary would create a needless dependency/install gate.
4. Auth/permission stop signals are specified above.

The user's attached request explicitly authorizes autonomous Slice A execution after review. Slice B remains outside authorization.

## Canary stop, 2026-09-24

Native Orca v1.4.192 created Run `run_01c40964e824`, Task `task_cc4a2be419ae`, and Worker Dispatch `ctx_01cc497af0fd`. Codex v0.155.0-alpha.16.3 started and displayed a `Hooks need review` prompt. Orca's prompt delivery failed with `agent_prompt_blocked`; Task/Dispatch are durably `failed`, Task.result is `null`. The Codex UI also showed `permissions: YOLO mode`; a read-only prompt does not enforce a read-only sandbox. No hook trust option was selected. The failed worker terminal's PowerShell continuation was cleared with one interrupt. The smoke repo remains clean. See `SLICE_A_REPORT.md`. Do not proceed to another workerStart or Slice B until hook trust and the Codex permission mode are resolved.

Later `orca status --json` reported the main app `not_running`; a fresh read-only SQLite connection still recovered the failed Run/Task/Dispatch/worker rows. The main-process exit cause was not established. No runtime restart or task retry was attempted after the stop gate.

## 2026-09-24 continuation — ordered A1 → F1 → F2

Source of truth: user attachment `40126cd0-3710-4961-9357-79133daeda82/Văn bản đã dán.txt`. The existing `SLICE_A_REPORT.md` and safety snapshot remain authoritative for the first canary. No UI or OpenCode Desk integration is in scope.

### Owner decision for this A1 iteration

The later owner attachment `4feefaae-3667-4707-ae77-0d8f6769305c/pasted-text-1.txt` withdraws the physical-absence requirement for the inherited non-managed `Interrupt` hook. In a dedicated dev `CODEX_HOME`, it may remain defined but must be disabled through Codex's supported per-hook mechanism, must not run, and must not broaden trust. Capture before/after inventory from the actual worker home; stop if a trust prompt persists. Re-run current-source checks, prove the resolved and actual Codex executable separately, run one fresh safe native canary, verify write denial and completed-result persistence after reopen, then stop with a Slice A report. Do not start F1/F2.

### A1.1 Current Codex configuration and hook provenance

- The Codex executable at `C:\Users\ADMIN\AppData\Local\OpenAI\Codex\bin\80f78947ad880e6e\codex.exe` reports `codex-cli 0.155.0-alpha.16.3`, matching the prior TUI banner. The exact process path used by the prior Orca worker is still to be positively verified during a new launch.
- Orca's managed `CODEX_HOME` is `%APPDATA%\orca\codex-runtime-home\home`. Its `hooks.json` has eight Orca command hooks, all `trusted` according to Codex's read-only `hooks/list` RPC. The only `untrusted` hook is a user-config `Interrupt` hook in that home's `config.toml`: `C:\Users\ADMIN\.codex-chatgpt-web\versions\5.0.6-win32-x64\runtime\bun.exe` runs `...\app\cli.js --home C:\Users\ADMIN\.codex-chatgpt-web hook interrupt`. It is unrelated to normal worker completion; it releases a local Responses request on interruption.
- The system Codex config has the same `Interrupt` definition and a trusted hash for its **system-home key**, whereas the Orca-mirrored definition is keyed to the Orca-owned home and `hooks/list` marks that entry untrusted. This key/path change explains the new review requirement as an inference, not proof that this hook alone caused the blocked prompt. No trust entry was copied or granted.
- Official Codex docs require trust for changed hook hashes and support disabling an individual non-managed hook through `/hooks`. A read-only trial of `-c hooks.Interrupt=[]` and of a targeted `hooks.state.<key>.enabled=false` command-line override left this hook enabled; these overrides are not the solution.
- Do not trust, bypass, or disable all hooks. Prefer an isolated Orca dev profile and a supported targeted disable of only this `Interrupt` hook. Codex's `config/batchWrite` is already used by Orca's own `codex-app-server-client.ts`; its `hooks.state.<quoted key> = { enabled: false }` form is demonstrated by `codex-user-hook-trust-rebase-client.ts`. Use it only against the verified isolated home, never the default Orca or system Codex home. Do not write `trusted_hash` for the unrelated hook.
- Before any targeted edit, prove the dev Electron process resolved `userData`, `ORCA_USER_DATA_PATH`, `CODEX_HOME`, auth/config/hook/DB/log paths and loopback endpoint to dedicated paths. Resolve real paths and reject symlink/junction escapes. Record redacted file metadata and hashes, never credential contents. After the edit and immediately before dispatch, use the exact worker home and cwd with Codex `hooks/list`: eight Orca hooks must retain their original keys/hashes/trust/enabled state; only `Interrupt` may become disabled and stay untrusted. Verify the same inventory against the actual worker PID/home after launch. A profile mismatch, new hook or re-mirror that re-enables it fails A10.
- `hooks/list` inventory alone does not prove the previous `agent_prompt_blocked` was caused only by `Interrupt`. A successful new prompt delivery with no hook-review screen is the causal check; preserve the prior failure as an observation until then. If targeted disable fails or the hook remains unavoidable, stop before trust and ask the user.
- Inspect active Codex profile/config layers and actual launched process executable, version, argv and environment path markers without printing secrets. A banner or path lookup alone is not proof of the worker executable.

### A1.2 Explicit Codex permission mode in native workerStart

- Source evidence: `src/shared/default-global-settings.ts` starts with `DEFAULT_TUI_AGENT_ARGS`, and `src/shared/tui-agent-permissions.ts` maps Codex YOLO to `--dangerously-bypass-approvals-and-sandbox`; previous TUI confirmed effective YOLO. `orchestration.workerStart` currently accepts agent/model/effort but no permission mode. `OrcaRuntimeService.resolveAgentTerminalCreateOptions` builds startup command from global settings defaults.
- Extend the **native** worker-start contract with conceptual `READ_ONLY | WORKSPACE_WRITE | FULL_ACCESS`, but implement only `READ_ONLY` in this slice. Explicitly reject the other two modes, unknown values, unsupported agents, remote/SSH targets, existing-terminal reuse and new-worktree paths before creating any terminal/dispatch. Legacy requests without a mode keep legacy behavior and are never described as read-only.
- For Codex on a newly created local worker terminal, `READ_ONLY` must override the global YOLO default with the installed CLI's supported `--sandbox read-only --ask-for-approval never`; reject any conflicting custom launch args or unsupported binary/version. The capability handshake is **mandatory** before sending `READ_ONLY`: an absent, old, unknown or mismatched host capability rejects locally before RPC/terminal creation. Do not rely on an optional field on legacy `orchestration.workerStart`: an old host strips it and could launch YOLO. Give explicit-permission launches a versioned RPC method with a **required** mode (for example `orchestration.workerStartWithPermissionV1`), while keeping legacy `workerStart` unchanged. An old host must reject the new method even if a capability check races. The new host validates mode and placement before any terminal/dispatch side effect. Test old host, omitted/unknown mode, unsupported agent, remote/SSH, existing-terminal reuse and new-worktree paths. Reuse startup-plan construction; do not mutate global defaults.
- A launch receipt records requested/applied permission **configuration** only. Effective `READ_ONLY` is a separate verified state. In the actual Codex worker, perform mandatory deterministic create/modify/delete attempts against pre-created disposable targets outside all protected repos; compare pre/post bytes, reject any successful mutation or approval prompt, and capture the real worker sandbox/session state, argv and denied-operation output. Also prove `worker_done` reaches native Orca host-side authority without weakening the sandbox. If the read-only sandbox denies that IPC, stop and design a separately verified host-side reconciliation path before another canary. Missing runtime permission proof is A9 FAIL.
- Source candidates: `orchestration-worker-start-schema.ts`, `orchestration-worker-launch-preferences.ts`, `orchestration-workers.ts`, `orchestration-worker-topology.ts`, `orca-runtime.ts`, the CLI worker-launch handler, protocol capability and focused tests. `src/main/codex-cli/codex-read-only-app-server-args.ts` already records read-only/never arguments for Codex app-server, but is not a worker-TUI permission proof. Keep the change minimal and review it before wider validation.

### A1.3 Repeat native canary and persistence proof

- Build/run only from the isolated Alpha worktree. Use `ORCA_DEV_USER_DATA_PATH` for a dedicated Orca dev profile; `configureDevUserDataPath` uses it only for dev builds, and the packaged app ignores inherited `ORCA_USER_DATA_PATH`. `orca serve` binds `0.0.0.0` by default. Prove the dev process actually uses the dedicated profile, loopback-only endpoint and profile-local DB before task creation. Import/authenticate Codex through Orca-supported mechanisms; never manually copy or print credentials.
- Create a **new** native Run/Task/Dispatch against the clean smoke repo, `workerStart(agent=codex, permissionMode=READ_ONLY)`, bounded read-only objective and no requested model. Capture exact process path/version, effective sandbox/approval status, provider session identity if reported, result and actual model only if positively identified.
- Read `workerShow`, `workerRead`, Task/Run state and SQLite result. Reopen the DB/runtime and read the same completed result. Check smoke repo clean and original 11 WIP hashes unchanged. Investigate the prior Orca main-process exit from lifecycle logs, process ownership and Event Log; record a positive disposition and a restart test. If cause remains unknown, A5/A8 are not considered fully proven and F1 is held.
- If Codex's read-only sandbox denies the required Orca `worker_done` IPC, do not weaken its sandbox; report the exact failure, then assess the smallest host-side result reconciliation path before retrying.

### A1 gate and stop

Require A0 original WIP, A1 native authority, A2 actual Codex process/executable/home, A3 coherent identities, A4 result, A5 completed result after reopen plus runtime-exit disposition, A6 smoke clean, A7 regression, A8 complete evidence/provenance, A9 actual read-only enforcement, A10 exactly targeted hook disable/no trust expansion. Each gate needs one concrete evidence artifact with command/exit/path/ID. `UNKNOWN`, missing proof, or test not run is FAIL for every A0–A10 gate. Any non-PASS stops before F1; no automatic trust decision, broad/full-access run or Slice B UI.

| Gate | Required primary artifact before PASS |
|---|---|
| A0 | Original-versus-snapshot SHA-256 table for all 11 WIP files before and after; Alpha Git status. |
| A1 | Profile-local `orchestration.db` Run/Task rows, queried read-only, and resolved Electron user-data path. |
| A2 | Actual worker PID, executable path/version, parent chain, argv and `CODEX_HOME` path marker; no guessed binary. |
| A3 | Same Run/Task/Dispatch/Worker foreign-key/identity chain in native DB and CLI responses. |
| A4 | Worker task input accepted, Codex output captured, `worker_done`/host settlement, terminal Task state and non-null result. |
| A5 | Fresh process/DB handle returns the identical completed result; prior main-process exit has a supported disposition or a passing controlled restart reproduction. |
| A6 | Smoke-repo HEAD/status/diff before and after; disposable probe fixture hashes separately checked. |
| A7 | Exact targeted test/typecheck/lint/build commands and exit codes; no historical test-count reuse. |
| A8 | Redacted evidence index ties process/profile/hook/config, IDs, commands, result and timing to one canary; unresolved observations fail. |
| A9 | Actual worker sandbox/approval state, no YOLO flag, mandatory denied create/modify/delete probe and successful safe result return. |
| A10 | Before/after `hooks/list` from exact worker home: only `Interrupt` disabled, eight Orca hook identities/hashes/trust unchanged, no new trusted hash or prompt block. |

### F1/F2 only after A0–A10 PASS

- Reuse native `OrchestrationDb` Run/Task/Dispatch/mailbox. Introduce a small `ControlCoreFacade` without replacing native authority. Model `LogicalWorkSession` separately from provider session; add a single-node `WorkGraph` with branch-compatible typed `WorkItem` and structured events. Adapt the existing mailbox; message receipt never grants authority. `CompletionBarrier` accepts only verified work.
- Add `TaskJournal` referencing objective, events, runtime identity, artifacts/evidence, decisions, failures and verification. Add three memory classes; persist `CandidateMemory` separately from Canonical Project Brain. Explicit `PromotionGate` checks provenance, revision/hash and conflict before any canonical mutation. `WorkPacketCompiler` selects bounded context from canonical state without treating injected prompt as source of truth. No autonomous Dreaming, multi-agent fan-out or UI.
- Deterministic F2 tests cover the eight user-specified scenarios: one-node completion; two-branch join; durable scoped QUESTION/ANSWER; message cannot verify another item; TaskJournal; CandidateMemory from evidence; no direct canonical promotion; stale revision conflict. Then run targeted tests, typecheck, lint, build, `git diff --check`; all dependency installs stay in Alpha worktree.

### Review status

OpenCode CLI reviewer approved the first A1 amendment with test notes, but an independent Codex CLI security reviewer returned `BLOCK` for incomplete hook causality/profile isolation, capability negotiation, effective permission proof and fail-closed gates. This revision incorporates those requirements. Re-review before product-source edits; user authorization does not waive hook trust approval or A0–A10.
