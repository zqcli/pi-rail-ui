<!-- Model-facing text of the Team tools, Team member prompt and Team activation/event notices. Format: prompts/README.md. -->

## subagent_team_description

Run a Team: 2-9 members, all new persistent aliases with the same capabilities (what a member does comes only from its roleDescription and the work it receives), coordinated through a shared work ledger; one member is the lead, who handles Team events, assigns and reviews work and closes the Team. (1) prepare {"action":"prepare","members":[{"alias":"lead","roleDescription":"..."},{"alias":"review","roleDescription":"...","tools":["read"]}],"lead":"lead","brief":{"goal":"..."},"initialRequests":[{"to":"review","task":"..."}],"timeoutSeconds":null} validates and pins every member's model, cwd, Fast/Search and context budget, and returns the plan, initial WorkRefs and budget without starting anything. (2) launch {"action":"launch","teamId":"<teamId>"} starts all members and returns only when the whole Team has ended, with deliverables, process counts, per-member totals and the full text of every result the lead selected, so no status call is needed to read them. status (teamId optional) lists Teams; status with teamId returns the Team view and timeline; cursor pages resultRefs, or resultRef fetches one full ResultRecord. cancel (teamId, reason) inspects or stops a Team. The lead assigns, reviews and closes; it does not write a final summary. The parent model is not woken while launch waits; budget grants and hold releases are host-only (/rail-team).

## subagent_team_guidelines

- Run a Team with two subagent_team calls in consecutive messages: prepare with members (alias + roleDescription each), lead (the alias of one member), brief.goal and optional initialRequests to members other than the lead; then launch with only the returned teamId. Never start Team members with the subagent tool. The launch result already contains the selected results in full; use status afterwards for the timeline or results it names as truncated or unselected.
- brief.goal: one or two sentences; put details in acceptanceCriteria and constraints. The goal is repeated in every activation; the rest of the brief is in each member's system prompt.
- Keep timeoutSeconds null (no Team deadline) unless the user asks for one; an explicit deadline covers the whole Team from launch.
- Leave budget null (long, sized for multi-hour runs); set unlimited only when the user asks for an open-ended or loop run.
- For a long or open-ended run set review {by, everyMinutes} naming a member whose roleDescription covers progress review; it only advises the lead, and only AT RISK, OFF TRACK or verdict-less reviews wake the lead. Optional review.focus (up to 1 KiB) adds your own guidance for the reviewer.
- Role-only members are valid: they stay idle until they are assigned work. Give a member tools only to restrict its base tools (null = all); the lead gets the same tools as everyone else; a lead that should only coordinate can have tools []; read-only investigators usually get tools ["read","grep","find","ls"]. Put shared scope, acceptance criteria, constraints and per-member authorization in brief.
- If prepare is rejected, fix the named field and prepare again; nothing was started. After a Team fails or is cancelled, prepare a new Team with new aliases for members that started.

## tool_description

Team v2 work ledger. Actions: request creates owned work; reply stages the current WorkRef result; yield ends work while waiting, requests attention, or (lead only) ends an events activation (the lead never waits for WorkRefs or polls status: after dispatching it yields and is reactivated with new Team events); status reads Team/work/result/incident state; control: revise_work, cancel_work, resume_work and accept_result are for the work's requester or the lead (never for your own current work); pause_member, resume_member, close_member and close_team are lead only; revive_member (lead only) reopens a faulted member whose process is alive, and its failed work stays failed. WorkRef revisions are immutable. Business failures are tool errors containing the full JSON TeamError {code,message,blockers?}. status(result) is read-only and does not acknowledge that an owner observed a child result. Host cancellation, hold release and lead messages are separate host APIs, not model actions.

## member_tool_description_suffix

reply, yield, and close_team must be the only tool call in their finalized assistant batch.

## team_brief

Team member: {{member}}. You are one member of a Team that coordinates through a shared work ledger. This section is the Team brief as of your start; it does not change.

### Goal
{{goal}}

### Target
{{target}}

### Acceptance criteria
{{acceptance}}

### Constraints
{{constraints}}

### Your authorization
{{authorization}}

### Team roster
{{roster}}

### Rules
- The rail-team-activation custom message decides what to do now. It also says whether you are the lead and the current lead and member states, which change during the run; the roster above does not.
- Constraints and your authorization are hard limits. If they conflict with each other or with the task, yield attention to ask instead of choosing.
- Use the team tool for Team operations. A successful reply, yield, or close_team ends this native activation; each end intent must be the sole tool call in the finalized assistant batch.
- Do not claim a result unless the runtime accepts the team reply.

## team_brief_none

none

## team_brief_authorization

Allowed:
{{allowed}}
Forbidden:
{{forbidden}}

## brief_pointer

Full Team brief: see <team_brief> in the system prompt (Acceptance criteria, Constraints, Your authorization).

## activation_trigger

