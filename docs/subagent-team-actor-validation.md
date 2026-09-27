# Team Actor v2：验证报告（§24 100 项）

## 1. 结论

本报告保留规格 §24 的 100 项映射及原测试编号，作为可追溯的覆盖索引（§4–§5），**不把“100 项都有映射”或测试全绿当作无缺陷证明**。上一版 900/900 全绿之后，父 review 仍发现六类缺陷：长错误输出、grant 后 children 展示、子端超大业务参数、关闭退出时限、被取消的导航、启动准入失败清理。本轮逐类修复并补回归（§7.1）；旧测试没有覆盖这些触发条件，不能用旧成绩替代新证据。

父审查者在 repair 代码/测试工作树上亲自执行两次全量验证，均为 **938 passed，0 failed/cancelled/skipped**（§3）。之后一次真实在线运行又暴露 Manager 轮询等待与 launch 面板问题，其修复和 943/943 全量结果见 §7.3。验证后冻结代码与测试，本次只更新文档。词典以实际源码声明和两份父审查日志核对；参数化测试明确列出模板及展开条件，不冒充静态顶层 `test("…")` 声明。

本轮**未验证**的范围：

- 真实在线模型的决策质量。
- TUI 人工验收。
- 长时间（长程）运行与真实负载。
- 跨父进程恢复：规格明确不支持。
- X09 只证明本地长期不返回的工具可以被有界 cancel 并给出诊断，**不**证明一般意义上的死锁已被避免。
- N08 只覆盖运行中阶段的预热决策（§7）。

## 2. 版本与基线

| 项 | 值 |
| --- | --- |
| 原始基线 | `acb612bd5a44bb89c838d35b7d0ae0f1df2413d2`（Team v2 开发开始前） |
| 上一版报告 | `5368b05`（D2b；其开发基线为 D2a `1c38b7a`），记录 900/900，现作为历史成绩保留 |
| 本轮 repair 基线 | `3717416`，包含启动、关闭退出边界和导航修复；本轮验证对象为它加上待提交的 codec/protocol/extension/RPC/Runtime 及相关回归工作树，**不是单独的 `3717416`** |
| 报告固定版本 | 本文编辑时 HEAD 为 `3717416`，源码与测试已冻结，仅补文档；父随后包含 wire 修复、回归与本报告的 Git 提交固定本轮交付版本。不预填尚未产生的提交 hash |
| Node | v24.15.0 |
| Pi | `@earendil-works/pi-coding-agent`、`pi-ai`、`pi-agent-core`、`pi-tui` 均为 0.87.1 |

## 3. 命令与结果

隔离环境的要求：

- 使用全新的临时 HOME 和 agent 目录。
- 清空继承的环境变量，因此不带任何 provider key 或代理。
- 离线运行，关闭遥测，loopback 地址走 `NO_PROXY`。
- 不使用付费或在线模型，不修改 `node_modules`、全局设置或用户会话。

下面的片段在仓库根目录运行，不依赖任何临时脚本：

```bash
run_isolated() {
  local root; root=$(mktemp -d "${TMPDIR:-/tmp}/rail-team-check.XXXXXX")
  mkdir -p "$root/home" "$root/agent"
  env -i PATH="$PATH" TERM="${TERM:-xterm}" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" \
    HOME="$root/home" PI_CODING_AGENT_DIR="$root/agent" PI_OFFLINE=1 PI_TELEMETRY=0 \
    NO_PROXY=127.0.0.1,localhost,::1 no_proxy=127.0.0.1,localhost,::1 \
    npm_config_offline=true npm_config_update_notifier=false "$@"
}
run_isolated npm run check                       # typecheck + npm test
run_isolated env PI_SUBAGENT_DEPTH=1 npm test     # 与嵌套 subagent 深度并存
git diff --check
```

`npm run check` 即 `npm run typecheck && npm test`，其中 `npm test` = `tsx --test "tests/**/*.test.ts"`。父审查使用仓库外的 `/tmp/rail-d2/env.sh`（清空继承环境、创建临时 HOME/agent、支持 `EXTRA_ENV`）；上面的片段可在不依赖该临时脚本时复现同等隔离。父记录的 check 命令为：

```bash
EXTRA_ENV='npm_config_offline=true npm_config_update_notifier=false' /tmp/rail-d2/env.sh npm run check
```

另一轮在同样离线隔离中设置 `PI_SUBAGENT_DEPTH=1` 执行 `npm test`。**以下为父实际全量结果，不是文档更新者重跑或估算的结果；此后仅文档变化，代码/测试未再修改。** exit 来自父执行记录，计数与耗时已核对日志末尾（耗时四舍五入到毫秒）。

| 命令 | exit | tests | pass | fail | cancelled | skipped | todo | duration_ms | 日志 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 隔离环境 `npm run check`（含 typecheck） | 0 | 938 | 938 | 0 | 0 | 0 | 0 | 69752 | `/tmp/pi-rail-review-fixes-check.log` |
| depth 隔离 `PI_SUBAGENT_DEPTH=1 npm test` | 0 | 938 | 938 | 0 | 0 | 0 | 0 | 69335 | `/tmp/pi-rail-review-fixes-depth.log` |

上一版 900 结果移至 §8，不再作为本轮成绩。本次文档交付另做只读词典/矩阵核对和 `git diff --check`，不重新执行测试或改动代码。

本轮 `tests/subagent/team-*.test.ts` 共 17 个文件、219 个展开后用例：208 个字面量名称声明，另有 5 个参数化声明分别展开为 2、2、3、2、2 个用例（11 个）。名称逐项与源码及两份全量日志核对；这不是“新增 219 条”，上一版为 181 条，本轮增加 38 条。

## 4. 测试编号词典

编号规则：文件代码加稳定编号，只在本报告内有效。保留上一版编号及引用；本轮插入源码中的新测试追加新编号，不因文件内位置变化而重排旧编号。字面量名称必须匹配源码，参数化条目则列出源码模板、参数取值和日志中的精确展开名。层级按测试体判定，而不是按标题是否含 `native` 判定：

- **pure**：纯 `TeamRuntime`、scheduler 或 codec。
- **fake**：fake transport、extension host、broker、UI、Pi API 或 fake worker。
- **native**：真实 Pi 0.87.1 子进程加隔离的本地合成 provider。`team-member-driver.test.ts` 中，测试体调用 `createHarness(` 或 `runScopedStopScenario(` 的为 native，其余为 fake；WS 通过真实 Pi CLI 连接 loopback WebSocket。
- **pi-method/fake**：进程内调用真实 Pi `ExtensionRunner`、`AgentSession.navigateTree`/分支摘要、`AgentSessionRuntime.switchSession`/`fork` 方法，但 session 周边上下文、Broker member handle 和摘要 stream 是 fake。导航回归属于此层；既不是纯模拟方法实现，也不是上面的 native provider/CLI 端到端测试。

词典列出全部 Team 测试，以及被引用的非 Team 测试。


**`tests/subagent/team-runtime.test.ts`**

- `RT01` · pure · `P: v2 codec rejects v1 live frames, legacy actions, unknown fields and non-JSON values`
- `RT02` · pure · `P: prepare rejects initial per-member overflow before reserving a Team or changing live state`
- `RT03` · pure · `P: request admission is activation-idempotent and derives identity/root from the binding`
- `RT04` · pure · `A/A09: provider/tool gates require the exact delivered WorkRef; a post-intent continuation stays settling and bounded`
- `RT05` · pure · `C01: an idle paused worker accepts new work without launching it, then resumes unchanged`
- `RT06` · pure · `C02/C03: pause waits for approved native tools, acknowledges every preflight result, and reacquires its permit`
- `RT07` · pure · `C04: member resume does not clear a work hold; exact resume_work and HostControl release are idempotent`
- `RT08` · pure · `C04: member resume and hold-release APIs cannot bypass an exhausted budget hold`
- `RT09` · pure · `X02: a valid staged reply survives a concurrent pause and commits after cleanup`
- `RT10` · pure · `C10: a genuine native provider error outranks a simultaneous pause request`
- `RT11` · pure · `C05/C06: superseded reply evidence waits for cleanup, committed results survive revision, and stale revisions never apply`
- `RT12` · pure · `C07/C08/C10: cancel only the selected subtree, keep same-member roots, and delay dependency outcomes until cleanup`
- `RT13` · pure · `C09: pre-settlement worker transport loss isolates only that member and preserves unrelated queued work`
- `RT14` · pure · `P: exhausted result slots reject request admission without ledger or budget side effects`
- `RT15` · pure · `P: revise_work capacity rejection preserves the current writer, revision and reserved slots`
- `RT16` · pure · `P: native tool-call IDs remain opaque and exact across private preflight/result frames`
- `RT17` · pure · `P: private activate codec validates binding, delivery, nested fields and typed public replies`
- `RT18` · pure · `P: explicit deadline starts at launch admission, while prepare time is unbounded`
- `RT19` · pure · `W: a yielded parent releases its member for a dependent return trip and observes each outcome once`
- `RT20` · pure · `W: an outcome that arrives before yield is not lost and produces one ready activation`
- `RT21` · pure · `W: cycle detection includes parent completion edges and rejects without reserving a wait`
- `RT22` · pure · `W: revision fences an active old WorkRef until native cleanup, then reuses the same member lifetime`
- `RT23` · pure · `W: revising a resolved root preserves its committed result and old review`
- `RT24` · pure · `W: cancelled dependency is not deliverable until the old activation cleanup is confirmed`
- `RT25` · pure · `W: reply refuses a logically cancelled child while its native cleanup is pending`
- `RT26` · pure · `W: native failure faults a worker and terminalizes its other assigned work`
- `RT27` · pure · `W: revision rejects a closed assignee without changing work, results or member state`
- `RT28` · pure · `L: close blockers never expose private activation or delivery IDs`
- `RT29` · pure · `L: close_team refuses faulted worker resources that were never released`
- `RT30` · pure · `L: close_team cannot absorb a worker already closing but not yet released`
- `RT31` · pure · `A: staged reply remains uncommitted through settlement and needs matching native tool-result evidence`
- `RT32` · pure · `A: oversized natural final is protocol-held after cleanup and remains manager-disposable`
- `RT33` · pure · `L: request-before-close blocks close; close-before-request rejects without creating work`
- `RT34` · pure · `L: close_team is a staged Manager decision and reports closed only after all exits are confirmed`
- `RT35` · pure · `L: native failure after staged close converges to failed Team and still permits confirmed exits`
- `RT36` · pure · `C04/G10: hold release rejects manager_unavailable and any release while the Manager is faulted, atomically`
- `RT37` · pure · `C01/C10: re-pausing a parked worker whose resume awaits a permit keeps it parked; repeated resume is a no-op`
- `RT38` · pure · `C08: native settlement releases a still-parked provider gate so cleanup never waits on it`
- `RT39` · pure · `L10/X08: host cancel after a staged close_team keeps the close decision and does not stop the Manager settlement`
- `RT40` · pure · `P/6.1: an unclaimed prepared Team cancels without launch, provider or resource claims`
- `RT41` · pure · `C10/12.5: a real native error after cancel_work is isolated as native_failure, not masked as a policy stop`

