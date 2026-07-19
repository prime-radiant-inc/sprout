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
	timeout_ms: number;
	can_spawn: boolean;
	can_learn: boolean;
	/**
	 * If true, the agent must make at least one real tool call before it can
	 * complete. This is for tool-specialist agents where text-only completion is
	 * almost always a fabricated result.
	 */
	requires_tool_use?: boolean;
	/** Glob patterns restricting which paths the agent can write to. If omitted, all paths allowed.
	 * Paths are resolved (~ expanded, relative paths made absolute) before matching.
	 * Incompatible with the exec capability — agents with exec can bypass file write restrictions. */
	allowed_write_paths?: string[];
}

/** Default agent constraints */
export const DEFAULT_CONSTRAINTS: AgentConstraints = {
	max_turns: 50,
	timeout_ms: 300_000,
	can_spawn: true,
	can_learn: false,
};

/** Absolute agent tree depth limit. Root is depth 0, deepest allowed child is depth 8. */
export const MAX_AGENT_DEPTH = 8;

export type PromptCacheTtl = "5m" | "1h";

export interface AgentPromptCacheConfig {
	enabled: true;
	ttl?: PromptCacheTtl;
}

export interface AgentSubcorticalRecallConfig {
	enabled?: boolean;
	max_tokens?: number;
}

export interface AgentSamplingConfig {
	temperature?: number;
}

export const MAX_AGENT_OUTPUT_TOKENS = 131_072;

export interface AgentOutputConfig {
	max_tokens: number;
}

export function normalizeAgentTaskPayloadConfig(raw: unknown, source: string): true {
	if (raw !== true) {
		throw new Error(`Invalid agent markdown at ${source}: 'task_payload' must be boolean true`);
	}
	return true;
}

export function normalizeAgentOutputConfig(raw: unknown, source: string): AgentOutputConfig {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Invalid agent markdown at ${source}: 'output' must be an object`);
	}

	const config = raw as Record<string, unknown>;
	for (const key of Object.keys(config)) {
		if (key !== "max_tokens") {
			throw new Error(`Invalid agent markdown at ${source}: unknown output key '${key}'`);
		}
	}
	const maxTokens = config.max_tokens;
	if (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
		throw new Error(
			`Invalid agent markdown at ${source}: 'output.max_tokens' must be a positive safe integer`,
		);
	}
	if (maxTokens > MAX_AGENT_OUTPUT_TOKENS) {
		throw new Error(
			`Invalid agent markdown at ${source}: 'output.max_tokens' must be at most ${MAX_AGENT_OUTPUT_TOKENS}`,
		);
	}

	return { max_tokens: maxTokens };
}

export function normalizeAgentPromptCacheConfig(
	raw: unknown,
	source: string,
): AgentPromptCacheConfig {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Invalid agent markdown at ${source}: 'prompt_cache' must be an object`);
	}

	const config = raw as Record<string, unknown>;
	for (const key of Object.keys(config)) {
		if (key !== "enabled" && key !== "ttl") {
			throw new Error(`Invalid agent markdown at ${source}: unknown prompt_cache key '${key}'`);
		}
	}
	if (config.enabled !== true) {
		throw new Error(
			`Invalid agent markdown at ${source}: 'prompt_cache.enabled' must be boolean true`,
		);
	}
	const ttl = config.ttl;
	if (ttl !== undefined && ttl !== "5m" && ttl !== "1h") {
		throw new Error(`Invalid agent markdown at ${source}: 'prompt_cache.ttl' must be 5m or 1h`);
	}

	return ttl ? { enabled: true, ttl } : { enabled: true };
}

const ANTHROPIC_THINKING_MIN_BUDGET_TOKENS = 1024;

export type AgentThinkingConfig = boolean | { budget_tokens: number };

