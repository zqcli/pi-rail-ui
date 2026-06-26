export function isBashExecution(component: any): boolean {
	return component?.constructor?.name === "BashExecutionComponent" || typeof component?.getCommand === "function";
}