**`tests/subagent/team-runtime-scheduler.test.ts`**

- `RS01` · pure · `Runtime event drain reserves one same-member activation and schedules the next only after cleanup`
- `RS02` · pure · `Manager event batches are finite and semantic quiescence remains idle without repeated execution`
- `RS03` · pure · `new Manager events stay in the next sealed batch and faults outrank incidents stably`
- `RS04` · pure · `an internal memberReleased exception is observable as failed and does not become an unhandled effect rejection`
- `RS05` · pure · `G10: Manager native failure parks workers and HostControl cancels without another Manager activation`
- `RS06` · pure · `X08: deadline starts at launch, user cancellation wins later deadline, and an earlier close decision is retained`
- `RS07` · pure · `X09/13.3: host cancel interrupts a running approved tool at once, then terminates a native run that never settles`
- `RS08` · pure · `6.1/6.3: prepared cancel closes only claimed lifetimes and keeps an unconfirmed exit as cleanup_failed`
- `RS09` · pure · `14.4/19.2: a worker native_failure keeps faulted history when host cancel releases its still-owned resource`
- `RS10` · pure · `memberExitConfirmed accepts only an exact faulted unknown-exit lifetime`

**`tests/subagent/team-budget.test.ts`**

- `RB01` · pure · `G05/G08: new child IDs accumulate on the same root until it holds; unrelated roots continue; a root grant resumes the same work`
- `RB02` · pure · `G06: revisions keep accumulating root activations instead of resetting them`
- `RB03` · pure · `G07/G09: new roots cannot evade the Team budget; the Manager gets bounded restricted emergency activations, then only the host`
- `RB04` · pure · `gates: every observable provider request counts, including a retry, and exhaustion is a budget hold`
- `RB05` · pure · `gates: invalid end intents consume tool budget; one charged final attempt lets a legal reply finish`
- `RB06` · pure · `gates: repeated invalid end intents cannot bypass exhaustion; the next attempt and request stop as a budget hold`
- `RB07` · pure · `gates: tool-budget denials that end naturally become a budget hold, not a protocol failure`
- `RB08` · pure · `C04: a parked pause resumed after exhaustion stops at budget, and grants never lift attention or pause holds`
- `RB09` · pure · `X05: root child capacity rejects before admission; grants validate everything before applying anything`
- `RB10` · pure · `X08: host cancel of a budget-held Team explains both causes and later grants are refused`
- `RB11` · pure · `usage: one fold per activation, repeats never double-bill, contextTokens keeps the latest value`
- `RB12` · pure · `journal: bounded critical facts only, written before publish, terminal written once; the generation deactivates permanently`
- `RB13` · pure · `actual Runtime terminal journal records round-trip through the strict history codec`
- `RB14` · pure · `journal: a lost terminal write reports the Team as failed, never as a clean close`
- `RB15` · pure · `journal: a failed result write never publishes the result and fails the Team closed`
- `RB16` · pure · `journal: close decision and grant failures refuse the mutation; launch failure ends the Team as failed`
- `RB17` · pure · `usage: loss keeps observed cost once; settle/lost races and repeats never double-bill; cancellation keeps its cost`
- `RB18` · pure · `9.4: activation input carries the tightest current scope budget summary`
- `RB19` · pure · `grant validation rejects a safe-integer overflow of any raised limit atomically, before the journal`
- `RB20` · pure · `final first-wins: host cancel of an already failed Team keeps failed, its original reason and close decision`
- `RB21` · pure · `G09: a Manager stopped mid-activation by budget does not replay its batch; emergency activations stay bounded`
- `RB22` · pure · `team view and status pages stay inside one private reply frame with maximal roots, grants, incidents and multi-byte text`

**`tests/subagent/team-runtime-properties.test.ts`**

- `RP01` · pure · `X10: fixed-seed random Runtime traces keep every invariant and replay identically`
- `RP02` · pure · `D08: more outcomes than previews or one input can carry stay referenced, unselected ones stay undelivered, and previews are never full results`
- `RP03` · pure · `W02: an unresolved request far behind many newer events remains addressable in the ledger and replies normally`
- `RP04` · pure · `D07/X04: a maximal roster with maximal multi-byte, escape-heavy inputs fits every frame; one byte more is refused before admission`
- `RP05` · pure · `X10 regression: cancelling or superseding held work clears its scheduling hold, so no host hold points at a terminal version`
- `RP06` · pure · `X10 regression: a worker transport loss after a staged yield removes the lost intent's wait edge`
- `RP07` · pure · `13.3/13.5 known failures wake waiters automatically: a settled native error and a successful failed-status reply`
- `RP08` · pure · `13.5: a transport loss with confirmed exit holds the waiting parent once; explicit release keeps AND waits blocked and delivers the unknown outcome with results intact`
- `RP09` · pure · `13.5: an unknown exit keeps cleanup pending, so the dependency hold cannot be released until the exit is confirmed`
- `RP10` · pure · `13.5: releasing an unrelated protocol hold does not acknowledge an unknown child; the parent is held again for that decision`
- `RP11` · pure · `13.3: a normal cancel_work whose native cleanup is confirmed stays a known, automatically deliverable outcome`
- `RP12` · pure · `X01/L03: close_member at every activation latch of its target is blocked until cleanup; after closing, a request is refused without work`
- `RP13` · pure · `X07: a Manager event arriving at any latch of a management activation joins the next sealed batch exactly once`
- `RP14` · pure · `P02/P07: forged identity fields and illegal combinations are refused before state changes; declared optionals accept null`
- `RP15` · pure · `P09: two Teams with the same aliases cannot reference each other's work or results; the other Team is unchanged`
- `RP16` · pure · `W08/W09: failed, cancelled and superseded children are each delivered to the parent; unresolved children block reply with exact blockers`
- `RP17` · pure · `W10: a child of a terminal parent cannot be revised into a new obligation; state is unchanged`
- `RP18` · pure · `A04/A07: after a staged intent new business is ACTIVATION_ENDING; an empty last answer never falls back to earlier text`
- `RP19` · pure · `D04/D05/D06: requests arriving during settling or after idle wake once; a full recipient queue refuses new work but a staged reply still settles`
- `RP20` · pure · `U04/U05: waiting and hold changes advance stateVersion while activity stays idle; reads do not; status pages are bounded with stable cursors`
- `RP21` · pure · `L04/L06/L07/L08: outgoing obligations block close_member, the Manager cannot close itself, close_team linearizes against requests, and succeeded needs accepted succeeded roots`
- `RP22` · pure · `G02/G03/G04: duplicate result/incident facts raise one Manager event; status, no-op controls and an inactive Manager yield create no new activation`
- `RP23` · pure · `A05: a staged worker reply followed by a native error is never published as a clean result and isolates only that member`
- `RP24` · pure · `19.1: the Team status text shows lifecycle, health, member activity/pause, current WorkRef and task, queue/hold counts, policy, incidents and budget`
- `RP25` · pure · `W07: re-yielding on an already delivered, unchanged outcome is NO_NEW_DEPENDENCY and schedules nothing`
- `RP26` · pure · `W01/W03/D01: identities come from the binding; a legal R1→R2→R3 chain back to the first member is accepted; an outcome is not delivered before input_ready`
- `RP27` · pure · `P05/P06: late frames from a finished activation never touch the current work; duplicate input_ready/settle/cleanup settle once`
- `RP28` · pure · `A08/G01: a Manager natural answer leaves the Team active with an idle Manager, no summary, no close and no polling activation`
- `RP29` · pure · `D10/L05: after its author is closed and released, a resultRef stays readable and acceptable without waking the author`
- `RP30` · pure · `P08: every retired v1 action and field returns its migration error from the Runtime and changes nothing`
- `RP31` · pure · `A06: a last real answer without an intent becomes natural_final only for the current version with no unresolved children`

**`tests/subagent/team-member-driver.test.ts`**

