import { createStore, restorePrototypePatches, getInteractiveModeConstructors, type PrototypePatchTarget } from "../../core/patching";
import { RailSectionBlock, resolveRailSection } from "../../rail/rail-section";

type InteractiveModeCtor = { prototype: any };
type CommandOutputRailPatchStore = {
	active: boolean;
	targets: PrototypePatchTarget[];
};

const getCommandOutputRailPatchStore = createStore<CommandOutputRailPatchStore>("command-output-rail-patch", () => ({
	active: false,
	targets: [],
}));

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

function shouldWrapCommandChild(child: any): boolean {
	return Boolean(child && typeof child.render === "function" && child.constructor?.name !== "Spacer" && !resolveRailSection(child));
}

function withLeftGappedChatChildren<T>(mode: any, renderOutput: () => T): T {
	const chatContainer = mode?.chatContainer;
	const originalAddChild = chatContainer?.addChild;
	if (typeof originalAddChild !== "function") return renderOutput();

	chatContainer.addChild = function patchedCommandOutputAddChild(this: any, child: any) {
		return originalAddChild.call(this, shouldWrapCommandChild(child) ? new RailSectionBlock(child, "commandOutput") : child);
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

function patchInteractiveMode(ctor: InteractiveModeCtor, store: CommandOutputRailPatchStore): void {
	if (!ctor?.prototype) return;

	for (const methodName of COMMAND_OUTPUT_METHODS) {
		if (store.targets.some((target) => target.ctor === ctor && target.methodName === methodName)) continue;
		const original = ctor.prototype[methodName];
		if (typeof original !== "function") continue;

		ctor.prototype[methodName] = function patchedCommandOutputMethod(this: any, ...args: any[]) {
			const currentStore = getCommandOutputRailPatchStore();
			if (!currentStore.active) return original.apply(this, args);
			return withLeftGappedChatChildren(this, () => original.apply(this, args));
		};
		store.targets.push({ ctor, methodName, original });
	}
}

export async function installCommandOutputRail(): Promise<void> {
	const store = getCommandOutputRailPatchStore();
	store.active = true;
	for (const ctor of await getInteractiveModeConstructors()) patchInteractiveMode(ctor, store);
}

export function uninstallCommandOutputRail(): void {
	const store = getCommandOutputRailPatchStore();
	store.active = false;
	restorePrototypePatches(store.targets);
}
