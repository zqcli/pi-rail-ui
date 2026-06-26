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

export function restorePrototypePatches(targets: PrototypePatchTarget[]): void {
	for (const target of targets) {
		target.ctor.prototype[target.methodName] = target.original;
	}
	targets.length = 0;
}

export function patchPrototypeMethod(
	targets: PrototypePatchTarget[],
	ctor: { prototype: any } | undefined,
	methodName: string,
	patch: (original: (...args: any[]) => any) => (...args: any[]) => any,
): boolean {
	if (!ctor?.prototype || targets.some((target) => target.ctor === ctor && target.methodName === methodName)) return false;
	const original = ctor.prototype[methodName];
	if (typeof original !== "function") return false;
	ctor.prototype[methodName] = patch(original);
	targets.push({ ctor, methodName, original });
	return true;
}

export type PatchLifecycleStore<TState extends object> = TState & {
	active: boolean;
	targets: PrototypePatchTarget[];
};

export class PatchLifecycle<TState extends object> {
	private readonly getStore: () => PatchLifecycleStore<TState>;

	constructor(key: string, defaults: () => TState) {
		this.getStore = createStore<PatchLifecycleStore<TState>>(key, () => ({
			...defaults(),
			active: false,
			targets: [],
		}));
	}

	state(): PatchLifecycleStore<TState> {
		return this.getStore();
	}

	activate(update?: (store: PatchLifecycleStore<TState>) => void): PatchLifecycleStore<TState> {
		const store = this.state();
		update?.(store);
		store.active = true;
		return store;
	}

	patchMethod(
		ctor: { prototype: any } | undefined,
		methodName: string,
		patch: (original: (...args: any[]) => any) => (...args: any[]) => any,
	): boolean {
		return patchPrototypeMethod(this.state().targets, ctor, methodName, patch);
	}

	restore(): void {
		restorePrototypePatches(this.state().targets);
	}

	deactivate(reset?: (store: PatchLifecycleStore<TState>) => void): PatchLifecycleStore<TState> {
		const store = this.state();
		store.active = false;
		this.restore();
		reset?.(store);
		return store;
	}
}

export function createPatchLifecycle<TState extends object>(key: string, defaults: () => TState): PatchLifecycle<TState> {
	return new PatchLifecycle(key, defaults);
}

export async function resolveNativeTuiExport<T>(exportName: string): Promise<T | undefined> {
	try {
		const packageUrl = import.meta.resolve("@earendil-works/pi-tui");
		const nativeModule = (await import(packageUrl)) as Record<string, T | undefined>;
		return nativeModule[exportName];
	} catch {
		return undefined;
	}
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