- `DR01` · native · `N09 driver policy mismatch is rejected before claiming or opening a native member lifetime`
- `DR02` · native · `real Pi 0.87.1 Team v2 lifetime supports W1/W2 return-trip work with settled cleanup on one session per member`
- `DR03` · native · `real Pi Runtime scheduler completes request, reply, Manager acceptance, close_team, and confirmed member exits`
- `DR04` · native · `TeamMemberDriver.stopTeam cancels a prepared Team without provider calls and closes only the opened lifetimes`
- `DR05` · native · `TeamMemberDriver.stopTeam cancels a launched native lifetime directly`
- `DR06` · native · `Rail stop of one live Team worker fails only its work while an unrelated worker root continues`
- `DR07` · native · `Rail delete confirms the stopped Team member exit before removing its descriptor/session, with no late resurrection`
- `DR08` · native · `Rail stop of the Manager marks ManagerUnavailable and pauses workers without ending the Team`
- `DR09` · native · `real Pi rejects flat close_team when another tool shares the finalized assistant batch`
- `DR10` · native · `real Pi pauses a partially preflighted tool batch, accounts for both tool_results, then resumes the same WorkRef`
- `DR11` · native · `real Pi pause requested while a reply is being staged lets the reply commit without aborting the native run`
- `DR12` · native · `real Pi X09: a tool ignoring abort is terminated after the stop bound, releases its owner, and allows an explicit ordinary reopen`
- `DR13` · native · `real Pi revision interrupts the old scope's running tool and runs the new revision only after cleanup`
- `DR14` · native · `real Pi work cancellation interrupts only the selected root's running tool and preserves another root on the same member`
- `DR15` · fake · `Manager cleanup failure returns failed after worker exits while retaining the unknown Manager lifetime`
- `DR16` · fake · `an internal cleanup transition error is fail-closed, visible, and allows other exits to converge`
- `DR17` · fake · `prepared stopTeam waits for an in-flight open, closes that late handle, and never opens a new lifetime`
- `DR18` · fake · `a confirmed-exit worker fault releases its Broker owner once; Team cancel and shutdown never re-close it`
- `DR19` · fake · `an unknown-exit worker fault keeps its owner through Team cancel; only an explicit retry reconciles the late exit`
- `DR20` · fake · `a normal close whose private unbind fails releases the exited resource but the Team is failed, not closed`
- `DR21` · fake · `launch failure preserves the original error and detaches the never-started executor`
- `DR22` · native · `TeamMemberDriver.close retains a failed member handle for a confirmed retry`
- `DR23` · fake · `a pre-settlement native send failure is isolated without inventing native completion or retaining the running slot`
- `DR24` · native · `real Pi automatic retry remains inside the Team native run and settles one activation`
- `DR25` · native · `real Pi budget safe stop: the root model budget stops after the running step, and a host root grant continues the same WorkRef`
- `DR26` · native · `real Pi A09: a third-party continuation after a staged reply stays settling, is refused new side effects, is budget-bounded, and commits the intent once`
- `DR27` · native · `real Pi tool budget: invalid end intents are counted native steps and one final legal reply still settles`
- `DR28` · native · `real Pi Manager budget stop mid-activation: the batch is not replayed and the emergency follow-up is bounded`
- `DR29` · native · `real Pi Manager budget: an exhausted Manager gets a restricted emergency activation that can accept and close but not request`
- `DR30` · native · `real Pi threshold compaction occurs inside a Team activation without losing provider/native ownership`
- `DR31` · native · `real Pi rejects a non-sole end intent and Runtime commits only the true natural final`
- `DR32` · native · `normal Team close preserves the native session and descriptor for ordinary history reopen`
- `DR33` · native · `N01 real Pi: BOOT and initial work run while a role-only writer receives no placeholder provider request`
- `DR34` · native · `N03 real Pi: four workers yielding for the eighth free their permits, the eighth runs, and the Manager never uses a worker permit`
- `DR35` · native · `N06 real Pi: after a canonical context_edit and threshold compaction the current WorkRef, checkpoint and resultRef continue without reviving the deleted input`
- `DR36` · native · `N10/U10 real Pi: the writer asks an idle reviewer in its same session, the Manager closes on the writer's result without a summary, and all resources converge`
- `DR37` · native · `P01 real Pi: a v2 parent refuses a child exposing only the v1 Team command before any command, prompt or provider call`
- `DR38` · native · `N08 real Pi: with cache warming configured and worthwhile, a Team binding stops the in-run warm refresh without touching settings; the same session warms once ordinary`

**`tests/subagent/team-rpc-v2.test.ts`**

- `RV01` · fake · `native Team run may exceed the five-second ACK bound and still waits for real agent_settled`
- `RV02` · fake · `Team command application ACK still fails closed at the independent five-second timeout`
- `RV03` · fake · `an explicit abort requests native cancellation but still waits for Pi agent_settled`
- `RV04` · fake · `terminate stops a native run that ignores abort and reports confirmed exit through the pending send`
- `RV05` · fake · `terminate with an unconfirmed exit keeps the send's resource as not released`
- `RV06` · fake · `usage observed before a transport loss is frozen into the activation failure`
- `RV07` · fake · `an aborted activation reports the usage it already consumed, and events after agent_settled are not added`
- `RV08` · fake · `identical child requests are idempotent, stale sequence replies do not execute, and ACK duplicates are diagnosed`
- `RV09` · fake · `late private requests from the just-closed activation are ignored and diagnosed`
- `RV10` · fake · `opaque native tool-call IDs stay transcript evidence and end intents match the exact executed call/result`
- `RV11` · fake · `a later empty assistant turn preserves exact staged end-intent evidence and supplies the final text`
- `RV12` · fake · `flattened close_team control is recognized as a terminating native intent`
- `RV13` · fake · `pending private requests are never evicted and requests older than the bounded completed cache are not re-executed`
- `RV14` · fake · `a stop/exit failure propagates from send and close instead of reporting a released resource`
- `RV15` · fake · `native 6 KiB proxy failures retain private evidence and project bounded public diagnostics without protocol faults`
- `RV16` · fake · `private frame size includes the native tool-call evidence stripped before core codec parsing`
- `RV17` · fake · `parent Runtime revalidates business input independently, with no business state change or connection fault`

**`tests/subagent/team-extension-v2.test.ts`**

- `EX01` · fake · `Team v2 tool schema is a strict action union and bind selects role-specific tools`
- `EX02` · fake · `flat close_team control is rejected before RPC when its native assistant batch has another tool`
- `EX03` · fake · `native custom activation is persisted and verified before input_ready/provider_gate; repeats are idempotent`
- `EX04` · fake · `wrong native context aborts before private readiness or provider continuation`
- `EX05` · fake · `business tool errors retain the structured TeamError JSON including its code`
- `EX06` · fake · `execute rejects malformed and oversized business arguments locally, and the same activation accepts a corrected call`
- `EX07` · fake · `child validation keeps flat control wire arguments for independent parent normalization`
- `EX08` · fake · `host API exceptions produce bounded valid negative command ACKs`
- `EX09` · fake · `oversized local reply can be corrected in the same connected scope and committed through Runtime`

**`tests/subagent/team-tool.test.ts`**

- `TT01` · fake · `prepare validates and pins the complete member policy without starting a provider`
- `TT02` · fake · `N09 resolves native/default and trust-aware context reserves, pins policy, and refuses drift before opening`
- `TT03` · fake · `historical status pages result refs, keeps full records out of details, and fetches one explicit result`
- `TT04` · fake · `pre-aborted launch performs no opens, retains prepared policy, and can be retried`
- `TT05` · fake · `launch waits for the full Team lifetime and passes only the prepared member requests`
- `TT06` · fake · `runtime launch abort is a structured tool error, preserves host control, and cannot update a retired generation`

**`tests/subagent/team-command.test.ts`**

- `TC01` · fake · `rail-team registers ID/subcommand completion and prints every root budget`
- `TC02` · fake · `budget grants show exact impacts and require confirmation; headless UI cannot mutate`
- `TC03` · fake · `host messages are confirmed and become explicitly attributed Manager events`
- `TC04` · fake · `cancel of a prepared Team is explicitly confirmed and closes resources without a provider`

**`tests/subagent/team-history.test.ts`**

- `TH01` · pure · `history retains bounded worker-authored ResultRecords and validates terminal close association`
- `TH02` · pure · `a close decision with a mismatched terminal closeId remains interrupted`
- `TH03` · pure · `U08: retired v1 snapshots and launched v2 Teams without a terminal are read-only interrupted; damaged records are skipped`
- `TH04` · pure · `interrupted history never accepts a later terminal or malformed grant`

**`tests/subagent/team-index-lifecycle.test.ts`**

- `TI01` · fake · `installRailSubagent lifecycle hooks seal each generation and suppress late callbacks after tree/switch/shutdown`

**`tests/subagent/team-integration.test.ts`**

- `TG01` · fake · `session host journals interruption before cleanup and seals its branch generation`
- `TG02` · fake · `interruption journal write failure is surfaced as a host diagnostic while native cleanup still runs`
- `TG03` · fake · `post-tree fallback retires the old writer without appending into the new leaf`

**`tests/subagent/team-websocket-integration.test.ts`**

- `WS01` · native · `Stage B Team v2 actors use the configured Responses WebSocket for native input and tool settlement`
- `WS02` · native · `Stage B Team v2 cancellation aborts a held native WebSocket run without another provider request`

**`tests/subagent/team-codec-bounds.test.ts`**

- `CB01` · pure · `6 KiB provider/host errors need bounded output projection, not relaxed private validation`
- `CB02` · pure · `error replies and ACK diagnostics remain valid for empty, malformed-Unicode and escaped host errors`
- `CB03` · pure · `65 and 512 owned children project to bounded previews, with complete refs in parent-labelled work pages`
- `CB04` · pure · `activation projection budgets combined errors and previews, without dropping mandatory task/brief or claiming omitted delivery`
- `CB05` · pure · `schema-valid ~1.32 MB result is INVALID_ARGUMENT before a private frame can be built`
- `CB06` · pure · `business normalization rejects UTF-8, escaped-content and combined-result overflows independently of schema`
- `CB07` · pure · `omission metadata is strict, and projection retains detached copies of child references`

**`tests/subagent/team-runtime-bounds.test.ts`**