export function normalizeAgentThinkingConfig(raw: unknown, source: string): AgentThinkingConfig {
	if (typeof raw === "boolean") return raw;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Invalid agent markdown at ${source}: 'thinking' must be a boolean or object`);
	}

	const config = raw as Record<string, unknown>;
	for (const key of Object.keys(config)) {
		if (key !== "budget_tokens") {
			throw new Error(`Invalid agent markdown at ${source}: unknown thinking key '${key}'`);
		}
	}
	const budgetTokens = config.budget_tokens;
	if (typeof budgetTokens !== "number" || !Number.isInteger(budgetTokens) || budgetTokens <= 0) {
		throw new Error(
			`Invalid agent markdown at ${source}: 'thinking.budget_tokens' must be a positive integer`,
		);
	}
	if (budgetTokens < ANTHROPIC_THINKING_MIN_BUDGET_TOKENS) {
		throw new Error(
			`Invalid agent markdown at ${source}: 'thinking.budget_tokens' must be at least ${ANTHROPIC_THINKING_MIN_BUDGET_TOKENS}`,
		);
	}

	return { budget_tokens: budgetTokens };
}

export function normalizeAgentSamplingConfig(raw: unknown, source: string): AgentSamplingConfig {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Invalid agent markdown at ${source}: 'sampling' must be an object`);
	}

	const config = raw as Record<string, unknown>;
	for (const key of Object.keys(config)) {
		if (key !== "temperature") {
			throw new Error(`Invalid agent markdown at ${source}: unknown sampling key '${key}'`);
		}
	}
	const temperature = config.temperature;
	if (temperature !== undefined) {
		if (typeof temperature !== "number" || !Number.isFinite(temperature)) {
			throw new Error(
				`Invalid agent markdown at ${source}: 'sampling.temperature' must be a number`,
			);
		}
		if (temperature < 0 || temperature > 2) {
			throw new Error(
				`Invalid agent markdown at ${source}: 'sampling.temperature' must be between 0 and 2`,
			);
		}
	}

	return config as AgentSamplingConfig;
}

export type ObserverTargetConfig = "root" | "session";

export interface ObserverDeliveryConfig {
	max_events?: number;
	max_chars?: number;
}

export interface ObserverEveryTriggerConfig {
	every: number;
	event: EventKind;
}

export interface AgentObserverConfig {
	agent: string;
	target: ObserverTargetConfig;
	events: EventKind[];
	trigger: ObserverEveryTriggerConfig;
	delivery?: ObserverDeliveryConfig;
}

export interface AgentDelegateObserverConfig {
	agent: string;
	trigger: "on_delegate_final";
	events: EventKind[];
	delivery?: ObserverDeliveryConfig;
}

export type ObserverSubscriptionConfig = AgentObserverConfig | AgentDelegateObserverConfig;

const AGENT_CONSTRAINT_KEYS = new Set([
	"max_turns",
	"timeout_ms",
	"can_spawn",
	"can_learn",
	"requires_tool_use",
	"allowed_write_paths",
]);

export function normalizeAgentConstraints(
	rawConstraints: unknown,
	source: string,
): AgentConstraints {
	if (rawConstraints === undefined || rawConstraints === null) {
		return { ...DEFAULT_CONSTRAINTS };
	}
	if (typeof rawConstraints !== "object" || Array.isArray(rawConstraints)) {
		throw new Error(`Invalid agent constraints at ${source}: 'constraints' must be an object`);
	}

	const constraints = rawConstraints as Record<string, unknown>;
	for (const key of Object.keys(constraints)) {
		if (!AGENT_CONSTRAINT_KEYS.has(key)) {
			throw new Error(`Invalid agent constraints at ${source}: unknown constraint '${key}'`);
		}
	}

	return { ...DEFAULT_CONSTRAINTS, ...constraints } as AgentConstraints;
}

