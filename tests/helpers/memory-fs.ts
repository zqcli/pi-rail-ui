import type { ApplyPatchOperations } from "../../tools/apply-patch";

export const TEST_CWD = "/repo";

export function missingPath(path: string): Error & { code?: string } {
	const error = new Error(`Missing file: ${path}`) as Error & { code?: string };
	error.code = "ENOENT";
	return error;
}

export class MemoryFs {
	readonly files = new Map<string, string>();

	readonly operations: ApplyPatchOperations = {
		readFile: async (path) => {
			const content = this.files.get(path);
			if (content === undefined) throw missingPath(path);
			return Buffer.from(content, "utf-8");
		},
		writeFile: async (path, content) => {
			this.files.set(path, content);
		},
		mkdir: async () => {},
		unlink: async (path) => {
			if (!this.files.has(path)) throw missingPath(path);
			this.files.delete(path);
		},
		rename: async (from, to) => {
			const content = this.files.get(from);
			if (content === undefined) throw missingPath(from);
			this.files.set(to, content);
			this.files.delete(from);
		},
		access: async (path) => {
			if (!this.files.has(path)) throw missingPath(path);
		},
	};

	set(path: string, content: string): void {
		this.files.set(`${TEST_CWD}/${path}`, content);
	}

	get(path: string): string | undefined {
		return this.files.get(`${TEST_CWD}/${path}`);
	}
}
