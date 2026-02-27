import type { ComponentType } from "react";
import { EditFileRenderer } from "./EditFileRenderer.tsx";
import { ExecRenderer } from "./ExecRenderer.tsx";
import { FallbackRenderer } from "./FallbackRenderer.tsx";
import { ReadFileRenderer } from "./ReadFileRenderer.tsx";

export interface ToolRendererProps {
	toolName: string;
	args: Record<string, unknown>;
	output: string;
	success: boolean;
	error?: string;
}

const renderers: Record<string, ComponentType<ToolRendererProps>> = {
	read_file: ReadFileRenderer,
	edit_file: EditFileRenderer,
	write_file: EditFileRenderer,
	exec: ExecRenderer,
	bash: ExecRenderer,
};

/** Return the appropriate renderer component for a tool, or FallbackRenderer. */
export function getRenderer(toolName: string): ComponentType<ToolRendererProps> {
	return renderers[toolName] ?? FallbackRenderer;
}
