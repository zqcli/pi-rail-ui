import { createStore, type PrototypePatchTarget } from "../../core/patching";
import type { RailSectionDefinition, RailSectionRange } from "../../rail/rail-section";
import type { Position } from "../../core/utils";

export type TuiCtor = { prototype: any };

export type ScrollView = {
	start: number;
	rows: number;
	lineCount: number;
	width: number;
	leftGutterWidth: number;
	editorTopRow: number;
	editorBottomRow: number;
	footerTopRow: number;
	footerBottomRow: number;
	scrollbar?: ScrollbarMetrics | undefined;
};

export type ScrollbarMetrics = {
	width: number;
	thumbSize: number;
	thumbStart: number;
	maxThumbStart: number;
	maxScrollStart: number;
	xStart: number;
	xEnd: number;
	thumbBar: string;
	trackBar: string;
};

export type ScrollSelection = { anchor: Position; active: Position };

export type ActiveInteraction =
	| { type: "idle" }
	| { type: "selecting"; x: number; y: number; moved: boolean; anchor: Position }
	| { type: "scrollbarDrag"; pointerOffsetRows: number }
	| { type: "footerClick"; x: number; y: number; moved: boolean }
	| { type: "railSectionClick"; section: RailSectionDefinition; x: number; y: number; moved: boolean };

export type ScrollAnimation = {
	startOffsetFromBottom: number;
	targetOffsetFromBottom: number;
	targetStart?: number | undefined;
	lockAtEnd?: boolean | undefined;
	startedAt: number;
	durationMs: number;
	timer?: ReturnType<typeof setTimeout> | undefined;
};

export type HistoryRenderResult = {
	historyChildRefs: any[];
	historyChildEndOffsets: number[];
	historyChildPreviousSectionKinds: Array<string | undefined>;
	historyLines: string[];
	historyRailSectionRanges: RailSectionRange[];
};

export type RenderCache = HistoryRenderResult & {
	historyRevision: number;
	width: number;
	children: any[];
	pendingLines: string[];
	statusLines: string[];
	aboveLines: string[];
	editorLines: string[];
	belowLines: string[];
	footerLines: string[];
};

export type ScrollState = {
	offsetFromBottom: number;
	interaction: ActiveInteraction;
	view?: ScrollView | undefined;
	selection?: ScrollSelection | undefined;
	scrollAnimation?: ScrollAnimation | undefined;
	lockedStart?: number | undefined;
	preferCachedRender?: boolean | undefined;
	historyDirty?: boolean | undefined;
	renderCache?: RenderCache | undefined;
	viewportLayoutSignature?: string | undefined;
	// Memoized composited history rows (gutter + scrollbar). Reused when the
	// rendered history revision and viewport presentation state are unchanged, so
	// footer ticks and cursor blinks skip the per-visible-row composition work.
	viewportRowsCache?: { historyLinesRef: string[]; signature: string; rows: string[] } | undefined;
	selectionAutoScrollTimer?: ReturnType<typeof setTimeout> | undefined;
};

export type ConversationScrollStore = {
	targets: PrototypePatchTarget[];
	states: WeakMap<object, ScrollState>;
	animationTimers: Set<ReturnType<typeof setTimeout>>;
	alternateScreenActive: boolean;
	clearOnNextOverflowRender: boolean;
};

export const getConversationScrollStore = createStore<ConversationScrollStore>("conversation-scroll-patch", () => ({
	targets: [],
	states: new WeakMap<object, ScrollState>(),
	animationTimers: new Set<ReturnType<typeof setTimeout>>(),
	alternateScreenActive: false,
	clearOnNextOverflowRender: false,
}));

export function stateFor(tui: object, store: ConversationScrollStore): ScrollState {
	let state = store.states.get(tui);
	if (!state) {
		state = { offsetFromBottom: 0, interaction: { type: "idle" } };
		store.states.set(tui, state);
	}
	return state;
}