BD03/BD04 来自同一个循环内的模板声明 `Runtime: ${maximal ? "maximal inputs and 40 failure outcomes" : "host grant and 65 children"} paginate and observe every outcome before reply`，循环参数为 `[false, true]`。下列两条名称是日志中的实际展开名，不是源码中的两个静态顶层声明。

- `BD01` · pure · `Runtime: 6 KiB native failure automatically wakes its parent; all public views remain parseable and evidence stays exact`
- `BD02` · pure · `Runtime: legal failed business result keeps its full 8 KiB summary, with bounded status/work/outcome diagnostics`
- `BD03` · pure · `Runtime: host grant and 65 children paginate and observe every outcome before reply`（参数展开：`maximal=false`）
- `BD04` · pure · `Runtime: maximal inputs and 40 failure outcomes paginate and observe every outcome before reply`（参数展开：`maximal=true`）
- `BD05` · pure · `Runtime: malformed-Unicode transport diagnostics preserve exact evidence; unknown outcomes still require Manager release`
- `BD06` · pure · `Runtime: cleanup errors and journal reasons are bounded only at public exits`
- `BD07` · pure · `Runtime: revised work projects its prior failure without changing the immutable result`
- `BD08` · pure · `Runtime: long malformed-Unicode driver startup errors still consume the failed attempt and retain first-wins cleanup`
- `BD09` · pure · `Runtime: many cleanup-failure notices with maximal brief/roles are sealed into bounded exact Manager batches`

**`tests/subagent/team-lifecycle-regressions.test.ts`**

LC04/LC05 是模板 `host ${mode} during member startup wins a later bind failure and drains every opening handle` 在 `mode ∈ ["cancel", "interrupt"]` 下的展开；LC07/LC08 是模板 `all opened handles are cleaned when ${rejection} rejects final launch admission` 在 `rejection ∈ ["journal", "inactive journal"]` 下的展开。其余为字面量声明；LC06 使用 fake worker 和 mock timers，不等待真实 Pi 进程退出。

- `LC01` · pure · `a pure prepared startup failure needs no native executor, fails its work, and preserves the first terminal decision`
- `LC02` · pure · `a startup failure report cannot overwrite an already committed Manager close decision`
- `LC03` · fake · `member bind failure fails startup, retains its original cause, and records confirmed cleanup without a phantom owner`
- `LC04` · fake · `host cancel during member startup wins a later bind failure and drains every opening handle`（参数展开：`mode="cancel"`）
- `LC05` · fake · `host interrupt during member startup wins a later bind failure and drains every opening handle`（参数展开：`mode="interrupt"`）
- `LC06` · fake · `Runtime waits past 5s for the Broker's bounded transport exit and releases each owner once`
- `LC07` · fake · `all opened handles are cleaned when journal rejects final launch admission`（参数展开：`rejection="journal"`）
- `LC08` · fake · `all opened handles are cleaned when inactive journal rejects final launch admission`（参数展开：`rejection="inactive journal"`）
- `LC09` · fake · `launch admission failure retains an unknown exit and reconciles a later confirmed exit without restarting or double release`

**`tests/subagent/team-navigation-regressions.test.ts`**

NV01–NV03 是模板 `native ExtensionRunner later session_before_${kind} cancellation leaves a fresh current-branch Team host` 在 `kind ∈ ["tree", "switch", "fork"]` 下的展开；NV04/NV05 是模板 `native tree summary ${outcome} without session_tree leaves the current branch ready for a new Team` 在 `outcome ∈ ["aborted", "error"]` 下的展开。测试调用真实 Pi 方法，但使用 fake 上下文、member handle 和合成摘要 stream，**不是 native provider/CLI 测试**。

- `NV01` · pi-method/fake · `native ExtensionRunner later session_before_tree cancellation leaves a fresh current-branch Team host`（参数展开：`kind="tree"`）
- `NV02` · pi-method/fake · `native ExtensionRunner later session_before_switch cancellation leaves a fresh current-branch Team host`（参数展开：`kind="switch"`）
- `NV03` · pi-method/fake · `native ExtensionRunner later session_before_fork cancellation leaves a fresh current-branch Team host`（参数展开：`kind="fork"`）
- `NV04` · pi-method/fake · `native tree summary aborted without session_tree leaves the current branch ready for a new Team`（参数展开：`outcome="aborted"`）
- `NV05` · pi-method/fake · `native tree summary error without session_tree leaves the current branch ready for a new Team`（参数展开：`outcome="error"`）
- `NV06` · pi-method/fake · `native repeated navigation cannot skip a sealed host with unknown exits; only confirmed cleanup admits a fresh generation`

**`tests/subagent/session-broker.test.ts`**

- `SB01` · fake · `ordinary dispatch preserves the native run and usage objects`
- `SB03` · fake · `Team v2 open reserves one alias across startup and competing opens cannot remove the owner's lock`
- `SB04` · fake · `Team v2 startup cancelled by broker shutdown retains the persistent session but never returns a live handle`
- `SB06` · fake · `failed Team v2 binding keeps ownership until process exit, then permits an ordinary history reopen`

**`tests/subagent/tool.test.ts`**

- `TL05` · fake · `control mode steers and queues follow-ups for an active persistent target`
- `TL10` · fake · `grouped tasks forward independent fastMode policies to stateless and new persistent dispatches`
- `TL22` · fake · `model plus alias creates a persistent session and target continues it`
- `TL24` · fake · `parallel parent content is fair and details keep a bounded retained answer`
- `TL30` · fake · `model without alias or session runs stateless and creates no broker instance`
- `TL36` · fake · `chain mode preserves ordering and substitutes the previous final output`

## 5. 100 项映射

保留上一版全部 100 个场景 ID、原引用及其断言范围，在相关行追加本轮 repair 引用。“层”列按引用测试分层标注，只表示“至少一条引用属于该层”，不表示每个断言步骤都在该层完成。N09 的分层另见行内说明。映射完整性只是索引检查，不能证明输入组合、异常路径或真实运行无缺陷；本轮六类反例见 §7.1。

### P. 协议与身份

| ID | 层 | 测试编号 | 实际断言 |
| --- | --- | --- | --- |
| P01 | fake + native | `DR37`, `LC03` | DR37：v1 握手在任何 command、prompt 或 provider 调用之前明确失败，子端活动日志为空。LC03 补充 fake v2 bind 失败的启动清理，保留原错且 provider=0；不把它当 v1 原生握手证据 |
| P02 | pure | `RP14`, `RT03` | 伪造的 role、epoch、跨 Team binding 被拒；Team 快照逐字节不变；requester/root 只来自 binding |
| P03 | pure + fake | `RT03`, `RV08` | 相同 rpcId 返回同一个 receipt，只有一份 WorkRecord 和一个 accepted 事实 |
| P04 | pure + fake | `RT03`, `EX03`, `BD01`, `BD05` | 相同 ID、不同内容返回 `PROTOCOL_FAILURE`，业务快照不变；同一 commandId、不同 canonical 内容的 bind 被拒。补充长错误原始尾部不同不能因公开截断相同而被当作重复证据 |
| P05 | pure + fake | `RP27`, `RP14`, `RV09`, `RT11` | 旧 activation 晚到的 reply 被拒；当前工作保持 running，没有 resultRef；过期 epoch 被拒；快照不变 |
| P06 | pure + fake | `RP27`, `EX03`, `RV08`, `BD01`, `BD05`, `LC09` | 重复的 bind/activate/input_ready/settle/cleanup/deactivate 都只结清一次；重复 ACK 有诊断；结果只有一份。补充长/非法 Unicode 错误证据重复及启动失败后的晚到退出无双释放 |
| P07 | pure + fake | `RT01`, `RT17`, `RP14`, `CB05`, `CB06`, `EX06`, `EX07`, `EX09`, `RV17` | 未知字段、非 JSON 值、互斥字段被拒；声明为可选的字段接受 null。补充字符 schema 可放行的超大 reply、Unicode/转义/总量校验：子端在 append 前返回结构化业务错误，同 scope 可纠正并提交，连接不 stop，父仍独立校验 |
| P08 | pure | `RP30`, `RT01` | send/report/wait/finish 以及 afterSeq/supersedes/replyTo 各自返回迁移说明（`INVALID_ARGUMENT`）；成员不 fault；快照不变 |
| P09 | pure | `RP15` | 跨 Team 引用返回 `UNKNOWN_WORK`/`UNKNOWN_RESULT`；另一个同 alias 的 Team 快照不变 |
| P10 | fake | `RV13` | pending 请求不被淘汰；超出有界缓存的旧请求不会被重新执行 |

### W. 账本与依赖

| ID | 层 | 测试编号 | 实际断言 |
| --- | --- | --- | --- |
| W01 | pure | `RP26`, `RT03` | requester/assignee/root/parent/depth（0–3）由 Runtime 推导；工作总数与 root 数精确 |
| W02 | pure | `RP03` | 大量新事件之后，未解决的请求仍可在账本中定位并正常 reply |
| W03 | pure + native | `RP26`, `RT19`, `DR02` | R1→R2→R3→R4 回到首个成员的链被接受（不按成员环拒绝）；真实 Pi 中完成 W1/W2 往返 |
| W04 | pure | `RT21` | 返回 `DEPENDENCY_CYCLE`；不预留 wait，图与 waitingFor 不变 |
| W05 | pure | `RT21` | parent 的完成约束边参与环检测 |
| W06 | pure | `RT20` | 结果早于 yield 到达时只交付一次，产生一个 ready activation |
| W07 | pure | `RP25` | `NO_NEW_DEPENDENCY`；快照不变；之后没有新 activation |
| W08 | pure | `RP16`, `BD01`, `BD02`, `BD05` | failed、cancelled、superseded 三种 child outcome 都交付给 parent；补充长已知 provider/业务失败自动交付且不级联 fault，unknown 仍须 Manager 放行 |
| W09 | pure | `RP16`, `RT25`, `BD03`, `BD04` | 分别返回 `UNRESOLVED_CHILDREN`/`UNOBSERVED_CHILD_RESULTS`，blockers 精确列出 child；65 children 或按字节裁剪成多批时，未全部观察前拒绝 parent reply，最后一批 ACK 后可提交 |
| W10 | pure | `RP17` | `INVALID_ARGUMENT`，消息建议新建独立 work；快照不变 |

