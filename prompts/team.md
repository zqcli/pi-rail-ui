<!-- Model-facing text of the Team tools, Team member prompt and Team activation/event notices. Format: prompts/README.md. -->

## subagent_team_description

Run a Team: 2-9 members, all new persistent aliases with the same capabilities (what a member does comes only from its roleDescription and the work it receives), coordinated through a shared work ledger; one member is the lead, who handles Team events, assigns and reviews work and closes the Team. (1) prepare {"action":"prepare","members":[{"alias":"lead","roleDescription":"..."},{"alias":"review","roleDescription":"...","tools":["read"]}],"lead":"lead","brief":{"goal":"..."},"initialRequests":[{"to":"review","task":"..."}],"timeoutSeconds":null} validates and pins every member's model, cwd, Fast/Search and context budget, and returns the plan, initial WorkRefs and budget without starting anything. (2) launch {"action":"launch","teamId":"<teamId>"} starts all members and returns only when the whole Team has ended, with deliverables, process counts, per-member totals and the full text of every result the lead selected, so no status call is needed to read them. status (teamId optional) lists Teams; status with teamId returns the Team view and timeline; cursor pages resultRefs, or resultRef fetches one full ResultRecord. cancel (teamId, reason) inspects or stops a Team. The lead assigns, reviews and closes; it does not write a final summary. The parent model is not woken while launch waits; budget grants and hold releases are host-only (/rail-team).

## subagent_team_guidelines

- Run a Team with two subagent_team calls in consecutive messages: prepare with members (alias + roleDescription each), lead (the alias of one member), brief.goal and optional initialRequests to members other than the lead; then launch with only the returned teamId. Never start Team members with the subagent tool. The launch result already contains the selected results in full; use status afterwards for the timeline or results it names as truncated or unselected.
- Keep timeoutSeconds null (no Team deadline) unless the user asks for one; an explicit deadline covers the whole Team from launch.
- Leave budget null (long, sized for multi-hour runs); set unlimited only when the user asks for an open-ended or loop run.
- For a long or open-ended run set review {by, everyMinutes} naming a member whose roleDescription covers progress review; it only advises the lead.
- Role-only members are valid: they stay idle until they are assigned work. Give a member tools only to restrict its base tools (null = all); the lead gets the same tools as everyone else; a lead that should only coordinate can have tools []. Put shared scope, acceptance criteria, constraints and per-member authorization in brief.
- If prepare is rejected, fix the named field and prepare again; nothing was started. After a Team fails or is cancelled, prepare a new Team with new aliases for members that started.

## tool_description

Team v2 work ledger. Actions: request creates owned work; reply stages the current WorkRef result; yield ends work while waiting, requests attention, or (lead only) ends an events activation (the lead never waits for WorkRefs or polls status: after dispatching it yields and is reactivated with new Team events); status reads Team/work/result/incident state; control: revise_work, cancel_work, resume_work and accept_result are for the work's requester or the lead (never for your own current work); pause_member, resume_member, close_member and close_team are lead only. WorkRef revisions are immutable. Business failures are tool errors containing the full JSON TeamError {code,message,blockers?}. status(result) is read-only and does not acknowledge that an owner observed a child result. Host cancellation, hold release and lead messages are separate host APIs, not model actions.

## member_tool_description_suffix

reply, yield, and close_team must be the only tool call in their finalized assistant batch.

## member_system_prompt

Team member: {{member}}. The rail-team-activation custom message is authoritative for this activation. Use the team tool for Team operations. A successful reply, yield, or close_team ends this native activation; each end intent must be the sole tool call in the finalized assistant batch. Do not claim a result unless the runtime accepts the team reply.

## activation_trigger

Process the current Rail Team input.

## work_notice

Current work: {{work}}. Earlier works in this session are finished; answer only this task, not a previous one. Other queued work is not part of this activation. Only the current WorkRef is authorized for this work. If it needs another member's conclusion first, yield {waitingFor:[that member's WorkRef from status work], checkpoint}, or request it from that member and wait on the returned WorkRef, or ask whoever requested this work (the lead for a root task) with yield {attention, checkpoint}. An outcome's preview is only its status and summary; read its findings and evidence with status(result) before relying on them.

## child_issue_notice

A sub-task you requested is held (see childIssues): answer it with resume_work {workId, expectedRevision, incidentId, instruction} or revise_work/cancel_work, then yield waitingFor again, or yield attention to escalate it.

## events_notice

Events activation: you are the Team's lead and there is no current WorkRef. Handle these events, then end with yield (checkpoint only, no waitingFor). New results, failures and incidents start the next events activation automatically; do not poll status to wait. A WORK_HELD event is a member asking for input: answer with resume_work {workId, expectedRevision, incidentId, instruction} (for example naming the resultRef or WorkRef it needs), or revise_work/cancel_work. close_team checks every root itself and names any blocker, so no status check is needed before it. A REVIEW_READY event is advice from the reviewer: decide whether to act on it (request, revise_work, cancel_work, or nothing); it needs no reply.

## review_instructions

You are reviewing the Team's progress against the goal. You only advise: do not request or control work. Use status and read tools if needed. Reply with reply {result}: summary must start with 'ON TRACK:', 'AT RISK:' or 'OFF TRACK:' followed by a one-paragraph assessment; findings are risks and concrete recommendations that name members/WorkRefs; limitations what you could not verify.

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

## event_budget_granted

Host granted budget for {{scope}}: {{reason}}

## event_member_closed

{{member}} closed after confirmed resource release

## event_member_failed

{{member}} failed during native activation

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
