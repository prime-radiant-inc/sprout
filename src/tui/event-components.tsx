import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { SessionEvent } from "../kernel/types.ts";
import { formatDuration, smartArgs } from "./render-event.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Truncate a string to maxLen, adding ellipsis if truncated. */
function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen - 1)}...`;
}

// ---------------------------------------------------------------------------
// Simple markdown-lite formatting
// ---------------------------------------------------------------------------

/**
 * Parse simple markdown into Ink-compatible React nodes.
 * Handles: **bold**, `inline code`, and triple-backtick code blocks.
 */
export function formatMarkdown(text: string): ReactNode {
	// Split into code blocks and non-code-block sections
	const codeBlockRegex = /```(?:\w*)\n?([\s\S]*?)```/g;
	const parts: ReactNode[] = [];
	let lastIndex = 0;
	let key = 0;

	for (const match of text.matchAll(codeBlockRegex)) {
		const before = text.slice(lastIndex, match.index);
		if (before) {
			parts.push(...formatInline(before, key));
			key += 100;
		}
		parts.push(
			<Text key={`cb-${key++}`} dimColor>
				{match[1]}
			</Text>,
		);
		lastIndex = match.index! + match[0].length;
	}

	const remaining = text.slice(lastIndex);
	if (remaining) {
		parts.push(...formatInline(remaining, key));
	}

	return <Text>{parts}</Text>;
}

/** Format inline markdown: **bold** and `code`. */
function formatInline(text: string, keyOffset: number): ReactNode[] {
	const parts: ReactNode[] = [];
	// Match **bold** or `code` segments
	const inlineRegex = /(\*\*(.+?)\*\*|`([^`]+?)`)/g;
	let lastIndex = 0;
	let key = keyOffset;

	for (const match of text.matchAll(inlineRegex)) {
		const before = text.slice(lastIndex, match.index);
		if (before) {
			parts.push(before);
		}
		if (match[2]) {
			// bold
			parts.push(
				<Text key={`b-${key++}`} bold>
					{match[2]}
				</Text>,
			);
		} else if (match[3]) {
			// inline code
			parts.push(
				<Text key={`c-${key++}`} color="cyan">
					{match[3]}
				</Text>,
			);
		}
		lastIndex = match.index! + match[0].length;
	}

	const remaining = text.slice(lastIndex);
	if (remaining) {
		parts.push(remaining);
	}

	return parts;
}

// ---------------------------------------------------------------------------
// Indentation helper
// ---------------------------------------------------------------------------