### D. 交付与容量

| ID | 层 | 测试编号 | 实际断言 |
| --- | --- | --- | --- |
| D01 | pure | `RP26`, `RT04` | 已预约的 outcome 在 input_ready 之前不计入 observedOutcomes，waitingFor 不变；provider gate 返回 `delivery_pending` |
| D02 | pure + fake | `RT04`, `EX03`, `EX04` | canonical 输入核验通过才发 input_ready；gate 在此之前不放行；上下文不符时中止 |
| D03 | native | `DR02` | 每次 activation 恰好一个固定触发 prompt、一条 custom 输入、一次 input_ready；provider 请求中只有一份有效工作输入 |
| D04 | pure | `RP19` | R1 settling 期间入箱的 R2 保持 queued，R1 不变 |
| D05 | pure | `RP19` | idle 判定前后到达的请求两种顺序都只唤醒一次 |
| D06 | pure | `RP19`, `RB09` | 接收方队列满时新请求返回 `REQUEST_QUEUE_FULL`；已暂存的 reply 照常结算 |
| D07 | pure + fake | `RP04`, `CB01`, `CB04`, `CB05`, `CB06`, `BD01`, `BD02`, `BD04`, `BD06`, `BD07`, `BD09`, `RV15`, `RV16`, `EX08`, `EX09` | 保留多字节/重转义输入接受前校验；补充长错误和 8 KiB failed summary 的公开投影、完整 frame 大小、schema 可放行的约 1.32 MB reply、最大必需输入与失败 outcomes/Manager 事件的组合预算。完整结果与必要 task/brief/role 不删除 |
| D08 | pure | `RP02`, `CB03`, `CB04`, `CB07`, `BD03`, `BD04`, `BD05` | 未选中的 outcome 保持未交付；完整 resultRef 可查；预览不是完整结果。补充 grant 后 65 children、精确 parent WorkRef 分页枚举、幂等 omitted 和按字节裁剪；input_ready 只观察实际 input.outcomes，多批全部观察后 parent 才能 reply，unknown 放行约束保留 |
| D09 | pure + fake | `RV02`, `RV14`, `RT13`, `RP08` | ACK 超时明确失败；stop/exit 失败不报告已释放；传输丢失标记 outcomeUnknown；不自动重放 |
| D10 | pure + fake | `RP29`, `TT03` | 作者 closed 后原结果可读、可 accept，不唤醒作者；历史 status 可读取单条完整结果 |

### A. Activation 与原生提交

| ID | 层 | 测试编号 | 实际断言 |
| --- | --- | --- | --- |
| A01 | native | `DR02` | w1 的 3 次 activation 共用同一个 sessionId；成员始终 open，结束后为 idle |
| A02 | pure + fake + native | `RV10`, `RT31`, `DR02` | 结束意图带精确的原生 toolCall/result 证据；settlement 前不提交；真实 Pi 中暂存 reply 后没有额外 provider 轮询 |
| A03 | pure | `RS01`, `RT31` | cleanup 完成前不释放成员预约，也不开始下一次 send |
| A04 | pure | `RP18`, `RT04` | `ACTIVATION_ENDING`/`INTENT_CONFLICT`，不创建工作 |
| A05 | pure | `RP23` | 不发布干净结果；只隔离该成员 |
| A06 | pure + native | `RP31`, `DR31`, `RT32` | 只有当前版本且没有未决 child 时才生成 natural_final；否则进入 protocol hold 并保留 child 义务；超大回答进入 hold |
| A07 | pure + fake | `RP18`, `RV11` | 最后一条回答为空时不回退到早先文本，不生成 resultRef |
| A08 | pure | `RP28` | Team active；成员 open/idle；没有结果、TeamResult 或自唤醒 |
| A09 | pure + native | `RT04`, `DR26` | 保持 settling；新副作用被拒；计入预算；意图只提交一次 |
| A10 | pure | `RS01` | 同一成员同时只有一个 activation 被预约和执行 |

### C. 暂停、修订、取消

| ID | 层 | 测试编号 | 实际断言 |
| --- | --- | --- | --- |
| C01 | pure | `RT05`, `RT37` | 暂停中的成员仍 open；新工作 accepted 但不启动；重复 resume 为 no-op |
| C02 | pure + native | `RT06`, `DR11` | requested 与 confirmed 分开；已开始的工具不被中断；暂停期间 staged reply 照常提交 |
| C03 | pure + native | `RT06`, `DR10` | 部分预检通过后暂停，每个工具都有 toolResult；没有预检互锁；恢复同一 WorkRef |
| C04 | pure | `RT07`, `RT08`, `RB08`, `RT36` | resume 不绕过依赖、预算、attention 或 Manager 故障造成的阻塞 |
| C05 | pure + native | `RT11`, `RT22`, `DR13` | 旧结果只对应旧版本；新版本在旧 scope cleanup 之后才运行（真实 Pi 中中断旧工具） |
| C06 | pure | `RT11` | 过时的 expectedRevision 返回 `STALE_REVISION`，不覆盖较新的任务 |
| C07 | pure + native | `RT12`, `DR14` | 只影响选中的子树；同成员无关 root 保留（真实 Pi 中只中断选中 root 的工具） |
| C08 | pure | `RT12`, `RT24`, `RT38`, `RP11` | cleanup 确认前不交付 outcome、不释放 writer |
| C09 | pure + native | `RT13`, `RT26`, `DR06` | 只隔离该成员；其工作 outcome 明确；无关工作继续 |
| C10 | pure | `RT12`, `RT37`, `RT10`, `RT41` | 重复命令无双计数、双清理或进度重置；原生错误不被暂停/取消掩盖 |

### L. 关闭竞争

| ID | 层 | 测试编号 | 实际断言 |
| --- | --- | --- | --- |
| L01 | pure | `RT33` | `CLOSE_BLOCKED`；请求仍存在且可执行 |
| L02 | pure | `RT33`, `RP12` | `RECIPIENT_CLOSING`；没有新 work |
| L03 | pure | `RP12` | 在 reserved/input_ready/staged/settled 四个 latch 都返回 `CLOSE_BLOCKED`；staged reply 照常提交 |
| L04 | pure | `RP21` | 有 outgoing 待回复请求时返回 `CLOSE_BLOCKED` |
| L05 | pure | `RP29`, `RP12` | 只剩已提交历史结果的作者可以关闭；结果仍可查 |
| L06 | pure | `RP21` | Manager 以 close_member 关闭自己返回 `FORBIDDEN_ACTION`；close_team 不要求 Manager 事先 idle |
| L07 | pure | `RP21` | 已 accepted 的未决请求使 close_team 返回 `CLOSE_BLOCKED`；close_team 提交后同一 activation 的新请求和宿主消息被拒，work 数不变；close_team 要求 worker 无 activation，因此 peer 无法在其后发起请求 |
| L08 | pure | `RP21` | root 未验收或结果为 partial 时，succeeded 关闭返回 `INVALID_TEAM_OUTCOME` |
| L09 | pure + fake + native | `RT34`, `RS08`, `DR15`, `DR22`, `LC06`, `LC09` | 退出确认前不报告 closed；未知退出保留 lease；真实 Pi 中失败的 close 保留句柄供确认重试。LC06 用 fake timers 证明 Runtime 不在 5 秒抢先结束仍在进行的 Broker close，6000 ms 确认后释放一次；LC09 验证未知退出后确认结清 |
| L10 | pure + fake | `RT39`, `RT35`, `DR18`, `RB20`, `LC01`, `LC02`, `LC04`, `LC05`, `LC09`, `BD08` | 无自动 reopen、无重复 release、无错误的 closed success；启动失败不能覆盖先前 host cancel/interrupt 或已提交 Manager close，长诊断不阻断失败清理 |

### G. Manager、预算与循环

| ID | 层 | 测试编号 | 实际断言 |
| --- | --- | --- | --- |
| G01 | pure + native | `RP28`, `RS02`, `DR33` | 全员 idle 时 Team 保持 active；最多一次语义 TEAM_QUIESCENT，之后反复 drain 都没有 activation。Runtime 的定时器只有 `timeoutSeconds` 截止计时器和有界的停止/清理计时器，没有轮询 |
| G02 | pure | `RP22`, `RS03` | 重复的结果/incident 事实只产生一个 Manager 事件 |
| G03 | pure | `RP22` | status、no-op 控制和 ACK 不产生 activation 或业务进展 |
| G04 | pure | `RP22` | 同一批次不自动回队；incident 保持可见 |
| G05 | pure + native | `RB01`, `DR25` | 新 child ID 在同一 root 上累计直到 hold；真实 Pi 中当前步骤安全停止，grant 后同一 WorkRef 继续 |
| G06 | pure | `RB02` | 修订不重置 root activation 计数 |
| G07 | pure | `RB03` | 新 root 不能规避 Team 总预算 |
| G08 | pure + native | `RB01`, `DR25` | 该 root 停止；无关 root 继续；结果和控制可结算 |
| G09 | pure + native | `RB03`, `RB21`, `DR28`, `DR29` | 紧急额度有界；模型不能 grant；之后只剩宿主可操作；批次不重放 |
| G10 | pure + native | `RS05`, `DR08`, `RT36` | needs_attention；worker 在安全点暂停；无自动接任或自唤醒 |

### N. 真实 Pi 0.87.1 集成

