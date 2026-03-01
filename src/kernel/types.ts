/** Built-in primitive tool names that agents cannot shadow. */
export const KERNEL_PRIMITIVE_NAMES = new Set([
	"read_file",
	"write_file",
	"edit_file",
	"apply_patch",
	"exec",
	"grep",
	"glob",
	"fetch",
]);

/** Core loop phases and the learn process itself — reserved by the kernel. */
export const KERNEL_RESERVED_NAMES = new Set([
	"learn",
	"kernel",
	"perceive",
	"recall",
	"plan",
	"act",
	"verify",
]);

/** Throws if the given name collides with a kernel primitive or reserved name. */
export function validateAgentName(name: string): void {
	if (KERNEL_PRIMITIVE_NAMES.has(name)) {
		throw new Error(
			`Cannot create agent '${name}': name is a kernel primitive and cannot be shadowed`,
		);
	}
	if (KERNEL_RESERVED_NAMES.has(name)) {
		throw new Error(`Cannot create agent '${name}': name is reserved by the kernel`);
	}
}

/** Constraints governing agent behavior */
export interface AgentConstraints {
	max_turns: number;
	max_depth: number;
	timeout_ms: number;
	can_spawn: boolean;
	can_learn: boolean;
	/** Glob patterns restricting which paths the agent can write to. If omitted, all paths allowed.
	 * Paths are resolved (~ expanded, relative paths made absolute) before matching.
	 * Incompatible with the exec capability — agents with exec can bypass file write restrictions. */
	allowed_write_paths?: string[];
}

/** Default agent constraints */
export const DEFAULT_CONSTRAINTS: AgentConstraints = {
	max_turns: 50,
	max_depth: 3,
	timeout_ms: 300_000,
	can_spawn: true,
	can_learn: false,
};

/** Complete specification for an agent in the genome */
export interface AgentSpec {
	name: string;
	description: string;
	system_prompt: string;
	model: string;
	constraints: AgentConstraints;
	tags: string[];
	version: number;
	/** Enable extended thinking (Anthropic models). Budget tokens default to 10000. */
	thinking?: boolean | { budget_tokens: number };
	/** Primitive tool names this agent can use. */
	tools: string[];
	/** Sub-agent names this agent can delegate to. */
	agents: string[];
	/** Bag for unknown frontmatter fields that survive parse→serialize round-trips. */
	_extra?: Record<string, unknown>;
}

/** Input collected during the Perceive phase */
export interface Perception {
	inputs: PerceptionInput[];
	env_state: Record<string, unknown>;
	timestamp: number;
}

export interface PerceptionInput {
	role: string;
	content: string;
}

/** Results from the Recall phase — genome search */
export interface RecallResult {
	agents: AgentSpec[];
	memories: Memory[];
	routing_hints: RoutingRule[];
}

/** A delegation from Plan to Act — goal-directed, not instruction-directed */
export interface Delegation {
	call_id: string;
	agent_name: string;
	goal: string;
	hints?: string[];
	/** If false, delegation runs asynchronously and returns a handle. Default: true */
	blocking?: boolean;
	/** If true, the agent stays alive after completion and can receive follow-up messages. Default: false */
	shared?: boolean;
}

/** Wait for a non-blocking agent to finish and collect its result */
export interface WaitAgentCommand {
	kind: "wait_agent";
	call_id: string;
	handle: string;
}

/** Send a follow-up message to a running (shared) agent */
export interface MessageAgentCommand {
	kind: "message_agent";
	call_id: string;
	handle: string;
	message: string;
	/** If false, returns immediately with an ack. Default: true */
	blocking?: boolean;
}

export type AgentCommand = WaitAgentCommand | MessageAgentCommand;

/** Result of an Act delegation to a subagent */
export interface ActResult {
	agent_name: string;
	goal: string;
	output: string;
	success: boolean;
	stumbles: number;
	turns: number;
	timed_out: boolean;
}

/** Result of the Verify phase */
export interface VerifyResult {
	success: boolean;
	stumbled: boolean;
	output: string;
}

/** Signal pushed to the Learn queue when a stumble is detected */
export interface LearnSignal {
	kind: LearnSignalKind;
	goal: string;
	agent_name: string;
	details: ActResult;
	session_id: string;
	timestamp: number;
}

export type LearnSignalKind = "error" | "retry" | "inefficiency" | "timeout" | "failure";

/** A learned fact or pattern stored in the genome */
export interface Memory {
	id: string;
	content: string;
	tags: string[];
	source: string;
	created: number;
	last_used: number;
	use_count: number;
	confidence: number;
}

/** A learned preference for agent selection */
export interface RoutingRule {
	id: string;
	condition: string;
	preference: string;
	strength: number;
	source: string;
}

/** Result of a primitive execution */
export interface PrimitiveResult {
	output: string;
	success: boolean;
	error?: string;
}

/** All event kinds emitted by the agent loop */
export type EventKind =
	| "session_start"
	| "session_end"
	| "perceive"
	| "recall"
	| "plan_start"
	| "plan_delta"
	| "plan_end"
	| "act_start"
	| "act_end"
	| "primitive_start"
	| "primitive_end"
	| "verify"
	| "learn_signal"
	| "learn_start"
	| "learn_mutation"
	| "learn_end"
	| "steering"
	| "warning"
	| "error"
	| "session_resume"
	| "session_clear"
	| "context_update"
	| "compaction"
	| "interrupted"
	| "exit_hint"
	| "log";

/** A typed event emitted by the agent for host application consumption */
export interface SessionEvent {
	kind: EventKind;
	timestamp: number;
	agent_id: string;
	depth: number;
	data: Record<string, unknown>;
}

/** Command kinds that flow down from frontends to the session controller */
export type CommandKind =
	| "submit_goal"
	| "steer"
	| "interrupt"
	| "compact"
	| "clear"
	| "switch_model"
	| "quit";

/** A command published by a frontend (TUI, API, test harness) */
export interface Command {
	kind: CommandKind;
	data: Record<string, unknown>;
}
