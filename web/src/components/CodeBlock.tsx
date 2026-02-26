import styles from "./CodeBlock.module.css";

interface CodeBlockProps {
	code: string;
	language?: string;
}

/** Styled pre/code block. Language class for future syntax highlighting. */
export function CodeBlock({ code, language }: CodeBlockProps) {
	return (
		<pre className={styles.pre}>
			<code className={language ? `language-${language}` : undefined}>
				{code}
			</code>
		</pre>
	);
}