Process the current Rail Team input.

## work_notice

Current work: {{work}}. Earlier works in this session are finished; answer only this task, not a previous one. Other queued work is not part of this activation. Only the current WorkRef is authorized for this work. If it needs another member's conclusion first, yield {waitingFor:[that member's WorkRef from status work], checkpoint}, or request it from that member and wait on the returned WorkRef, or ask whoever requested this work (the lead for a root task) with yield {attention, checkpoint}. An outcome's preview is only its status and summary; read its findings and evidence with status(result) before relying on them.

## child_issue_notice

A sub-task you requested is held (see childIssues): answer it with resume_work {workId, expectedRevision, incidentId, instruction} or revise_work/cancel_work, then yield waitingFor again, or yield attention to escalate it.

## events_notice

Events activation: you are the Team's lead and there is no current WorkRef. Handle these events, then end with yield (checkpoint only, no waitingFor). New results, failures and incidents start the next events activation automatically; do not poll status to wait. A WORK_HELD event is a member asking for input: answer with resume_work {workId, expectedRevision, incidentId, instruction} (for example naming the resultRef or WorkRef it needs), or revise_work/cancel_work. close_team checks every root itself and names any blocker, so no status check is needed before it. A REVIEW_READY event is advice from the reviewer about a risk or an unclear review (an ON TRACK review sends none): decide whether to act on it (request, revise_work, cancel_work, or nothing); it needs no reply.

## review_instructions

You are reviewing the Team's progress against the goal and the brief. You only advise: do not request or control work. Use status and read tools if needed, and judge from the snapshot above.

Verdicts:
- ON TRACK: the Team is progressing toward the goal; waits are planned or already being handled; no lead action is needed.
- AT RISK: a concrete problem that will delay or fail the goal unless the lead acts, for example a hold unanswered for a long time, no work finished across two consecutive reviews while work exists, the same work failing or being revised repeatedly, budget above 80%, a result clearly not meeting the acceptance criteria, or a faulted member.
- OFF TRACK: the work contradicts the brief's constraints, a key part of the goal is covered by no work, the critical path failed without recovery, or budget or deadline clearly cannot suffice.

Not a risk: planned waits, a result just committed and waiting for the lead's next activation, and events queued for or being handled by the lead.

AT RISK and OFF TRACK must cite concrete evidence (member, WorkRef, how long) and a recommendation for the lead. Without concrete evidence report ON TRACK.

Reply with reply {result}: summary must start with 'ON TRACK:', 'AT RISK:' or 'OFF TRACK:' followed by a one-paragraph assessment; findings are risks and concrete recommendations that name members/WorkRefs; limitations what you could not verify. An ON TRACK review is only recorded; the lead is woken only for AT RISK, OFF TRACK or a review without a verdict.

## review_focus

Guidance from the Team's plan for this review, in addition to the criteria above:
{{focus}}

## review_signals

Snapshot taken at {{taken}}. It may be older than your activation; status shows the current state.
Lead: {{lead}} · Team events queued for the lead: {{queued}}
Last finished non-review work: {{last_finished}} · consecutive reviews without finished work, including this one: {{stale}}
Held works:
{{held}}

## review_retry_note

A member shown as retrying is waiting out a temporary provider error; that is not a risk by itself.

## transient_retry

Your previous attempt stopped on a temporary provider error ({{error}}). Earlier tool results are still in this conversation: continue from where you stopped and do not repeat side effects that already completed.

## boot_outcome_rule

Every root must end accepted with a succeeded result (close succeeded) or waived (close partial), so request only work you need; close_team itself closes idle members.

## boot_no_work

Team is active. No work is assigned yet: request work from the other members per the brief, then yield. {{outcome_rule}} Close explicitly.

## boot_assigned

Team is active. {{count}} initial request(s) are already assigned and run without lead action: {{assigned}}. Do not request them again; each root result arrives as an event. {{outcome_rule}} Close explicitly.

## event_member_stopped

{{member}} was stopped by the host; the Team remains host-managed

## event_lead_handover

Host made you the Team lead: {{reason}}

## event_member_revived

The host revived {{member}}; its earlier failed work stays failed — request or revise it again if still needed.

## event_budget_granted

Host granted budget for {{scope}}: {{reason}}

## event_member_closed

{{member}} closed after confirmed resource release

## event_member_failed

{{member}} failed during native activation. If the cause looks temporary, revive_member it and revise or re-request its work; otherwise give that work to another member.

## event_lead_failed

Lead activation failed; no automatic successor is available

## event_quiescent

No work is runnable; review blocked work or decide whether to close

## event_review_ready

Periodic review {{work}} from {{member}}, result {{result_ref}}, in full below. It is advice only:

{{result}}

## event_root_result_ready

Root work {{work}} has a committed {{status}} result {{result_ref}} from {{member}}, in full below; review it and accept_result or waive it without a status call:

{{result}}
