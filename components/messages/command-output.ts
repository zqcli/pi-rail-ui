import { createStore, restorePrototypePatches, getInteractiveModeConstructors, patchPrototypeMethod, type PrototypePatchTarget } from "../../core/patching";
import { withRailSectionChatChildren } from "./chat-child-rail-injection";

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

function patchInteractiveMode(ctor: InteractiveModeCtor, store: CommandOutputRailPatchStore): void {
	if (!ctor?.prototype) return;

	for (const methodName of COMMAND_OUTPUT_METHODS) {
		patchPrototypeMethod(store.targets, ctor, methodName, (original) => function patchedCommandOutputMethod(this: any, ...args: any[]) {
			const currentStore = getCommandOutputRailPatchStore();
			if (!currentStore.active) return original.apply(this, args);
			return withRailSectionChatChildren(this, "commandOutput", () => original.apply(this, args));
		});
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
