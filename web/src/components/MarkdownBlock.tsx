import DOMPurify from "isomorphic-dompurify";
import { Marked } from "marked";
import { highlightCode } from "../lib/highlight.ts";
import styles from "./MarkdownBlock.module.css";

interface MarkdownBlockProps {
	content: string;
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
