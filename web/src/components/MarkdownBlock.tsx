import DOMPurify from "isomorphic-dompurify";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import markdown from "highlight.js/lib/languages/markdown";
import diff from "highlight.js/lib/languages/diff";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import { Marked } from "marked";
import styles from "./MarkdownBlock.module.css";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);

// Common aliases
hljs.registerAliases(["js", "jsx"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerAliases(["html", "htm"], { languageName: "xml" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["md"], { languageName: "markdown" });
hljs.registerAliases(["golang"], { languageName: "go" });
hljs.registerAliases(["rs"], { languageName: "rust" });

interface MarkdownBlockProps {
	content: string;
}

/** Highlight code, returning pre-escaped HTML. */
function highlightCode(text: string, lang?: string): string {
	if (lang) {
		const name = hljs.getLanguage(lang) ? lang : undefined;
		if (name) {
			return hljs.highlight(text, { language: name }).value;
		}
	}
	return hljs.highlightAuto(text).value;
}

/** Marked instance with custom renderer that wraps fenced code blocks. */
const md = new Marked({
	renderer: {
		code({ text, lang }: { text: string; lang?: string; escaped?: boolean }): string {
			const highlighted = highlightCode(text, lang);
			const langAttr = lang ? ` language-${lang}` : "";
			const langLabel = lang ? `<span data-code-lang>${lang}</span>` : "";
			return `<div data-code-block>${langLabel}<button type="button" data-action="copy-code" title="Copy code">Copy</button><pre><code class="hljs${langAttr}">${highlighted}\n</code></pre></div>\n`;
		},
	},
});

/** Renders markdown content as sanitized HTML using marked + DOMPurify. */
export function MarkdownBlock({ content }: MarkdownBlockProps) {
	const raw = md.parse(content, { async: false }) as string;
	const html = DOMPurify.sanitize(raw, {
		ADD_ATTR: ["data-code-block", "data-action", "data-code-lang"],
		ADD_TAGS: ["span"],
	});

	const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
		const target = e.target as HTMLElement;
		if (target.getAttribute("data-action") === "copy-code") {
			const block = target.closest("[data-code-block]");
			const code = block?.querySelector("code")?.textContent;
			if (code) {
				navigator.clipboard
					.writeText(code.trimEnd())
					.then(() => {
						target.textContent = "Copied!";
						setTimeout(() => {
							target.textContent = "Copy";
						}, 1500);
					})
					.catch(() => {});
			}
		}
	};

	return (
		<div
			className={styles.markdown}
			onClick={handleClick}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
