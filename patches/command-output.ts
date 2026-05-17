import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { isGapBlock } from "../ui/gap";
import { restorePrototypePatches, resolveNativePiExport, type PrototypePatchTarget } from "../patching";
import { RailSectionBlock } from "../ui/rail-section";

type InteractiveModeCtor = { prototype: any };
type CommandOutputGapPatchStore = {
	active: boolean;
	targets: PrototypePatchTarget[];
};

const COMMAND_OUTPUT_GAP_PATCH_KEY = Symbol.for("pi-rail-ui.command-output-gap-patch");
const COMMAND_OUTPUT_METHODS = [
	"handleNameCommand",
	"handleSessionCommand",
	"handleChangelogCommand",
	"handleHotkeysCommand",
	"handleClearCommand",
	"handleDebugCommand",
	"handleArminSaysHi",
	"handleDementedDelves",
	"handleDaxnuts",
	"showNewVersionNotification",
	"showPackageUpdateNotification",
] as const;

function getCommandOutputGapPatchStore(): CommandOutputGapPatchStore {
	const globalStore = globalThis as typeof globalThis & { [COMMAND_OUTPUT_GAP_PATCH_KEY]?: Partial<CommandOutputGapPatchStore> };
	const store = globalStore[COMMAND_OUTPUT_GAP_PATCH_KEY] ?? {};
	store.active ??= false;
	store.targets ??= [];
	globalStore[COMMAND_OUTPUT_GAP_PATCH_KEY] = store;
	return store as CommandOutputGapPatchStore;
}

function shouldGapCommandChild(child: any): boolean {
	return Boolean(child && typeof child.render === "function" && child.constructor?.name !== "Spacer" && !isGapBlock(child));
}

function withLeftGappedChatChildren<T>(mode: any, renderOutput: () => T): T {
	const chatContainer = mode?.chatContainer;
	const originalAddChild = chatContainer?.addChild;
	if (typeof originalAddChild !== "function") return renderOutput();

	chatContainer.addChild = function patchedCommandOutputAddChild(this: any, child: any) {
		return originalAddChild.call(this, shouldGapCommandChild(child) ? new RailSectionBlock(child, "commandOutput") : child);
	};

	let result: T;
	try {
		result = renderOutput();
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

async function getInteractiveModeConstructors(): Promise<InteractiveModeCtor[]> {
	const ctors: InteractiveModeCtor[] = [InteractiveMode as unknown as InteractiveModeCtor];
	const nativeCtor = await resolveNativePiExport<InteractiveModeCtor>("./modes/interactive/interactive-mode.js", "InteractiveMode");
	if (nativeCtor && !ctors.includes(nativeCtor)) ctors.push(nativeCtor);
	return ctors;
}

function patchInteractiveMode(ctor: InteractiveModeCtor, store: CommandOutputGapPatchStore): void {
	if (!ctor?.prototype) return;

	for (const methodName of COMMAND_OUTPUT_METHODS) {
		if (store.targets.some((target) => target.ctor === ctor && target.methodName === methodName)) continue;
		const original = ctor.prototype[methodName];
		if (typeof original !== "function") continue;

		ctor.prototype[methodName] = function patchedCommandOutputMethod(this: any, ...args: any[]) {
			const currentStore = getCommandOutputGapPatchStore();
			if (!currentStore.active) return original.apply(this, args);
			return withLeftGappedChatChildren(this, () => original.apply(this, args));
		};
		store.targets.push({ ctor, methodName, original });
	}
}

export async function installCommandOutputGap(): Promise<void> {
	const store = getCommandOutputGapPatchStore();
	store.active = true;
	for (const ctor of await getInteractiveModeConstructors()) patchInteractiveMode(ctor, store);
}

export function uninstallCommandOutputGap(): void {
	const store = getCommandOutputGapPatchStore();
	store.active = false;
	restorePrototypePatches(store.targets);
}
