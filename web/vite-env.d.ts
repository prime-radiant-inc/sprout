/// <reference types="vite/client" />

declare module "*.module.css" {
	const classes: Record<string, string>;
	export default classes;
}

declare module "highlight.js/lib/core" {
	import hljs from "highlight.js";
	export default hljs;
}

declare module "highlight.js/lib/languages/*" {
	import type { LanguageFn } from "highlight.js";
	const lang: LanguageFn;
	export default lang;
}