/** Complete specification for an agent in the genome */
export interface AgentSpec {
	name: string;
	description: string;
	system_prompt: string;
	model: string;
	constraints: AgentConstraints;
	tags: string[];
	version: number;
	/** Enable extended thinking for Anthropic models. Budget tokens default to 10000. */
	thinking?: AgentThinkingConfig;
	/** Optional sampling controls for this agent's planning requests. */
	sampling?: AgentSamplingConfig;
	/** Optional planning request output-token budget. */
	output?: AgentOutputConfig;
	/** Opt into structured delegation task payloads. */
	task_payload?: true;
	/** Prompt cache control for providers that support explicit cache routing. */
	prompt_cache?: AgentPromptCacheConfig;
	/** Optional LLM pre-pass that expands the root recall query before deterministic recall. */
	subcortical_recall?: boolean | AgentSubcorticalRecallConfig;
	/** Static observer agents attached to this agent or session. */
	observers?: AgentObserverConfig[];
	/** Observer agents attached to delegations made by this agent. */
	observe_delegates?: AgentDelegateObserverConfig[];
	/** Primitive tool names this agent can use. */
	tools: string[];
	/** Sub-agent names this agent can delegate to. */
	agents: string[];
	/** Bag for unknown frontmatter fields that survive parse→serialize round-trips. */
	_extra?: Record<string, unknown>;
}

/**
 * Whether an agent spec is allowed to run with zero tools. Ordinary tool-less
 * agents hallucinate tool calls, so the run loop rejects them — except two shapes:
 *
 * - Observer watchers: a tagged observer whose only job is to watch a frame and
 *   optionally comment (no tools, no delegatable agents).
 * - Pure single-turn completion agents: `tools: []` with `max_turns: 1`. One turn
 *   with no tools cannot hallucinate a tool call into anything — it simply
 *   completes with its reply (the utility/llm-call shape, spec §5).
 */
export function canRunWithoutTools(spec: AgentSpec): boolean {
	const observerWatcher =
		spec.tags.includes("observer") && spec.tools.length === 0 && spec.agents.length === 0;
	const singleTurnCompletion = spec.tools.length === 0 && spec.constraints.max_turns === 1;
	return observerWatcher || singleTurnCompletion;
}

/**
 * Whether an agent spec may run in the owning agent's process instead of a
 * subprocess (spec §5 featherweight placement). Restricted to single-turn,
 * no-tool, no-spawn leaves — exactly the utility/llm-call shape — so a fan-out
 * of many such calls avoids paying a subprocess + bus handshake per call.
 */
export function isFeatherweightEligible(spec: AgentSpec): boolean {
	return (
		spec.tools.length === 0 &&
		spec.agents.length === 0 &&
		spec.constraints.can_spawn === false &&
		spec.constraints.max_turns === 1
	);
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
	memory_block?: string;
	surfaced_memory_ids?: string[];
}

/** A delegation from Plan to Act — goal-directed, not instruction-directed */
export interface Delegation {
	call_id: string;
	agent_name: string;
	goal: string;
	/** Short summary (≤10 words) shown in tree/headers instead of the full goal */
	description?: string;
	hints?: string[];
	/** Structured JSON payload for agents that opt into task_payload. */
	payload?: Record<string, unknown>;
	/** If false, delegation runs asynchronously and returns a handle. Default: true */
	blocking?: boolean;
	/** If true, the agent stays alive after completion and can receive follow-up messages. Default: false */
	shared?: boolean;
	/** Per-spawn model override (spec §5): a tier or "provider:model" selection string. */
	model?: string;
	/** Env grants for the child: alias → a value name or ulid in the caller's scope. */
	env?: Record<string, string>;
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
	/** Env grants for the target: alias → a value name or ulid in the caller's scope. */
	env?: Record<string, string>;
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
	/** Set for cell-originated spawns (sap spec §4 deviation #4): tags the
	 * signal with the owning cell so cell-level verify never re-signals it. */
	cell_id?: string;
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
	schema_version?: number;
	short_id?: string;
	text?: string;
	created_at?: number;
	updated_at?: number;
	last_accessed_at?: number;
	access_count?: number;
	mention_count?: number;
	importance_score?: number;
	effective_importance?: number;
	embedding?: MemoryEmbeddingRef;
	outbound_links?: MemoryLinkEntry[];
	inbound_links?: MemoryLinkEntry[];
	entity_links?: EntityLinkEntry[];
	annotations?: AnnotationEntry[];
	project_ids?: string[];
	source_segment_id?: string;
	source_session_id?: string;
	happens_at?: number;
	expires_at?: number;
	archived_at?: number;
	archived_reason?: string;
	superseded_by?: string;
	consolidates_memory_ids?: string[];
	consolidation_rejection_count?: number;
	activity_days_at_creation?: number;
	activity_days_at_last_access?: number;
}