| ID | 层 | 测试编号 | 实际断言 |
| --- | --- | --- | --- |
| N01 | native | `DR33` | 只有角色的 writer 没有 provider 调用；其他初始工作正常完成 |
| N02 | native | `DR02` | W1→W2→W1 回问成功；每个成员单一 session；普通 dispatch/control/Fast/model/stop/delete/detach 被 ownership 拒绝 |
| N03 | native | `DR34` | 第 8 个 worker 得到执行机会；Manager 不占用 worker 许可 |
| N04 | native | `DR02`, `DR09`, `DR31` | toolCall 与 toolResult 精确配对；终止后没有额外轮询；非独占批次被拒 |
| N05 | native | `DR24`, `DR30` | 原生 retry/compaction 期间不把第一次 agent_end 当作 settled；结果不重复 |
| N06 | native | `DR35` | canonical context_edit 与压缩之后，当前 work/checkpoint/resultRef 仍有效；被删除的输入不复活 |
| N07 | native | `DR02`, `DR03` | 合成 provider 只根据本次请求可见的消息和成功工具历史决定动作（fixture 不用外部 Map 记忆），即可完成 request→reply→accept→close_team |
| N08 | native | `DR38` | Pi 自身的决策是 warm；Team 阶段没有 cache_warm 使用、没有 maxTokens=1 调用；settings.json 不变；恢复普通使用后同一 session 产生一次 cache_warm。只覆盖运行中阶段的预热决策（见 §7） |
| N09 | fake + native | `DR01`, `DR30`, `TT02` | 真实 Pi harness 中，driver 对 model/contextWindow 不符在打开前拒绝（open 0 次、resource 状态不变），随后合法策略真实打开 1 次；真实 Pi 压缩使用固定的 64000 窗口。prepare 的策略固定、reserve 解析与 launch 前漂移拒绝由 fake broker/host 测试 TT02 覆盖，不是 native |
| N10 | native | `DR36` | writer 报告被提交；Manager 不二次总结；正常 close，资源全部收敛 |

### U. 回归与可观察性

| ID | 层 | 测试编号 | 实际断言 |
| --- | --- | --- | --- |
| U01 | fake | `TL05`, `TL10`, `TL22`, `TL24`, `TL30`, `TL36`, `SB01` | 普通 stateless/persistent/grouped/parallel/chain/control 的公开行为不变（另有全量非 Team 套件全部通过） |
| U02 | fake + native | `DR02`, `SB03`, `SB06` | Team 成员拒绝普通修改；ownership 覆盖 startup 与 unbind；非 Team 目标照常 |
| U03 | fake + native + pi-method/fake | `DR07`, `DR17`, `DR05`, `TI01`, `SB04`, `LC03`, `LC04`, `LC05`, `LC07`, `LC08`, `LC09`, `NV06` | 原回归检查先打断再等待、删除后 descriptor 不复活、shutdown 不返回 live handle；补充 bind/最终准入失败清理所有已打开资源及导航未知退出不能绕过。所测路径无悬挂，不宣称一般无死锁 |
| U04 | pure | `RP20`, `RP24` | activity 不变时 waiting/hold 变化仍推进 stateVersion，读取不推进；状态文本显示原因 |
| U05 | pure + fake | `RP20`, `TT03`, `RB22`, `CB03`, `BD02`, `BD03`, `BD04`, `BD06` | 预览有界；游标稳定；完整 resultRef 可读；最大视图不超出私有帧；grant 后 children 通过带 parent 的 work 分页查全，错误截断不损坏完整业务结果 |
| U06 | pure + fake | `RB11`, `RB17`, `RV06`, `RV07` | usage 每次 activation 只累加一次；contextTokens 取最新值而不相加 |
| U07 | pure + fake + pi-method/fake | `TI01`, `TG01`, `TG03`, `RB12`, `NV01`, `NV02`, `NV03`, `NV04`, `NV05`, `NV06` | 旧 journal generation 永久失活、不写入新分支；追加后续扩展取消 tree/switch/fork、摘要 aborted/error 无 session_tree、重复导航未知退出。清理确认后当前分支可新建 host；NV 使用真实 Pi 方法＋fake 上下文，不是 native provider 验收 |
| U08 | pure | `TH03`, `TH04` | 旧 v1 与没有 terminal 的 v2 记录只读显示为 interrupted/legacy；损坏条目跳过；不恢复 live |
| U09 | native | `DR32` | 普通 reopen 的 provider 看到 `teamCalls = 0`，不带 live Team 工具或旧 activation 权限 |
| U10 | fake + native | `DR36`, `DR19` | listener/timer/native owner 全部收敛；退出未知时明确保留 owner |

### X. 组合与性质测试

| ID | 层 | 测试编号 | 实际断言 |
| --- | --- | --- | --- |
| X01 | pure | `RP12`, `RP01` | 关键 latch 的所有排列下，每一步都通过动态不变量检查（覆盖范围见 §6） |
| X02 | pure | `RT09`, `RT11`, `RP01` | 旧 scope 永不提交当前版本；暂停意图不丢 |
| X03 | pure | `RP01`, `RT21`, `RP16` | 可满足的依赖只唤醒一次，环被拒。环拒绝由确定性测试 RT21 断言，随机游走只断言不变量 |
| X04 | pure | `RP04`, `CB04`, `BD04`, `BD09` | 最大 roster 与最大合法输入/结果下，私有帧与公开输入都不越界；补充最大 brief/role/task 与大量失败 outcomes/错误事件组合，必要内容保留，分批交付 |
| X05 | pure | `RB09`, `RT14`, `RT15`, `RP19` | 容量耗尽时在接受前拒绝；已接受的合法结果仍可结算 |
| X06 | pure + fake | `RV08`, `RV09`, `EX03`, `RP27` | 重复和晚到的 ACK/帧不错投、不双提交、不自发生成新 work |
| X07 | pure | `RP13`, `BD09` | 封存、交付、settling 各边界到达的事件进入下一批，下一批不丢、本批不重复；追加大错误事件按 64 KiB 预算缩小实际封存批次 |
| X08 | pure | `RS06`, `RB10`, `RT39` | deadline、预算、用户 cancel 同时触发时原因与作用域可解释；cleanup 幂等 |
| X09 | pure + fake + native | `DR12`, `RS07`, `RV04` | 有界 cancel、终止并给出诊断。**不**声称一般死锁已被证明不存在 |
| X10 | pure | `RP01`, `RP05`, `RP06` | 固定 seed（60×160 步 + 15×400 步），每步检查不变量；trace 重放一致；断言 outcome-unknown 路径被覆盖；不依赖 LLM |

另有 `WS01`、`WS02` 在真实 Pi + loopback Responses WebSocket 上补充验证原生输入、工具结算与取消，不单独计入某一项。

## 6. I01–I30 覆盖方式

`TeamRuntime.assertInvariants` 由 X10 随机游走每步调用，多数 pure 测试也会调用。它只动态检查以下标签：I01、I02、I04、I06、I07、I08、I09、I11、I13、I14、I15、I16、I17、I20、I24、I26、I27、I28，以及规格 13.5（未确认的 outcome-unknown 依赖不能运行）和“终态版本不带 hold”。**它不覆盖全部 I01–I30。** 其余 12 条由场景测试覆盖：

| 不变量 | 测试编号 |
| --- | --- |
| I03 | `RS01`, `DR02` |
| I05 | `RT33`, `RP21` |
| I10 | `RP22`, `DR02` |
| I12 | `RT19`, `DR34` |
| I18 | `RP28`, `RS02` |
| I19 | `RP22` |
| I21 | `RB03` |
| I22 | `RP21` |
| I23 | `RP14`, `RP15`, `RP17`, `RP30`, `RP25`, `RB09`, `RT14`, `EX06`, `EX09`, `RV17` |
| I25 | `DR35`, `DR30` |
| I29 | `TL05`, `TL22`, `TL24`, `TL30`, `TL36`, `SB01` |
| I30 | `RV13`, `RV02`, `RT13` |

## 7. Repair 修复、历史观察与已知差异

### 7.1 父 review 发现并修复的六类问题

以下问题均未被上一版 900 green 覆盖；100 项映射当时已存在，仍不足以发现这些具体触发条件。本轮不删除旧成绩或改写旧测试的证明范围，而是保留 §5 索引并追加具体回归。表内编号对应 §4 的精确测试名称；参数展开条目不计作新增静态声明。

