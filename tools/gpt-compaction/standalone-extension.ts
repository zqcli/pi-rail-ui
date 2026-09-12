import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installGptCompaction } from "./extension";

export default function installGptCompactionExtension(pi: ExtensionAPI): void {
	installGptCompaction(pi);
}
