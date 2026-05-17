import type { PrototypePatchTarget } from "../patching";
import type { RailSectionClickState, RailSectionRange } from "../ui/rail-section";
import type { Position } from "../utils";

export type TuiCtor = { prototype: any };

export type ScrollView = {
	start: number;
	rows: number;
	lineCount: number;
	width: number;
	editorTopRow: number;
	editorBottomRow: number;
	scrollbar?: ScrollbarMetrics;
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
export type ScrollbarDragState = { pointerOffsetRows: number };

export type ScrollAnimation = {
	startOffsetFromBottom: number;
	targetOffsetFromBottom: number;
	targetStart?: number;
	lockAtEnd?: boolean;
	startedAt: number;
	durationMs: number;
	timer?: ReturnType<typeof setTimeout>;
};

export type HistoryRenderResult = {
	historyChildRefs: any[];
	historyChildEndOffsets: number[];
	historyChildPreviousSectionKinds: Array<string | undefined>;
	historyLines: string[];
	historyRailSectionRanges: RailSectionRange[];
};

export type RenderCache = HistoryRenderResult & {
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
	view?: ScrollView;
	selection?: ScrollSelection;
	selecting?: boolean;
	scrollbarDrag?: ScrollbarDragState;
	railSectionClick?: RailSectionClickState;
	scrollAnimation?: ScrollAnimation;
	lockedStart?: number;
	preferCachedRender?: boolean;
	historyDirty?: boolean;
	renderCache?: RenderCache;
	copyTimer?: ReturnType<typeof setTimeout>;
};

export type ConversationScrollStore = {
	targets: PrototypePatchTarget[];
	states: WeakMap<object, ScrollState>;
	animationTimers: Set<ReturnType<typeof setTimeout>>;
};

const CONVERSATION_SCROLL_KEY = Symbol.for("pi-rail-ui.conversation-scroll-patch");

export function getConversationScrollStore(): ConversationScrollStore {
	const globalStore = globalThis as typeof globalThis & { [CONVERSATION_SCROLL_KEY]?: Partial<ConversationScrollStore> };
	const store = globalStore[CONVERSATION_SCROLL_KEY] ?? {};
	store.targets ??= [];
	store.states ??= new WeakMap<object, ScrollState>();
	store.animationTimers ??= new Set<ReturnType<typeof setTimeout>>();
	globalStore[CONVERSATION_SCROLL_KEY] = store;
	return store as ConversationScrollStore;
}

export function stateFor(tui: object, store: ConversationScrollStore): ScrollState {
	let state = store.states.get(tui);
	if (!state) {
		state = { offsetFromBottom: 0 };
		store.states.set(tui, state);
	}
	return state;
}
