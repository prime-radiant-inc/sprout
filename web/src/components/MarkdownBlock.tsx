import DOMPurify from "isomorphic-dompurify";
import { marked } from "marked";
import styles from "./MarkdownBlock.module.css";

interface MarkdownBlockProps {
	content: string;
}

/** Renders markdown content as sanitized HTML using marked + DOMPurify. */
export function MarkdownBlock({ content }: MarkdownBlockProps) {
	const raw = marked.parse(content, { async: false }) as string;
	const html = DOMPurify.sanitize(raw);
	return (
		<div
			className={styles.markdown}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