export interface MemoryEmbeddingRef {
	provider: string;
	model: string;
	dimensions: number;
	status: "pending" | "ready" | "failed";
	vector?: number[];
	vector_id?: string;
	embedded_at?: number;
	error?: string;
}

export interface MemoryLinkEntry {
	uuid: string;
	type: RelationshipType;
	reasoning: string;
	created_at: number;
	extraction_bond?: string;
}

export interface EntityLinkEntry {
	uuid: string;
	type: "PROJECT" | "LIBRARY" | "FILE_PATH" | "COMMAND" | "ERROR_TYPE" | "TECHNOLOGY" | "PERSON";
	name: string;
	archived_aliases?: EntityAliasEntry[];
}

export interface EntityAliasEntry {
	uuid: string;
	name: string;
	archived_at: number;
	reason: string;
}

export interface AnnotationEntry {
	text: string;
	created_at: number;
	source: string;
	archived_source_ids?: string[];
	source_segment_ids?: string[];
}

export type RelationshipType =
	| "corroborates"
	| "conflicts"
	| "supersedes"
	| "refines"
	| "precedes"
	| "contextualizes"
	| "exemplifies"
	| "extraction_ref"
	| "null";

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
	/** Values this call bound into the sap store (capture, sap spec §2). */
	boundValues?: Array<{ name: string; ulid: string; size: number }>;
	/**
	 * The call's RAW source content (sap spec §2: capture stores source bytes,
	 * never renderings). Capture-capable primitives populate this — exec's raw
	 * stdout (stderr separately), read_file's raw slice, grep's structured
	 * matches as JSON, fetch's raw body. Capture layers (explicit bind and
	 * registry auto-capture) bind from here; when absent, nothing is captured.
	 */
	captureSource?: {
		content: string;
		type: "text" | "json";
		/** exec only: raw stderr, when non-empty. */
		stderr?: string;
	};
	/**
	 * Execution metrics for telemetry consumers (cell: computeTimeMs/totalMs).
	 * Never rendered into the transcript.
	 */
	metrics?: Record<string, number>;
	/**
	 * Cell accounting (sap spec §4): failed-child count + own-error count.
	 * When present, it replaces the at-most-1 boolean stumble in run counters.
	 */
	stumbleCount?: number;
	/**
	 * The failure was infrastructure (store restart, worker death, spawn
	 * transport), not model error: zero stumbles, a warning event instead.
	 */
	infrastructure?: boolean;
}

export const EVENT_KINDS = [
	"session_start",
	"session_end",
	"perceive",
	"recall",
	"plan_start",
	"plan_delta",
	"plan_end",
	"llm_start",
	"llm_chunk",
	"llm_end",
	"act_start",
	"act_end",
	"primitive_start",
	"primitive_end",
	"cell_end",
	"verify",
	"learn_signal",
	"learn_start",
	"learn_mutation",
	"learn_end",
	"steering",
	"agent_message",
	"warning",
	"error",
	"session_resume",
	"session_clear",
	"context_update",
	"compaction",
	"interrupted",
	"exit_hint",
	"log",
	"task_update",
] as const;

/** All event kinds emitted by the agent loop */
export type EventKind = (typeof EVENT_KINDS)[number];

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

export type { SessionSelectionSnapshot } from "../host/session-selection.ts";
export type {
	SettingsCommand,
	SettingsCommandResult,
	SettingsSnapshot,
} from "../host/settings/control-plane.ts";
export type {
	MemoryModelPurpose,
	ModelRef,
	ProviderConfig,
	ProviderKind,
	SessionModelSelection,
} from "../shared/provider-settings.ts";
export type { SessionSelectionRequest } from "../shared/session-selection.ts";
