export type PrototypePatchTarget = {
	ctor: { prototype: any };
	methodName: string;
	original: any;
};

export async function resolveNativePiExport<T>(relativeModule: string, exportName: string): Promise<T | undefined> {
	try {
		// Extensions are loaded through jiti, while Pi's interactive mode uses the
		// native ESM module instance. Patch both constructors so the style applies
		// to the actual chat renderer as well as extension-side imports/tests.
		const packageUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
		const moduleUrl = new URL(relativeModule, packageUrl).href;
		const nativeModule = (await import(moduleUrl)) as Record<string, T | undefined>;
		return nativeModule[exportName];
	} catch {
		return undefined;
	}
}

export function restorePrototypePatches(targets: PrototypePatchTarget[], defaultMethodName?: string): void {
	for (const target of targets) {
		const methodName = target.methodName ?? defaultMethodName;
		if (!methodName) continue;
		target.ctor.prototype[methodName] = target.original;
	}
	targets.length = 0;
}
