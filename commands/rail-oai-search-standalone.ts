import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installRailOaiSearch } from "./rail-oai-search";

export default function installRailOaiSearchExtension(pi: ExtensionAPI): void {
	installRailOaiSearch(pi);
}