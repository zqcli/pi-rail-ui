import { createPatchLifecycle, getInteractiveModeConstructors } from "../../core/patching";
import { withRailSectionChatChildren } from "./chat-child-rail-injection";

type InteractiveModeCtor = { prototype: any };

const commandOutputLifecycle = createPatchLifecycle("command-output-rail-patch", () => ({}));
const getCommandOutputRailPatchStore = () => commandOutputLifecycle.state();

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

function patchInteractiveMode(ctor: InteractiveModeCtor): void {
	if (!ctor?.prototype) return;

	for (const methodName of COMMAND_OUTPUT_METHODS) {
		commandOutputLifecycle.patchMethod(ctor, methodName, (original) => function patchedCommandOutputMethod(this: any, ...args: any[]) {
			const currentStore = getCommandOutputRailPatchStore();
			if (!currentStore.active) return original.apply(this, args);
			return withRailSectionChatChildren(this, "commandOutput", () => original.apply(this, args));
		});
	}
}

export async function installCommandOutputRail(): Promise<void> {
	commandOutputLifecycle.activate();
	for (const ctor of await getInteractiveModeConstructors()) patchInteractiveMode(ctor);
}

export function uninstallCommandOutputRail(): void {
	commandOutputLifecycle.deactivate();
}
