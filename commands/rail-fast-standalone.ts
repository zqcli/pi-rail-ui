import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installRailFast } from "./rail-fast";

export default function installRailFastExtension(pi: ExtensionAPI): void {
	installRailFast(pi);
}