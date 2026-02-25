import { Box, Text } from "ink";
import Markdown from "ink-markdown-es";
import { createShikiCodeRenderer } from "ink-shiki-code";
import type { ReactNode } from "react";
import type { SessionEvent } from "../kernel/types.ts";
import { formatDuration, smartArgs } from "./render-event.ts";

const codeRenderer = createShikiCodeRenderer({ theme: "one-dark-pro" });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Depth border wrapper
// ---------------------------------------------------------------------------

/** Wraps children with nested left-side box borders for each depth level. */
function DepthBorder({ depth, children }: { depth: number; children: ReactNode }): ReactNode {
	if (depth <= 0) return children;
	let wrapped = children;
	for (let i = 0; i < depth; i++) {
		wrapped = (
			<Box
				borderStyle="round"
				borderLeft
				borderTop={false}
				borderBottom={false}
				borderRight={false}
				borderColor="gray"
				paddingLeft={0}
			>
				{wrapped}
			</Box>
		);
	}
	return wrapped;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

interface UserMessageProps {
	depth: number;
	text: string;
}

/** Renders a user message — visually distinct, like a prompt. */
export function UserMessageLine({ depth, text }: UserMessageProps) {
	return (
		<DepthBorder depth={depth}>
			<Box>
				<Text color="blue" bold>
					{"❯ "}
				</Text>
				<Text>{text}</Text>
			</Box>
		</DepthBorder>
	);
}

interface ToolStartProps {
	depth: number;
	toolName: string;
	args?: Record<string, unknown>;
}

/** Renders a tool invocation start: ▸ tool_name args */
export function ToolStartLine({ depth, toolName, args }: ToolStartProps) {
	const argStr = smartArgs(toolName, args);
	return (
		<DepthBorder depth={depth}>
			<Box>
				<Text dimColor>{"\u25B8 "}</Text>
				<Text color="yellow">{toolName}</Text>
				{argStr && <Text dimColor>{` ${argStr}`}</Text>}
			</Box>
		</DepthBorder>
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
		<DepthBorder depth={depth}>
			<Box flexDirection="column">
				<Box>
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
					<Box paddingLeft={4}>
						<Text dimColor>{preview}</Text>
					</Box>
				)}
			</Box>
		</DepthBorder>
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
		<DepthBorder depth={depth}>
			<Box flexDirection="column">
				{reasoning && (
					<Box>
						<Text dimColor italic>
							{reasoning}
						</Text>
					</Box>
				)}
				{text && <Markdown renderers={{ code: codeRenderer }}>{text}</Markdown>}
			</Box>
		</DepthBorder>
	);
}

interface DelegationStartProps {
	depth: number;
	agentName: string;
	goal: string;
}

/** Renders a delegation start: ╭─ agent: goal */
export function DelegationStartLine({ depth, agentName, goal }: DelegationStartProps) {
	return (
		<DepthBorder depth={depth}>
			<Box>
				<Text dimColor bold>
					{"\u256D\u2500 "}
					{agentName}
				</Text>
				<Text dimColor>{`: ${goal}`}</Text>
			</Box>
		</DepthBorder>
	);
}

interface DelegationEndProps {
	depth: number;
	agentName: string;
	success: boolean;
	turns?: number;
	durationMs: number | null;
}

/** Renders a delegation end: ╰─ ✓ (N turns) duration */
export function DelegationEndLine({ depth, success, turns, durationMs }: DelegationEndProps) {
	const dur = formatDuration(durationMs);
	return (
		<DepthBorder depth={depth}>
			<Box>
				<Text dimColor bold>
					{"\u2570\u2500"}
				</Text>
				{success ? (
					<Text color="green">{" \u2713"}</Text>
				) : (
					<Text color="red">{" \u2717 failed"}</Text>
				)}
				{turns != null && <Text dimColor>{` (${turns} turns)`}</Text>}
				{dur && <Text dimColor>{` ${dur}`}</Text>}
			</Box>
		</DepthBorder>
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

	let content: ReactNode;
	if (kind === "error") {
		content = <Text color="red">{`\u2717 ${message}`}</Text>;
	} else if (kind === "warning") {
		content = <Text color="yellow">{`\u26A0 ${message}`}</Text>;
	} else if (kind === "interrupted") {
		content = <Text color="red">{`\u2298 ${message}`}</Text>;
	} else {
		content = <Text dimColor>{`${icon} ${message}`}</Text>;
	}

	return (
		<DepthBorder depth={depth}>
			<Box>{content}</Box>
		</DepthBorder>
	);
}

interface PlanningLineProps {
	depth: number;
	turn?: number;
}

/** Renders a planning indicator while waiting for the LLM. */
export function PlanningLine({ depth, turn }: PlanningLineProps) {
	const label = turn ? `planning (turn ${turn})...` : "planning...";
	return (
		<DepthBorder depth={depth}>
			<Box>
				<Text dimColor>{`\u25CC ${label}`}</Text>
			</Box>
		</DepthBorder>
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
			return null; // The app opening IS the session start

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
			return null; // The input area shows "..." while running; a text line is clutter

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
			return null; // The prompt returning IS the signal the run finished

		case "interrupted":
			return (
				<SystemLine depth={depth} kind={kind} message={String(data.message ?? "user interrupt")} />
			);

		case "compaction": {
			const header = `Context compacted: ${data.beforeCount} \u2192 ${data.afterCount} messages`;
			const summary = data.summary ? `\n${data.summary}` : "";
			return <SystemLine depth={depth} kind={kind} message={`${header}${summary}`} />;
		}

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
			return <UserMessageLine depth={depth} text={String(data.text ?? "")} />;

		case "perceive":
			return <UserMessageLine depth={depth} text={String(data.goal ?? "")} />;

		default:
			return null;
	}
}
