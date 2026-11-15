import { AgentSession, type CompactOptions, type CompactionResult, type ExtensionContext } from "@earendil-works/pi-coding-agent";

interface PreparingRunCompaction {
	_runSystemPromptOptions: unknown | undefined;
	_runAutoCompaction(reason: "threshold", willRetry: false): Promise<boolean>;
}

async function compactPreparingRun(session: AgentSession): Promise<CompactionResult> {
	let result: CompactionResult | undefined;
	let failure = "Nothing to compact (session too small)";
	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "compaction_end" || event.reason !== "threshold") return;
		result = event.result;
		failure = event.aborted ? "Compaction cancelled" : event.errorMessage ?? failure;
	});
	try {
		// Pi 1.5.2 marks the run busy before before_agent_start. Its public
		// compact() aborts and waits for that run, so awaiting it in the hook
		// deadlocks. The native automatic path keeps the run active and owns
		// the same preparation, hooks, persistence, refresh, events and abort signal.
		await (session as unknown as PreparingRunCompaction)._runAutoCompaction("threshold", false);
		if (!result) throw new Error(failure);
		return result;
	} finally {
		unsubscribe();
	}
}

/** Request Rail's pending native repair without aborting a run being prepared. */
export function requestNativeRepairCompaction(ctx: ExtensionContext, options: CompactOptions, beforeStart?: () => void): void {
	const original = AgentSession.prototype.compact;
	const wrapper: AgentSession["compact"] = function (this: AgentSession, ...args) {
		if (this.sessionManager === ctx.sessionManager) {
			if (this.isCompacting) return Promise.reject(new Error("Native repair cannot overlap an active compaction"));
			let preparing = false;
			if (this.isStreaming) {
				// _prepareRun installs these options after before_agent_start;
				// post-run compaction/retry retains them until final settlement.
				preparing = !this.agent.state.isStreaming
					&& (this as unknown as PreparingRunCompaction)._runSystemPromptOptions === undefined;
				if (!preparing) return Promise.reject(new Error("Native repair cannot start during an active response"));
			}
			beforeStart?.();
			if (preparing) return compactPreparingRun(this);
		}
		return original.apply(this, args);
	};
	// In 1.5.2 ctx.compact synchronously invokes session.compact before returning
	// its callback-based operation. Limit the bridge to that invocation; other
	// sessions and ordinary manual compactions retain their original behavior.
	AgentSession.prototype.compact = wrapper;
	try {
		ctx.compact(options);
	} finally {
		if (AgentSession.prototype.compact === wrapper) AgentSession.prototype.compact = original;
	}
}
