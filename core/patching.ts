export type PrototypePatchTarget = {
	ctor: { prototype: any };
	methodName: string;
	original: any;
};

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

export async function getTuiAltScreenConstructor(): Promise<{ prototype: any }> {
	const { TuiAltScreen } = await import("@earendil-works/pi-tui");
	return TuiAltScreen as unknown as { prototype: any };
}

export async function getInteractiveModeConstructor(): Promise<{ prototype: any }> {
	const { InteractiveMode } = await import("@earendil-works/pi-coding-agent");
	return InteractiveMode as unknown as { prototype: any };
}
