// Type declaration for marked-terminal v6 (the @types/marked-terminal package is outdated)
declare module "marked-terminal" {
	import type { MarkedExtension } from "marked";
	export function markedTerminal(options?: Record<string, unknown>): MarkedExtension;
}
