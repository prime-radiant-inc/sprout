import { parse, stringify } from "yaml";
import {
	type AgentDelegateObserverConfig,
	type AgentObserverConfig,
	type AgentSpec,
	type AgentSubcorticalRecallConfig,
	EVENT_KINDS,
	type EventKind,
	type ObserverCommentPolicyConfig,
	type ObserverCommentRecipient,
	type ObserverDeliveryConfig,
	type ObserverTargetConfig,
	normalizeAgentConstraints,
} from "../kernel/types.ts";
import { parseAgentModelInput } from "../shared/session-selection.ts";

/**
 * Parse an agent spec from a YAML-fronted Markdown file.
 * Frontmatter provides structured fields; the markdown body becomes system_prompt.
 */
export function parseAgentMarkdown(content: string, source: string): AgentSpec {
	const crlf = content.startsWith("---\r\n");
	const lf = content.startsWith("---\n");
	if (!lf && !crlf) {
		throw new Error(`Invalid agent markdown at ${source}: missing frontmatter delimiter`);
	}

	const fmStart = crlf ? 5 : 4;
	const endDelimiter = crlf ? "\r\n---\r\n" : "\n---\n";
	const actualEnd = content.indexOf(endDelimiter, fmStart);
	if (actualEnd === -1) {
		throw new Error(`Invalid agent markdown at ${source}: missing closing frontmatter delimiter`);
	}

	const frontmatterStr = content.slice(fmStart, actualEnd);
	const bodyStart = actualEnd + endDelimiter.length;
	const body = content.slice(bodyStart).trim();

	const raw = parse(frontmatterStr);

	for (const field of ["name", "description", "model"] as const) {
		if (!raw[field] || typeof raw[field] !== "string") {
			throw new Error(`Invalid agent markdown at ${source}: missing or invalid '${field}'`);
		}
	}
	try {
		parseAgentModelInput(raw.model);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid agent markdown at ${source}: ${message}`);
	}

	if (raw.tools != null && !Array.isArray(raw.tools)) {
		throw new Error(`Invalid agent markdown at ${source}: 'tools' must be an array`);
	}
	if (raw.agents != null && !Array.isArray(raw.agents)) {
		throw new Error(`Invalid agent markdown at ${source}: 'agents' must be an array`);
	}
	const tools: string[] = raw.tools ?? [];
	const agents: string[] = raw.agents ?? [];

	const spec: AgentSpec = {
		name: raw.name,
		description: raw.description,
		system_prompt: body,
		model: raw.model,
		tools,
		agents,
		constraints: normalizeAgentConstraints(raw.constraints, source),
		tags: raw.tags ?? [],
		version: raw.version ?? 1,
	};
	if (raw.thinking !== undefined) {
		spec.thinking = raw.thinking;
	}
	if (raw.prompt_cache !== undefined) {
		spec.prompt_cache = raw.prompt_cache;
	}
	if (raw.subcortical_recall !== undefined) {
		spec.subcortical_recall = normalizeSubcorticalRecallConfig(raw.subcortical_recall, source);
	}
	if (raw.observers !== undefined) {
		spec.observers = normalizeObserverConfigs(raw.observers, source);
	}
	if (raw.observe_delegates !== undefined) {
		spec.observe_delegates = normalizeDelegateObserverConfigs(raw.observe_delegates, source);
	}

	const extra: Record<string, unknown> = {};
	for (const key of Object.keys(raw)) {
		if (!KNOWN_FIELDS.has(key)) {
			extra[key] = raw[key];
		}
	}
	if (Object.keys(extra).length > 0) {
		spec._extra = extra;
	}

	return spec;
}

function normalizeSubcorticalRecallConfig(
	raw: unknown,
	source: string,
): boolean | AgentSubcorticalRecallConfig {
	if (typeof raw === "boolean") return raw;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(
			`Invalid agent markdown at ${source}: 'subcortical_recall' must be a boolean or object`,
		);
	}

	const config = raw as Record<string, unknown>;
	for (const key of Object.keys(config)) {
		if (key !== "enabled" && key !== "max_tokens") {
			throw new Error(
				`Invalid agent markdown at ${source}: unknown subcortical_recall key '${key}'`,
			);
		}
	}
	if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
		throw new Error(
			`Invalid agent markdown at ${source}: 'subcortical_recall.enabled' must be a boolean`,
		);
	}
	const maxTokens = config.max_tokens;
	if (
		maxTokens !== undefined &&
		(typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0)
	) {
		throw new Error(
			`Invalid agent markdown at ${source}: 'subcortical_recall.max_tokens' must be a positive integer`,
		);
	}

	return config as AgentSubcorticalRecallConfig;
}

const OBSERVER_TARGETS = new Set<ObserverTargetConfig>(["root", "session"]);
const OBSERVER_COMMENT_RECIPIENTS = new Set<ObserverCommentRecipient>([
	"root",
	"target",
	"caller",
]);
const EVENT_KIND_NAMES = new Set<string>(EVENT_KINDS);

function normalizeObserverConfigs(raw: unknown, source: string): AgentObserverConfig[] {
	if (!Array.isArray(raw)) {
		throw new Error(`Invalid agent markdown at ${source}: 'observers' must be an array`);
	}
	return raw.map((entry, index) => normalizeObserverConfig(entry, source, `observers[${index}]`));
}

function normalizeObserverConfig(
	raw: unknown,
	source: string,
	path: string,
): AgentObserverConfig {
	const config = requireRecord(raw, source, path);
	requireKnownKeys(config, source, path, [
		"agent",
		"target",
		"events",
		"trigger",
		"delivery",
		"comments",
	]);

	const agent = normalizeObserverAgentName(config.agent, source, `${path}.agent`);
	const target = normalizeObserverTarget(config.target, source, `${path}.target`);
	const events = normalizeEventKinds(config.events, source, `${path}.events`);
	const trigger = normalizeEveryTrigger(config.trigger, events, source, `${path}.trigger`);
	const delivery = normalizeObserverDelivery(config.delivery, source, `${path}.delivery`);
	const comments = normalizeObserverComments(config.comments, source, `${path}.comments`);

	return { agent, target, events, trigger, delivery, comments };
}

function normalizeDelegateObserverConfigs(
	raw: unknown,
	source: string,
): AgentDelegateObserverConfig[] {
	if (!Array.isArray(raw)) {
		throw new Error(
			`Invalid agent markdown at ${source}: 'observe_delegates' must be an array`,
		);
	}
	return raw.map((entry, index) =>
		normalizeDelegateObserverConfig(entry, source, `observe_delegates[${index}]`),
	);
}

function normalizeDelegateObserverConfig(
	raw: unknown,
	source: string,
	path: string,
): AgentDelegateObserverConfig {
	const config = requireRecord(raw, source, path);
	requireKnownKeys(config, source, path, ["agent", "trigger", "events", "delivery", "comments"]);

	const agent = normalizeObserverAgentName(config.agent, source, `${path}.agent`);
	if (config.trigger !== "on_delegate_final") {
		throw new Error(
			`Invalid agent markdown at ${source}: '${path}.trigger' must be on_delegate_final`,
		);
	}
	const events = normalizeEventKinds(config.events, source, `${path}.events`);
	if (!events.includes("act_end")) {
		throw new Error(
			`Invalid agent markdown at ${source}: '${path}.events' must include act_end`,
		);
	}
	const delivery = normalizeObserverDelivery(config.delivery, source, `${path}.delivery`);
	const comments = normalizeObserverComments(config.comments, source, `${path}.comments`);

	return { agent, trigger: "on_delegate_final", events, delivery, comments };
}

function normalizeObserverAgentName(raw: unknown, source: string, path: string): string {
	if (typeof raw !== "string" || raw.trim() === "") {
		throw new Error(`Invalid agent markdown at ${source}: '${path}' must be a non-empty string`);
	}
	return raw.trim();
}

function normalizeObserverTarget(
	raw: unknown,
	source: string,
	path: string,
): ObserverTargetConfig {
	if (typeof raw !== "string" || !OBSERVER_TARGETS.has(raw as ObserverTargetConfig)) {
		throw new Error(`Invalid agent markdown at ${source}: '${path}' must be root or session`);
	}
	return raw as ObserverTargetConfig;
}

function normalizeEventKinds(raw: unknown, source: string, path: string): EventKind[] {
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new Error(`Invalid agent markdown at ${source}: '${path}' must be a non-empty array`);
	}
	return raw.map((event, index) => normalizeEventKind(event, source, `${path}[${index}]`));
}

function normalizeEventKind(raw: unknown, source: string, path: string): EventKind {
	if (typeof raw !== "string" || !EVENT_KIND_NAMES.has(raw)) {
		throw new Error(`Invalid agent markdown at ${source}: '${path}' is not a known event kind`);
	}
	return raw as EventKind;
}

function normalizeEveryTrigger(
	raw: unknown,
	events: EventKind[],
	source: string,
	path: string,
): AgentObserverConfig["trigger"] {
	const trigger = requireRecord(raw, source, path);
	requireKnownKeys(trigger, source, path, ["every", "event"]);
	const every = trigger.every;
	if (typeof every !== "number" || !Number.isInteger(every) || every <= 0) {
		throw new Error(
			`Invalid agent markdown at ${source}: '${path}.every' must be a positive integer`,
		);
	}
	const event = normalizeEventKind(trigger.event, source, `${path}.event`);
	if (!events.includes(event)) {
		throw new Error(
			`Invalid agent markdown at ${source}: '${path}.event' must also be listed in events`,
		);
	}
	return { every, event };
}

function normalizeObserverDelivery(
	raw: unknown,
	source: string,
	path: string,
): ObserverDeliveryConfig | undefined {
	if (raw === undefined) return undefined;
	const delivery = requireRecord(raw, source, path);
	requireKnownKeys(delivery, source, path, ["max_events", "max_chars"]);
	const normalized: ObserverDeliveryConfig = {};
	if (delivery.max_events !== undefined) {
		normalized.max_events = normalizePositiveInteger(delivery.max_events, source, `${path}.max_events`);
	}
	if (delivery.max_chars !== undefined) {
		normalized.max_chars = normalizePositiveInteger(delivery.max_chars, source, `${path}.max_chars`);
	}
	return normalized;
}

function normalizeObserverComments(
	raw: unknown,
	source: string,
	path: string,
): ObserverCommentPolicyConfig | undefined {
	if (raw === undefined) return undefined;
	const comments = requireRecord(raw, source, path);
	requireKnownKeys(comments, source, path, ["can_message", "default_recipient"]);
	const normalized: ObserverCommentPolicyConfig = {};
	if (comments.can_message !== undefined) {
		if (!Array.isArray(comments.can_message) || comments.can_message.length === 0) {
			throw new Error(
				`Invalid agent markdown at ${source}: '${path}.can_message' must be a non-empty array`,
			);
		}
		normalized.can_message = comments.can_message.map((recipient, index) =>
			normalizeCommentRecipient(recipient, source, `${path}.can_message[${index}]`),
		);
	}
	if (comments.default_recipient !== undefined) {
		const recipient = normalizeCommentRecipient(
			comments.default_recipient,
			source,
			`${path}.default_recipient`,
		);
		if (normalized.can_message && !normalized.can_message.includes(recipient)) {
			throw new Error(
				`Invalid agent markdown at ${source}: '${path}.default_recipient' must be listed in can_message`,
			);
		}
		normalized.default_recipient = recipient;
	}
	return normalized;
}

function normalizeCommentRecipient(
	raw: unknown,
	source: string,
	path: string,
): ObserverCommentRecipient {
	if (typeof raw !== "string" || !OBSERVER_COMMENT_RECIPIENTS.has(raw as ObserverCommentRecipient)) {
		throw new Error(
			`Invalid agent markdown at ${source}: '${path}' must be root, target, or caller`,
		);
	}
	return raw as ObserverCommentRecipient;
}

function normalizePositiveInteger(raw: unknown, source: string, path: string): number {
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
		throw new Error(`Invalid agent markdown at ${source}: '${path}' must be a positive integer`);
	}
	return raw;
}

function requireRecord(raw: unknown, source: string, path: string): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Invalid agent markdown at ${source}: '${path}' must be an object`);
	}
	return raw as Record<string, unknown>;
}

