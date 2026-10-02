import type { MemberLoadoutRequest } from "../../tools/subagents/team-protocol";

/** A minimal valid bind loadout for the member (the roster must include it). */
export const loadoutFor = (memberId: string, tools: string[] | null = null): MemberLoadoutRequest =>
	({ tools, brief: { goal: "Test goal." }, roster: [{ id: memberId, rolePreview: "Test role." }] });
