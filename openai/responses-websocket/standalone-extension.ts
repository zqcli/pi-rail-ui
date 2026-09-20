import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installRailResponsesWebSocket } from "./provider";

export default function installRailResponsesWebSocketExtension(pi: ExtensionAPI): void {
	installRailResponsesWebSocket(pi);
}