| 类别 | 旧覆盖缺口与修复后的实际断言 | 回归编号／层 | 相关 §24 场景 |
| --- | --- | --- | --- |
| R1 长 host/provider 错误输出 | 6 KiB provider error、合法 failed result 的 8 KiB summary，以及 Unicode/转义膨胀可能令合法失败的 activate/status 回包变成协议故障。公开 WorkError、previous/member/incident/终态原因和负 ACK 统一有界，保留分类、unknown 与截断提示；完整业务结果和内部证据保留。不同原始错误尾部不被公开截断合并为同一幂等证据。大量错误通知按实际可容纳批次封存。 | `CB01`, `CB02`, `BD01`, `BD02`, `BD05`, `BD06`, `BD07`, `BD08`, `BD09`（pure）；`RV15`, `EX08`（fake） | D07、W08、P04、P06、U05 |
| R2 grant 后 children 展示与交付 | 默认 rootChildren=64 的场景没有覆盖合法 grant 后第 65 个 child。activation 预览 8、详情 refs 64＋omitted；分页摘要 parent 保留精确 WorkRef，完整 ledger 不截断。65 children 和最大输入＋40 个失败 outcomes 均可逐批观察后 reply；ACK 只确认实际 input.outcomes，未知结果仍须明确放行，重复投影不重复累计 omitted。 | `CB03`, `CB04`, `CB07`, `BD03`, `BD04`, `BD05`（pure，BD03/04 为参数展开） | D07、D08、W09、G08、U05、X04 |
| R3 子端原始业务参数校验 | 字符级 schema 可放过约 1.32 MB reply；旧子端直接 append 私有 frame，导致父端按超大协议帧断连接。现在 append 前 codec 验证原始参数的形状、UTF-8/转义与完整 JSON 总量；以结构化 INVALID_ARGUMENT 返回，业务状态不变，同 scope 纠正 reply 后可正常提交，abort/stop=0。父仍独立 revalidate，完整 frame 仍限 1 MiB。 | `CB05`, `CB06`（pure）；`EX06`, `EX07`, `EX09`, `RV16`, `RV17`（fake；EX09 为 extension→fake RPC→Runtime 桥接） | P07、P02、D07、I23 |
| R4 关闭退出时限错配 | Runtime 曾用 activation-stop 的独立 5 秒界限抢先判定 Broker 资源关闭失败。回归在 fake timer 5001 ms 时仍观察 stopping/ownership，transport 6000 ms 确认退出后仅释放一次；未知 exit 仍保留并可在真实确认后结清。不是放宽 ACK 超时。 | `LC06`, `LC09`（fake）；保留 `RV02` 的 ACK 上限回归 | L09、L10、U10 |
| R5 导航未提交后的失活 host | 原覆盖主要检查成功导航/旧 generation 隔离，未覆盖后续扩展取消 tree/switch/fork、摘要 aborted/error 不产生 session_tree，及重复导航遇到未知退出。现在已结束的旧 Team 不复活；确认清理后当前分支可新建 host；未确认退出不因 host 已 sealed 而绕过。 | `NV01`–`NV06`（pi-method/fake；前五项为参数展开） | U07、U03、U10 |
| R6 启动准入失败清理与分类 | 成员 bind 或最终 launch admission 的 journal/失活 writer 失败时，不能遗漏已打开资源、保留可重试 prepared 假象或把基础设施失败伪装用户取消。回归确认 provider=0、原始 cause 与 cleanup failure 分开、失败 attempt 被消费、未知退出保留 ownership；先前 host cancel/interrupt 或 Manager close 决定优先，晚到退出无重启/双释放。driver-only 长诊断也不阻断失败清理。 | `LC01`, `LC02`, `BD08`（pure）；`LC03`, `LC04`, `LC05`, `LC07`, `LC08`, `LC09`（fake；部分参数展开）；`RB16` 保留编号并使用当前源码名称 | P01（启动前拒绝补充）、P06、U03、L10 |

上述新增回归的层级不能替代真实在线模型或完整 TUI 用户流程验证。特别是 NV 标题中的 `native` 表示调用真实 Pi 方法，不表示启动了真实 provider 子进程。

### 7.2 上一版已有修复与继续适用的观察

- **状态展示（规格 19.1）：** 成员行原先只显示当前 WorkRef，不显示任务。现在 live 视图附带每个成员当前 work 的有界任务预览（`tools/subagents/team-tool.ts` 的 `liveView`/`formatTeamView`），由 `RP24` 覆盖。
- **删除 `TEAM_MAX_UI_EVENTS` 与 `TeamUiEvent`：** 二者从未被使用。状态展示直接读取有界的 public snapshot，义务只存在于账本中；`RP03`（W02）证明早期请求不会被事件量挤掉。
- **N08 的观察范围：**
  - rail broker/Team harness 中，原生运行结束后的 idle 阶段没有进入 Pi 的预热决策，普通 reopen 也是如此。
  - 普通 CLI 和直接的 `RpcSessionWorker` 探针中，idle 预热会触发。
  - 已核对子进程参数与环境一致，根因未查明。
  - `DR38` 因此只验证运行中阶段的预热决策：provider 配置 1 s 预热延迟，工具等待 2.5 s。
  - “Team 绑定期间 stop 预热”由 extension 的 `cache_warming_decision` 处理器实现；把该处理器改为不阻止时，`DR38` 失败。
  - 本报告不声称 idle 阶段的预热在 Team 下已被验证。
- **分层差异：**
  - N09 的真实 Pi 部分是 driver 在打开前拒绝和合法策略的真实打开；prepare 阶段的策略固定与漂移拒绝只有 fake 覆盖（`TT02`）。
  - U01 使用 fake broker/worker 的回归套件。
  - NV01–NV06 使用真实 Pi 导航/ExtensionRunner 方法与 fake 上下文；即使标题含 `native`，也不计入 native provider/CLI 层。LC06 使用 mock timers 验证 5 秒与 6 秒边界，不是一次真实进程 6 秒退出测量。
  - `team-member-driver.test.ts` 中的 fake 条目为 `DR15`, `DR16`, `DR17`, `DR18`, `DR19`, `DR20`, `DR21`, `DR23`，其余 DR 条目均为 native。L09、L10、U10 引用的 `DR15`、`DR18`、`DR19` 属于 fake。

### 7.3 实测会话后的面板与 Manager 引导修复

一次真实在线 Team 运行（成功关闭）暴露了以下问题，上述 100 项映射与 938 green 均未覆盖：

- Manager 用带 `waitingFor` 的 yield 等待 worker 被拒后，在同一 activation 内轮询 `status` 约 3 分钟；其间 worker 结果事件无法交付，`close_team` 被 `CLOSE_BLOCKED`。现在管理 activation 的 notice、Manager yield 错误、工具 schema/描述和 close blocker 都明确指引“派发后 yield、由新事件重新激活、不要轮询”；work activation 的 notice 不变。行为约束本身未变。
- 面板只显示计数，不显示已提交结果、Manager 待处理事件和成员运行中的活动（规格 19.1）；launch 结束后成员表被最终文本替换；prepare 面板显示成员表而非固定的计划文本。现在 launch 复用 grouped subagent 面板，每个成员一个子面板（见 actor 文档 §11），成员原生事件由 v2 连接以只读观察者转给 driver，不影响协议；结束后保留成员面板。
- 会话切换时对已 CLOSED 的 Team 补写了 `interrupted` 记录（历史解析仍保留 terminal，但记录错误）。现在只对 active/closing Team 写标记。

新增回归（均在下列全量运行中通过）：

| 测试 | 层 | 覆盖 |
|---|---|---|
| `team-runtime.test.ts` · `Manager guidance: management input says to yield instead of polling, and host panel facts count events and results` | pure | 管理 notice、Manager yield 错误指引、work notice 不变、待处理事件与按作者的结果计数 |
| `team-member-driver.test.ts` · `real Pi member activity feeds the launch panel across activations and freezes live usage at settlement` | native | 真实 Pi 子进程事件进入成员活动；跨 activation 保留；隐藏触发 prompt；结算后不再报告实时用量（不双计）；成员关闭后仍可读 |
| `team-tool.test.ts` · `launch panel reuses grouped subagent panels per member, live and after the Team ends` | fake | 实时与最终 details 含每个成员面板、角色、任务、实时用量、待处理事件；idle 不显示为完成；prepare 面板显示计划文本；details 可序列化 |
| `transcript.test.ts` · `grouped panels show a live idle member as idle, never completed, with its role and state line` | pure | 共享渲染器的 idle 状态、角色标签与状态行 |
| `team-integration.test.ts` · `host shutdown writes no interruption marker for a Team that already ended` | fake | 已结束 Team 不补写 interrupted（撤掉修复时该测试失败） |

本轮隔离环境全量结果：`npm run check` 943/943 通过（74781 ms，`/tmp/pi-panel-check.log`）；`PI_SUBAGENT_DEPTH=1 npm test` 943/943 通过（74341 ms，`/tmp/pi-panel-depth.log`）；均无 fail/cancelled/skipped。未做在线模型或交互 TUI 手工验收；在线 Manager 是否遵循新指引需要实际运行观察。

### 7.4 第二次实测后的 Manager 指引修复

第二次真实在线运行中，Manager 已按新指引派发后 yield、不再轮询；但 BOOT 事件只写“Team is active”，没有告诉它 `initialRequests` 已经派出，它便又向两名 worker 请求了两个重复 root。两名 worker 在交付原始结果后开始重复工作；Manager 取消重复 root 后，`succeeded` 关闭被 `INVALID_TEAM_OUTCOME` 拒绝且没有指出哪个 root，又因重复 root 未 waive 被 `CLOSE_BLOCKED` 拒绝一次，最终以 `partial` 关闭。此外 Manager 先逐个 `close_member` 并多等一轮事件才 `close_team`。

修复（行为约束不变）：BOOT 列出已分派的初始 root（assignee、WorkRef、任务预览）并明确不要重复请求、每个 root 须 accepted 或 waived、`close_team` 自行关闭 idle worker；没有初始工作时提示派发后 yield。`ROOT_RESULT_READY` 注明结果状态和作者。`succeeded` 被拒时以 `root_outcome` blockers 逐个列出阻止成功的 root 并说明 waive → partial；未审阅 root 的 blocker 提示用 accept_result。回归：`team-runtime.test.ts` · `Manager guidance: …`（pure，扩展了 BOOT/结果事件/重复 root 关闭拒绝断言）。

隔离环境全量：`npm run check` 943/943（72135 ms，`/tmp/pi-boot-check.log`）；`PI_SUBAGENT_DEPTH=1 npm test` 943/943（71444 ms，`/tmp/pi-boot-depth.log`）；均无 fail/cancelled/skipped。在线 Manager 是否不再重复派发仍需实际运行确认。

### 7.5 第三次实测后的 launch 最终输出与时间线

第三次真实运行（Team 以 `succeeded` 关闭、未重复派发，证实 §7.4 生效）中，launch 最终文本只有各结果的 summary 预览和 “Limitations: N” 计数，父 agent 于是在 launch 后又调用了 3 次 `status`（team、results、result）读取 findings、evidence 和时序；Team 关闭后 `status` 仍显示 Manager 待处理事件；§8 文档有一行重复。

