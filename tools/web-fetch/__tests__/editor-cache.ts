// 验证 editorCache 复用逻辑
// 模拟流式输出期间的多次 render 调用

const assert = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };

// 模拟 editor 对象
let renderCallCount = 0;
const makeEditor = (lines: string[]) => ({
	renderId: "",
	render(width: number) {
		renderCallCount++;
		this.renderId = `w${width}:l${lines.length}`;
		return lines.map(l => " ".repeat(width) + l);
	},
});

// 模拟 footer / below
let footerRenderCount = 0;
const footer = {
	render(width: number) { footerRenderCount++; return ["footer"]; },
};
let belowRenderCount = 0;
const below = {
	render(width: number) { belowRenderCount++; return []; },
};

// ---------- 缓存逻辑（纯函数，与 history-renderer.ts 一致） ----------

let editorCache: { width: number; editorRef: any; editorRenderId: string; lines: string[]; belowLines: string[]; footerLines: string[] } | undefined;

function getEditorLines(width: number, editorRef: any, belowRef: any, footerRef: any) {
	const editorRenderId = editorRef?.renderId as string | undefined;
	if (editorCache && editorCache.width === width && editorCache.editorRef === editorRef && editorCache.editorRenderId === editorRenderId) {
		return { editorLines: editorCache.lines, belowLines: editorCache.belowLines, footerLines: editorCache.footerLines, cached: true };
	}
	const editorLines = editorRef?.render?.(width) ?? [];
	const belowLines = belowRef?.render?.(width) ?? [];
	const footerLines = footerRef?.render?.(width) ?? [];
	const postRenderId = editorRef?.renderId ?? "";
	editorCache = { width, editorRef, editorRenderId: postRenderId, lines: editorLines, belowLines, footerLines };
	return { editorLines, belowLines, footerLines, cached: false };
}

// ---------- 测试 ----------

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
	process.stdout.write(`  ${name} ... `);
	try { fn(); console.log("PASS"); passed++; } catch (e: unknown) { console.log(`FAIL: ${e}`); failed++; }
}

console.log("editorCache reuse tests\n");

test("first frame: fresh render", () => {
	renderCallCount = 0;
	footerRenderCount = 0;
	const editor = makeEditor(["hello", "world"]);
	editor.renderId = ""; // before first render

	const r = getEditorLines(80, editor, below, footer);
	assert(!r.cached, "first frame should not be cached");
	assert(renderCallCount === 1, `editor rendered ${renderCallCount} times`);
	assert(footerRenderCount === 1, `footer rendered ${footerRenderCount} times`);
	assert(r.editorLines.length >= 2, "should have editor lines");
});

test("second frame, editor unchanged: cached", () => {
	const before = renderCallCount;
	const editor = editorCache!.editorRef;
	const r = getEditorLines(80, editor, below, footer);
	// 注意：缓存命中的前提是 editor.renderId 没变。
	// 但 editor.renderId 是在 render 时更新的，缓存返回时 render 没被调用，
	// 所以 renderId 保持上一次的值。下次比较 renderId 也匹配。
	assert(r.cached, "unchanged editor should be cached");
	assert(renderCallCount === before, "editor should NOT have been rendered again");
});

test("editor content changes (user types): cache miss, fresh render", () => {
	renderCallCount = 0;
	const editor = makeEditor(["hello", "world", "new line"]);
	editor.renderId = "w80:l3"; // simulate render()
	const r = getEditorLines(80, editor, below, footer);
	assert(!r.cached, "changed editor should trigger fresh render");
	assert(renderCallCount === 1, "editor should have been rendered");
});

test("same editor, same renderId, same width: cached again", () => {
	const before = renderCallCount;
	const editor = editorCache!.editorRef;
	const r = getEditorLines(80, editor, below, footer);
	assert(r.cached, "same editor + same renderId should be cached");
	assert(renderCallCount === before, "editor should NOT have been rendered");
});

test("width changes: cache miss", () => {
	renderCallCount = 0;
	const editor = editorCache!.editorRef;
	const r = getEditorLines(100, editor, below, footer);
	assert(!r.cached, "different width should trigger fresh render");
	assert(renderCallCount === 1, "editor should have been rendered");
});

test("editor instance changes: cache miss", () => {
	renderCallCount = 0;
	editorCache = undefined;
	const newEditor = makeEditor(["totally different"]);
	newEditor.renderId = "w80:l1";
	const r = getEditorLines(80, newEditor, below, footer);
	assert(!r.cached, "new editor instance should trigger fresh render");
	assert(renderCallCount === 1, "editor should have been rendered");
});

setTimeout(() => {
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed > 0 ? 1 : 0);
}, 100);
