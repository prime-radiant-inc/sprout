import { marked } from "marked";
import styles from "./MarkdownBlock.module.css";

interface MarkdownBlockProps {
	content: string;
}

/** Renders markdown content as HTML using marked. */
export function MarkdownBlock({ content }: MarkdownBlockProps) {
	const html = marked.parse(content) as string;
	return (
		<div
			className={styles.markdown}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
