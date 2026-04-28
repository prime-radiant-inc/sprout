import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scanAgentTree } from "../../agents/loader.ts";
import { parseAgentMarkdown } from "../../agents/markdown-loader.ts";
import { type ResolverSettings, resolveAgentModelSelection } from "../../agents/model-resolver.ts";
import type { Genome } from "../../genome/genome.ts";
import type { ProviderCatalogEntry } from "../../llm/model-catalog.ts";
import type {
	AgentModelDescriptor,
	AgentModelOverride,
	SproutSettings,
} from "../../shared/provider-settings.ts";
import type { ModelConfigOverrides } from "./model-overrides.ts";

export interface AgentModelCatalogEntry {
	key: string;
	name: string;
	source: "root" | "tree" | "overlay";
	path?: string;
	description?: string;
	defaultModel: string;
}

export interface BuildAgentModelCatalogOptions {
	rootDir?: string;
	genome?: Genome;
}

export async function buildAgentModelCatalog(
	options: BuildAgentModelCatalogOptions,
): Promise<AgentModelCatalogEntry[]> {
	const entries = new Map<string, AgentModelCatalogEntry>();
	const nameToKey = new Map<string, string>();

	if (options.rootDir) {
		await addRootAgent(options.rootDir, entries, nameToKey);
		const tree = await scanAgentTree(options.rootDir);
		for (const [path, entry] of tree) {
			addEntry(
				entries,
				nameToKey,
				{
					key: path,
					name: entry.spec.name,
					source: "tree",
					path,
					description: entry.spec.description,
					defaultModel: entry.spec.model,
				},
				"root tree",
			);
		}
	}

	const overlayAgents =
		typeof options.genome?.overlayAgents === "function" ? options.genome.overlayAgents() : [];
	for (const spec of overlayAgents) {
		const existingKey = nameToKey.get(spec.name);
		if (existingKey) {
			entries.set(existingKey, {
				...entries.get(existingKey)!,
				source: "overlay",
				description: spec.description,
				defaultModel: spec.model,
			});
			continue;
		}
		addEntry(
			entries,
			nameToKey,
			{
				key: spec.name,
				name: spec.name,
				source: "overlay",
				description: spec.description,
				defaultModel: spec.model,
			},
			"genome overlay",
		);
	}

	return [...entries.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function describeAgentModels(input: {
	catalog: AgentModelCatalogEntry[];
	settings: Pick<SproutSettings, "providers" | "defaults" | "memoryModels" | "agentModelOverrides">;
	modelOverrides: ModelConfigOverrides;
	resolverSettings: ResolverSettings;
	providerCatalog: ProviderCatalogEntry[];
}): AgentModelDescriptor[] {
	return input.catalog.map((entry) => {
		const storedOverride = input.settings.agentModelOverrides[entry.key];
		const runtimeOverride = input.modelOverrides.agentModelOverrides[entry.key];
		const effectiveOverride = runtimeOverride?.selection ?? storedOverride;
		return {
			...entry,
			...(storedOverride ? { storedOverride } : {}),
			...(runtimeOverride ? { runtimeOverride } : {}),
			effective: describeEffectiveSelection({
				entry,
				override: effectiveOverride,
				resolverSettings: input.resolverSettings,
				providerCatalog: input.providerCatalog,
			}),
		};
	});
}

async function addRootAgent(
	rootDir: string,
	entries: Map<string, AgentModelCatalogEntry>,
	nameToKey: Map<string, string>,
): Promise<void> {
	const rootPath = join(rootDir, "root.md");
	let content: string;
	try {
		content = await readFile(rootPath, "utf-8");
	} catch {
		return;
	}
	const spec = parseAgentMarkdown(content, rootPath);
	addEntry(
		entries,
		nameToKey,
		{
			key: "root",
			name: spec.name,
			source: "root",
			description: spec.description,
			defaultModel: spec.model,
		},
		"root agent",
	);
}

function addEntry(
	entries: Map<string, AgentModelCatalogEntry>,
	nameToKey: Map<string, string>,
	entry: AgentModelCatalogEntry,
	source: string,
): void {
	if (entries.has(entry.key)) {
		throw new Error(`Duplicate agent model key '${entry.key}' while reading ${source}`);
	}
	const existingNameKey = nameToKey.get(entry.name);
	if (existingNameKey && existingNameKey !== entry.key) {
		throw new Error(
			`Duplicate agent name '${entry.name}' for model keys '${existingNameKey}' and '${entry.key}'`,
		);
	}
	entries.set(entry.key, entry);
	nameToKey.set(entry.name, entry.key);
}

function describeEffectiveSelection(input: {
	entry: AgentModelCatalogEntry;
	override?: AgentModelOverride;
	resolverSettings: ResolverSettings;
	providerCatalog: ProviderCatalogEntry[];
}): AgentModelDescriptor["effective"] {
	const selection = input.override ?? parseDefaultSelection(input.entry);
	const label = formatSelection(selection, input.entry.defaultModel);
	try {
		const model = resolveAgentModelSelection(
			{
				agentKey: input.entry.key,
				agentName: input.entry.name,
				specModel: input.entry.defaultModel,
				settings: input.resolverSettings,
			},
			input.providerCatalog,
		);
		return {
			selection: input.override ? selection.kind : "default",
			label,
			model: {
				providerId: model.provider,
				modelId: model.model,
			},
		};
	} catch (error) {
		return {
			selection: input.override ? selection.kind : "default",
			label,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function parseDefaultSelection(entry: AgentModelCatalogEntry): AgentModelOverride & {
	kind: "tier" | "model";
} {
	if (
		entry.defaultModel === "best" ||
		entry.defaultModel === "balanced" ||
		entry.defaultModel === "fast"
	) {
		return { kind: "tier", tier: entry.defaultModel };
	}
	const separatorIndex = entry.defaultModel.indexOf(":");
	if (separatorIndex > 0 && separatorIndex < entry.defaultModel.length - 1) {
		return {
			kind: "model",
			model: {
				providerId: entry.defaultModel.slice(0, separatorIndex),
				modelId: entry.defaultModel.slice(separatorIndex + 1),
			},
		};
	}
	return {
		kind: "model",
		model: {
			providerId: "",
			modelId: entry.defaultModel,
		},
	};
}

function formatSelection(selection: AgentModelOverride, defaultModel: string): string {
	if (selection.kind === "tier") return selection.tier;
	if (selection.model.providerId) {
		return `${selection.model.providerId}:${selection.model.modelId}`;
	}
	return defaultModel;
}
