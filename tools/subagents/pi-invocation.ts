import * as fs from "node:fs";
import * as path from "node:path";

export interface PiInvocation {
	command: string;
	args: string[];
}

export function resolvePiInvocation(args: string[]): PiInvocation {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/u.test(execName);
	return isGenericRuntime ? { command: "pi", args } : { command: process.execPath, args };
}