function requireKnownKeys(
	raw: Record<string, unknown>,
	source: string,
	path: string,
	knownKeys: string[],
): void {
	const known = new Set(knownKeys);
	for (const key of Object.keys(raw)) {
		if (!known.has(key)) {
			throw new Error(`Invalid agent markdown at ${source}: unknown ${path} key '${key}'`);
		}
	}
}

const KNOWN_FIELDS = new Set([
	"name",
	"description",
	"model",
	"tools",
	"agents",
	"constraints",
	"tags",
	"version",
	"thinking",
	"prompt_cache",
	"subcortical_recall",
	"observers",
	"observe_delegates",
	"system_prompt",
]);

/**
 * Serialize an AgentSpec to YAML-fronted Markdown.
 * Known fields go into frontmatter; system_prompt becomes the markdown body.
 * Unknown fields stored in _extra are merged into frontmatter to survive round-trips.
 */
export function serializeAgentMarkdown(spec: AgentSpec): string {
	const fm: Record<string, unknown> = {
		name: spec.name,
		description: spec.description,
		model: spec.model,
		tools: spec.tools,
		agents: spec.agents,
		constraints: spec.constraints,
		tags: spec.tags,
		version: spec.version,
	};
	if (spec.thinking !== undefined) {
		fm.thinking = spec.thinking;
	}
	if (spec.prompt_cache !== undefined) {
		fm.prompt_cache = spec.prompt_cache;
	}
	if (spec.subcortical_recall !== undefined) {
		fm.subcortical_recall = spec.subcortical_recall;
	}
	if (spec.observers !== undefined) {
		fm.observers = spec.observers;
	}
	if (spec.observe_delegates !== undefined) {
		fm.observe_delegates = spec.observe_delegates;
	}
	if (spec._extra) {
		for (const [key, value] of Object.entries(spec._extra)) {
			if (!KNOWN_FIELDS.has(key)) {
				fm[key] = value;
			}
		}
	}
	const yamlStr = stringify(fm);
	return `---\n${yamlStr}---\n${spec.system_prompt}\n`;
}
