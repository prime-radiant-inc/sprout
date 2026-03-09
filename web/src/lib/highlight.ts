import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

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

hljs.registerAliases(["js", "jsx"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerAliases(["html", "htm"], { languageName: "xml" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["md"], { languageName: "markdown" });
hljs.registerAliases(["golang"], { languageName: "go" });
hljs.registerAliases(["rs"], { languageName: "rust" });

/** Highlight code, returning pre-escaped HTML. */
export function highlightCode(text: string, lang?: string): string {
	if (lang) {
		const name = hljs.getLanguage(lang) ? lang : undefined;
		if (name) {
			return hljs.highlight(text, { language: name }).value;
		}
	}
	return hljs.highlightAuto(text).value;
}
