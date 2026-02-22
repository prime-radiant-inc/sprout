/** Constraints governing agent behavior */
export interface AgentConstraints {
	max_turns: number;
	max_depth: number;
	timeout_ms: number;
	can_spawn: boolean;
	can_learn: boolean;
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
	capabilities: string[];
	constraints: AgentConstraints;
	tags: string[];
	version: number;
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
}

/** Result of an Act delegation to a subagent */
export interface ActResult {
	agent_name: string;
	goal: string;
	output: string;
	success: boolean;
	stumbles: number;
	turns: number;
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
	| "error";

/** A typed event emitted by the agent for host application consumption */
export interface SessionEvent {
	kind: EventKind;
	timestamp: number;
	agent_id: string;
	depth: number;
	data: Record<string, unknown>;
}
