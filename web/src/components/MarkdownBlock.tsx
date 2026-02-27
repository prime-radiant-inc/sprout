import DOMPurify from "isomorphic-dompurify";
import { Marked } from "marked";
import styles from "./MarkdownBlock.module.css";

interface MarkdownBlockProps {
	content: string;
}

function escapeHtml(html: string): string {
	return html
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Marked instance with custom renderer that wraps fenced code blocks. */
const md = new Marked({
	renderer: {
		code({ text, lang, escaped }: { text: string; lang?: string; escaped?: boolean }): string {
			const langClass = lang ? ` class="language-${lang}"` : "";
			const code = escaped ? text : escapeHtml(text);
			return `<div data-code-block><pre><code${langClass}>${code}\n</code></pre></div>\n`;
		},
	},
});

/** Renders markdown content as sanitized HTML using marked + DOMPurify. */
export function MarkdownBlock({ content }: MarkdownBlockProps) {
	const raw = md.parse(content, { async: false }) as string;
	const html = DOMPurify.sanitize(raw, {
		ADD_ATTR: ["data-code-block"],
	});
	return (
		<div
			className={styles.markdown}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