修复：launch 最终文本像 grouped subagent 一样直接携带结果——Team 结论、roots/works、每个成员的 lifecycle/资源、模型、FAST、轮次、活跃时长与结果数、Runtime 时间线，以及 Manager 选定的每份 worker 结果全文（summary、findings、evidence、limitations、artifacts）。全文受 48 KiB 约束，短结果完整保留，只截断超额的大结果并注明 `status resultRef`。worker 子面板显示其最近结果全文，Manager 子面板显示关闭决定。Runtime 在状态转换处记录仅供显示的有界时间线（launch 与初始派发、request、activation 开始/结束及结束意图、结果提交、accept/waive、cancel、revise、close_team、成员退出、Team 终态；最多 60 条并计省略数，不参与协议、恢复或义务）。Team 结束后 `panelFacts` 不再报告待处理事件。回归：`team-tool.test.ts` · `launch final output carries every selected result in full with a timeline, so no status call is needed`（fake，8 个 root 含 4 个约 11 KB 结果，断言全文、截断提示、时间线结构与 48 KiB 上限）。

隔离环境全量：`npm run check` 944/944（76555 ms，`/tmp/pi-timeline-check.log`）；`PI_SUBAGENT_DEPTH=1 npm test` 944/944（77698 ms，`/tmp/pi-timeline-depth.log`）；均无 fail/cancelled/skipped。

真实在线复测（`pi --no-extensions -e <本工作区>/index.ts --model cus-resp/gpt-6-sol --thinking xhigh -p <用户原始提示>`，worker 由父按提示选 `cus-resp/gpt-6-luna:max` + FAST）：

| 运行 | 代码 | 结果 | launch 后 status 调用 | 观察 |
| --- | --- | --- | --- | --- |
| 1（session `e763707d…`） | `1d23c3c` | CLOSED · succeeded，3 个 root 全部 accepted | 0 | 结果全文随 launch 返回；父指出时间线只有结果提交，不含派发/验收，据此加入 Runtime 时间线 |
| 2（session `55bbcf61…`） | `5710ff0` | CLOSED · succeeded，2/2 root accepted，1:42 完成 | 0 | 时间线含派发、各 activation、结果、accept、close_team 与成员退出；父直接据此报告时序 |

两次均未重复派发、一步 `succeeded` 关闭、Manager 无轮询。运行 2 首次 prepare 因 Manager 别名与既有 persistent 会话重名被拒（未启动任何成员），改名后成功，属预期校验。TUI 面板渲染未做人工验收。

### 7.6 subagent 代码 review 后的改进

对 `tools/subagents/` 全部模块（含 Team）做了针对性 review：未用导出、吞错、定时器、按 Team 保存的状态与清理、父文本预算、实测会话中的 Manager/worker 行为。改进如下（均有回归，改前失败、改后通过）：

- grouped subagent 父文本原先按结果数平分 50 KiB，一份 30 KB 的回答会被截到约 12 KB，而其他短回答留下的额度被浪费。现与 Team launch 共用 `text-budget.ts` 的 `fairShares`：短回答完整保留，只有最长的几份分剩余额度；persistent 回答被截断时注明全文仍在该 persistent session。回归：`tool.test.ts` · `parallel parent content keeps short answers whole and gives their unused budget to a long one`（fake）。
- `TeamMemberDriver` 按 Team 保存的成员活动记录、lifetime promise、已结算集合和启动失败记录从不释放，而 Runtime 只保留有限个已结束 Team；长会话中会持续增长。现在打开新成员时释放 Runtime 已淘汰 Team 的这些记录。回归：`team-integration.test.ts` · `the driver forgets member activity of Teams the Runtime has evicted`（fake）。
- 依赖同伴结论的路径协议早已支持，但提示中未写，实测中 worker 从未使用。work notice 现写明三条路径（直接等待对方 WorkRef、request 对方、attention 请 Manager）；management notice 写明用 `resume_work` 在 instruction 中给出 resultRef/WorkRef 回应 `WORK_HELD`，并说明 `close_team` 自行检查所有 root、关闭前无需 status。时间线新增 “resumed / host released the hold”。回归：`team-runtime.test.ts` · `peer dependency: …`（pure，覆盖经 Manager 转交与直接等待两条路径及时间线）与扩展的 `Manager guidance: …`。

隔离环境全量：`npm run check` 947/947（78799 ms，`/tmp/pi-review-check.log`）；`PI_SUBAGENT_DEPTH=1 npm test` 947/947（75528 ms，`/tmp/pi-review-depth.log`）。加入时间线 “resumed” 后复跑 `npm run check` 仍为 947/947（78443 ms，`/tmp/pi-review-check2.log`）。

真实在线验证（同前的启动方式，父 `cus-resp/gpt-6-sol:xhigh`，worker `cus-resp/gpt-6-luna:max` + FAST，session `b4abc34a…`，提示要求 A 依据 B 的统计结论评估、依赖由团队内部协调）：A 于 0:15 `yield attention`，Manager 0:15 收到 `WORK_HELD`；B 0:22 提交，Manager 0:32 accept 后以 `resume_work` 把 B 的 resultRef、WorkRef 与结论写入 instruction；A 0:47 恢复、3:19 提交；3:45 `close_team succeeded`，3:46 全部释放。依赖经 Manager 正确传递，A 未自行统计；Manager 关闭前仍调用一次 `status`。该运行时间线尚无 resume 行，据此补上。

### 7.7 review 遗留项的处理

- Manager 逐份 `status(result)` 读结果：`ROOT_RESULT_READY` 现直接携带该 root 结果全文（与 launch 最终文本同一格式 `formatWorkResult`）和 resultRef；事件 message 上限相应为 16 KiB（结果 12 KiB 加标题），批次仍受 64 KiB 输入上限约束，放不下的事件留待下一批。回归：`team-runtime.test.ts` · `ROOT_RESULT_READY carries a maximum-size root result in full inside a valid Manager activation input`（pure，并经子进程侧 `parseParentCommand` 校验）与更新的 `Manager guidance: …`。
- “Manager 关闭前查 status”：核对会话后发现两次 status 都是验收前的 `status(result)`，已由上一项消除。
- incident 事件分类（上一轮实测 worker 发现）：除 `BUDGET_HIT`/`WORK_HELD` 外，所有 incident 都以 `DEPENDENCY_UNAVAILABLE` 通知 Manager，成员故障还会与 `MEMBER_FAULTED` 重复。现协议 hold（结果超槽位、未观察 child、无有效 reply/yield、结束意图未确认）经 `holdWork` 统一为 `WORK_HELD`；成员级故障为 `MEMBER_FAULTED`，丢失 activation/清理失败每次只发一个事件。回归：`team-runtime-scheduler.test.ts` · `new Manager events stay in the next sealed batch and faults outrank incidents stably`、`team-runtime.test.ts` · `A: oversized natural final is protocol-held …`。
- 模型引用 provider 写错（实测父 agent 写成 `openai/gpt-6-luna:max`）：错误信息现直接提示同一 model id 的真实 provider。回归：`models.test.ts` · `resolveRailModel names the same model id under its real provider when the prefix is wrong`。
- 删除从未使用的 `TEAM_RESERVED_ACTORS`。
- 不改动并说明理由：`check()` 在 500 个 work 时单次 0.37 ms（本地基准，每次状态转换一次），保留这一不变量安全网；`team-runtime.ts` 拆文件只移动代码，TeamState 为私有状态、方法之间以 `this` 紧密耦合，拆分需要导出内部结构，代码更多而行为不变；其余“未使用导出”都是被导出函数签名引用的类型，保留。

隔离环境全量：`npm run check` 949/949（75502 ms，`/tmp/pi-model-check.log`）；`PI_SUBAGENT_DEPTH=1 npm test` 949/949（73992 ms，`/tmp/pi-model-depth.log`）。

真实在线复测（session `d5018664…`，同一依赖场景，代码为结果内联之后、incident 分类之前）：2:24 以 `succeeded` 关闭；Manager 调用 `accept_result`×2、`resume_work`、`close_team`、`yield`×3，**没有任何 status 调用**；时间线包含 `coord resumed work …`。A 先直接 `yield waitingFor` B 的 WorkRef（0:12），B 0:15 提交后 A 收到 outcome，但按提示词“依赖由团队内部协调”再以 attention 请 Manager 正式转交（0:23），Manager 0:46 resume。incident 分类与模型提示两项仅由测试验证。

## 8. 历史阶段结果（非本轮成绩）

上一版 D2b／`5368b05` 的父全量记录为：

| 历史命令 | exit | tests/pass | fail/cancelled/skipped/todo | duration_ms | 历史日志 |
| --- | --- | --- | --- | --- | --- |
| 隔离 `npm run check` | 0 | 900/900 | 0/0/0/0 | 69179 | `/tmp/pi-rail-final-check.log` |
| 隔离 `PI_SUBAGENT_DEPTH=1 npm test` | 0 | 900/900 | 0/0/0/0 | 68976 | `/tmp/pi-rail-final-depth.log` |

这些 900 green 成绩保留为历史证据，**没有覆盖 §7.1 的六类 review 反例**，不再代表当前工作树。当前成绩仅采用 §3 的两次 938/938。`RB16` 在修复启动失败行为后保留编号，名称从旧版的 `launch failure keeps the Team prepared` 改为当前的 `launch failure ends the Team as failed`；词典使用当前实际存在的完整测试名。

更早的 D1 曾报告 1033 条通过，D2a 为 881/877（后者为 `PI_SUBAGENT_DEPTH=1`）；它们包含已删除的 v1 测试，或早于后续新增回归，仅作历史参考。v1 时期的在线验收与测试数量见各 legacy 文档（`docs/subagent-team-plan.md` 等），同样不是当前结果。