function indent(depth: number): string {
	return "  ".repeat(depth);
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

interface ToolStartProps {
	depth: number;
	toolName: string;
	args?: Record<string, unknown>;
}

/** Renders a tool invocation start: ▸ tool_name args */
export function ToolStartLine({ depth, toolName, args }: ToolStartProps) {
	const argStr = smartArgs(toolName, args);
	return (
		<Box>
			<Text dimColor>{indent(depth)}</Text>
			<Text dimColor>{"\u25B8 "}</Text>
			<Text color="yellow">{toolName}</Text>
			{argStr && <Text dimColor>{` ${argStr}`}</Text>}
		</Box>
	);
}

interface ToolEndProps {
	depth: number;
	toolName: string;
	args?: Record<string, unknown>;
	success: boolean;
	error?: string;
	output?: string;
	durationMs: number | null;
}

/** Renders a tool invocation result: ▸ tool_name args ✓/✗ duration */
export function ToolEndLine({
	depth,
	toolName,
	args,
	success,
	error,
	output,
	durationMs,
}: ToolEndProps) {
	const argStr = smartArgs(toolName, args);
	const dur = formatDuration(durationMs);

	// Truncate output preview to 3 lines
	let preview: string | null = null;
	if (success && output) {
		const outputLines = output.split("\n");
		if (outputLines.length <= 3) {
			preview = output;
		} else {
			preview = `${outputLines.slice(0, 3).join("\n")}\n... (${outputLines.length - 3} more lines)`;
		}
	}

	return (
		<Box flexDirection="column">
			<Box>
				<Text dimColor>{indent(depth)}</Text>
				<Text dimColor>{"\u25B8 "}</Text>
				<Text color="yellow">{toolName}</Text>
				{argStr && <Text dimColor>{` ${argStr}`}</Text>}
				{success ? (
					<Text color="green">{" \u2713"}</Text>
				) : (
					<Text color="red">{` \u2717${error ? ` ${error}` : ""}`}</Text>
				)}
				{dur && <Text dimColor>{` ${dur}`}</Text>}
			</Box>
			{preview && (
				<Box paddingLeft={depth * 2 + 4}>
					<Text dimColor>{preview}</Text>
				</Box>
			)}
		</Box>
	);
}

interface AssistantTextProps {
	depth: number;
	text?: string;
	reasoning?: string;
}

/** Renders assistant text output — the star of the show. */
export function AssistantTextLine({ depth, text, reasoning }: AssistantTextProps) {
	return (
		<Box flexDirection="column">
			{reasoning && (
				<Box>
					<Text dimColor>{indent(depth)}</Text>
					<Text dimColor italic>
						{reasoning}
					</Text>
				</Box>
			)}
			{text && (
				<Box>
					<Text dimColor>{indent(depth)}</Text>
					{formatMarkdown(text)}
				</Box>
			)}
		</Box>
	);
}

interface DelegationStartProps {
	depth: number;
	agentName: string;
	goal: string;
}

/** Renders a delegation start: -> agent: goal */
export function DelegationStartLine({ depth, agentName, goal }: DelegationStartProps) {
	return (
		<Box>
			<Text dimColor>{indent(depth)}</Text>
			<Text color="cyan">{"\u2192 "}</Text>
			<Text color="cyan" bold>
				{agentName}
			</Text>
			<Text dimColor>{`: ${truncate(goal, 80)}`}</Text>
		</Box>
	);
}

interface DelegationEndProps {
	depth: number;
	agentName: string;
	success: boolean;
	turns?: number;
	durationMs: number | null;
}

/** Renders a delegation end: <- agent ✓ (N turns) duration */
export function DelegationEndLine({
	depth,
	agentName,
	success,
	turns,
	durationMs,
}: DelegationEndProps) {
	const dur = formatDuration(durationMs);
	return (
		<Box>
			<Text dimColor>{indent(depth)}</Text>
			<Text color="cyan">{"\u2190 "}</Text>
			<Text color="cyan" bold>
				{agentName}
			</Text>
			{success ? (
				<Text color="green">{" \u2713"}</Text>
			) : (
				<Text color="red">{" \u2717 failed"}</Text>
			)}
			{turns != null && <Text dimColor>{` (${turns} turns)`}</Text>}
			{dur && <Text dimColor>{` ${dur}`}</Text>}
		</Box>
	);
}

const SYSTEM_ICONS: Record<string, string> = {
	session_start: "\u25C6",
	session_end: "\u25C7",
	session_resume: "\u21BB",
	session_clear: "\u25C6",
	compaction: "\u2298",
	steering: "\u21AA",
	learn_start: "\u25CB",
	learn_mutation: "\u25CB",
};

interface SystemLineProps {
	depth: number;
	kind: string;
	message: string;
}

/** Renders a system/infrastructure message — dim and quiet. */
export function SystemLine({ depth, kind, message }: SystemLineProps) {
	const icon = SYSTEM_ICONS[kind] ?? "\u25CB";

	if (kind === "error") {
		return (
			<Box>
				<Text dimColor>{indent(depth)}</Text>
				<Text color="red">{`\u2717 ${message}`}</Text>
			</Box>
		);
	}
	if (kind === "warning") {
		return (
			<Box>
				<Text dimColor>{indent(depth)}</Text>
				<Text color="yellow">{`\u26A0 ${message}`}</Text>
			</Box>
		);
	}
	if (kind === "interrupted") {
		return (
			<Box>
				<Text dimColor>{indent(depth)}</Text>
				<Text color="red">{`\u2298 ${message}`}</Text>
			</Box>
		);
	}

	return (
		<Box>
			<Text dimColor>{indent(depth)}</Text>
			<Text dimColor>{`${icon} ${message}`}</Text>
		</Box>
	);
}

interface ThinkingLineProps {
	depth: number;
}

/** Renders a "thinking..." indicator. */
export function ThinkingLine({ depth }: ThinkingLineProps) {
	return (
		<Box>
			<Text dimColor>{indent(depth)}</Text>
			<Text dimColor>{"\u25CC thinking..."}</Text>
		</Box>
	);
}

// ---------------------------------------------------------------------------
// Main dispatcher: SessionEvent -> ReactNode
// ---------------------------------------------------------------------------

/**
 * Convert a SessionEvent into a renderable React component.
 * Returns null for events that should not be displayed.
 */
export function renderEventComponent(event: SessionEvent, durationMs: number | null): ReactNode {
	const { kind, depth, data } = event;

	switch (kind) {
		case "session_start":
			return <SystemLine depth={depth} kind={kind} message="Starting session..." />;

		case "session_resume":
			return (
				<SystemLine
					depth={depth}
					kind={kind}
					message={`Resumed session (${data.history_length ?? 0} messages of history)`}
				/>
			);

		case "session_clear":
			return <SystemLine depth={depth} kind={kind} message="New session started" />;

		case "plan_start":
			return <ThinkingLine depth={depth} />;

		case "plan_end": {
			const text = data.text ? String(data.text) : undefined;
			const reasoning = data.reasoning ? String(data.reasoning) : undefined;
			if (!text && !reasoning) return null;
			return <AssistantTextLine depth={depth} text={text} reasoning={reasoning} />;
		}

		case "primitive_start":
			return (
				<ToolStartLine
					depth={depth}
					toolName={data.name as string}
					args={data.args as Record<string, unknown>}
				/>
			);

		case "primitive_end":
			return (
				<ToolEndLine
					depth={depth}
					toolName={data.name as string}
					args={data.args as Record<string, unknown>}
					success={Boolean(data.success)}
					error={data.error ? String(data.error) : undefined}
					output={data.output ? String(data.output) : undefined}
					durationMs={durationMs}
				/>
			);

		case "act_start":
			return (
				<DelegationStartLine
					depth={depth}
					agentName={data.agent_name as string}
					goal={data.goal as string}
				/>
			);

		case "act_end":
			return (
				<DelegationEndLine
					depth={depth}
					agentName={data.agent_name as string}
					success={Boolean(data.success)}
					turns={typeof data.turns === "number" ? data.turns : undefined}
					durationMs={durationMs}
				/>
			);

		case "session_end":
			return (
				<SystemLine
					depth={depth}
					kind={kind}
					message={`Session complete. ${data.turns} turns, ${data.stumbles} stumbles.`}
				/>
			);

		case "interrupted":
			return (
				<SystemLine depth={depth} kind={kind} message={String(data.message ?? "user interrupt")} />
			);

		case "compaction":
			return (
				<SystemLine
					depth={depth}
					kind={kind}
					message={`Context compacted: ${data.beforeCount} \u2192 ${data.afterCount} messages`}
				/>
			);

		case "learn_start":
			return <SystemLine depth={depth} kind={kind} message="Learning from stumble..." />;

		case "learn_mutation":
			return (
				<SystemLine depth={depth} kind={kind} message={`Genome updated: ${data.mutation_type}`} />
			);

		case "warning":
			return <SystemLine depth={depth} kind={kind} message={String(data.message)} />;

		case "error":
			return <SystemLine depth={depth} kind={kind} message={String(data.error)} />;

		case "steering":
			return (
				<SystemLine depth={depth} kind={kind} message={String(data.text ?? "user steering")} />
			);

		default:
			return null;
	}
}
