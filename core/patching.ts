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

export function createStore<T extends object>(key: string, defaults: () => T): () => T {
	const sym = Symbol.for(`pi-rail-ui.${key}`);
	return () => {
		const g = globalThis as any;
		const existing = g[sym];
		if (existing) return existing as T;
		const store = defaults();
		g[sym] = store;
		return store;
	};
}

let _interactiveModeCtorsPromise: Promise<Array<{ prototype: any }>> | undefined;

export async function getInteractiveModeConstructors(): Promise<Array<{ prototype: any }>> {
	if (_interactiveModeCtorsPromise) return _interactiveModeCtorsPromise;
	_interactiveModeCtorsPromise = (async () => {
		const { InteractiveMode } = await import("@earendil-works/pi-coding-agent");
		const ctors: Array<{ prototype: any }> = [InteractiveMode as unknown as { prototype: any }];
		const nativeCtor = await resolveNativePiExport<{ prototype: any }>(
			"./modes/interactive/interactive-mode.js",
			"InteractiveMode",
		);
		if (nativeCtor && !ctors.includes(nativeCtor)) ctors.push(nativeCtor);
		return ctors;
	})();
	return _interactiveModeCtorsPromise;
}
