import { RailSectionBlock, resolveRailSection, type RailSectionKind } from "../../rail/rail-section";

type RailChatChildOptions = {
	normalizeChild?: ((child: any) => void) | undefined;
	assignTo?: string | undefined;
};

function shouldWrapRailChatChild(child: any): boolean {
	return Boolean(child && typeof child.render === "function" && child.constructor?.name !== "Spacer" && !resolveRailSection(child));
}

function railChatChildBlock(child: any, kind: RailSectionKind, options: RailChatChildOptions = {}): RailSectionBlock {
	options.normalizeChild?.(child);
	return new RailSectionBlock(child, kind);
}

export function withRailSectionChatChildren<T>(
	mode: any,
	kind: RailSectionKind,
	renderChildren: () => T,
	options: RailChatChildOptions = {},
): T {
	const chatContainer = mode?.chatContainer;
	const originalAddChild = chatContainer?.addChild;
	if (typeof originalAddChild !== "function") return renderChildren();

	chatContainer.addChild = function patchedRailSectionAddChild(this: any, child: any) {
		const nextChild = shouldWrapRailChatChild(child) ? railChatChildBlock(child, kind, options) : child;
		return originalAddChild.call(this, nextChild);
	};

	let result: T;
	try {
		result = renderChildren();
	} catch (error) {
		chatContainer.addChild = originalAddChild;
		throw error;
	}

	if (result && typeof (result as any).finally === "function") {
		return (result as any).finally(() => {
			chatContainer.addChild = originalAddChild;
		}) as T;
	}

	chatContainer.addChild = originalAddChild;
	return result;
}

function lastRenderableRailChildIndex(children: any[]): number {
	for (let index = children.length - 1; index >= 0; index--) {
		const child = children[index];
		if (resolveRailSection(child) || shouldWrapRailChatChild(child)) return index;
	}
	return -1;
}

export function wrapLastRailSectionChatChild(
	mode: any,
	kind: RailSectionKind,
	options: RailChatChildOptions = {},
): void {
	const children = mode?.chatContainer?.children;
	if (!Array.isArray(children) || children.length === 0) return;

	const lastIndex = lastRenderableRailChildIndex(children);
	if (lastIndex < 0) return;

	const last = children[lastIndex];
	const existingSection = resolveRailSection(last);
	if (existingSection) {
		options.normalizeChild?.(existingSection.component);
		if (options.assignTo) mode[options.assignTo] = last;
		return;
	}

	if (!shouldWrapRailChatChild(last)) return;
	const wrapped = railChatChildBlock(last, kind, options);
	children[lastIndex] = wrapped;
	if (options.assignTo) mode[options.assignTo] = wrapped;
}
