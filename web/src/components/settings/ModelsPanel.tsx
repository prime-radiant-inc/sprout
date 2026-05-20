import type { SettingsCommand, SettingsSnapshot } from "@kernel/types.ts";
import {
	type AgentModelOverride,
	MEMORY_MODEL_DEFAULT_TIERS,
	MEMORY_MODEL_DESCRIPTIONS,
	MEMORY_MODEL_LABELS,
	MEMORY_MODEL_PURPOSES,
	type MemoryModelPurpose,
	type ModelRef,
	type Tier,
} from "@shared/provider-settings.ts";
import type { ReactNode } from "react";
import styles from "./ProviderSettingsPanel.module.css";

export interface ModelsPanelProps {
	settings: SettingsSnapshot;
	message?: string | null;
	fieldErrors?: Record<string, string>;
	onCommand: (command: SettingsCommand) => void;
}

const TIER_LABELS = {
	best: "Best",
	balanced: "Balanced",
	fast: "Fast",
} as const satisfies Record<Tier, string>;

const TIER_DESCRIPTIONS = {
	best: "Highest-quality general-purpose model.",
	balanced: "Default model for normal sessions.",
	fast: "Cheap, fast model for lightweight work.",
} as const satisfies Record<Tier, string>;

type ProviderModelGroup = {
	provider: SettingsSnapshot["settings"]["providers"][number];
	catalogEntry: SettingsSnapshot["catalog"][number] | undefined;
};

export function createSetMemoryModelCommand(
	purpose: MemoryModelPurpose,
	value: string,
): SettingsCommand {
	return {
		kind: "set_memory_model",
		data: {
			purpose,
			model: parseModelRef(value),
		},
	};
}

export function createSetAgentModelCommand(
	agentKey: string,
	value: string,
): SettingsCommand {
	const override = parseAgentModelOverride(value);
	return {
		kind: "set_agent_model_override",
		data: {
			agentKey,
			...(override ? { override } : {}),
		},
	};
}

export function ModelsPanel({ settings, message, fieldErrors, onCommand }: ModelsPanelProps) {
	const providerModelGroups = providerModelOptions(settings);
	const hasModelOptions = providerModelGroups.length > 0;

	return (
		<div className={styles.section}>
			<div>
				<h2 className={styles.sectionTitle}>Model assignments</h2>
				<p className={styles.sectionText}>
					Configure every model Sprout can call: global tiers, memory system models,
					and discovered agent types.
				</p>
			</div>

			{message && <div className={styles.errorBanner}>{message}</div>}
			{!hasModelOptions && (
				<div className={styles.emptyState}>Refresh provider models to configure assignments.</div>
			)}

			<div className={styles.modelAssignmentList}>
				<ModelGroup
					title="Global tiers"
					description="Named defaults that sessions and agent overrides can reference."
				>
					{(["best", "balanced", "fast"] as const).map((tier) => {
						const stored = settings.settings.defaults[tier];
						return (
							<ModelAssignmentRow
								key={tier}
								title={TIER_LABELS[tier]}
								description={TIER_DESCRIPTIONS[tier]}
								selectId={`model-assignment-tier-${tier}`}
								value={formatModelRef(stored)}
								emptyLabel="Not configured"
								storedModel={stored}
								providerModelGroups={providerModelGroups}
								fieldError={fieldErrors?.[tier]}
								notes={[
									formatModelEnvOverride(settings.runtime.modelOverrides.defaults[tier]),
								]}
								onChange={(value) =>
									onCommand({
										kind: "set_default_model",
										data: {
											slot: tier,
											model: parseModelRef(value),
										},
									})
								}
							/>
						);
					})}
				</ModelGroup>

				<ModelGroup
					title="Memory system models"
					description="Pin exact models for memory-system work, or leave rows empty to use each task's fallback tier."
				>
					{MEMORY_MODEL_PURPOSES.map((purpose) => {
						const stored = settings.settings.memoryModels[purpose];
						return (
							<ModelAssignmentRow
								key={purpose}
								title={MEMORY_MODEL_LABELS[purpose]}
								description={MEMORY_MODEL_DESCRIPTIONS[purpose]}
								selectId={`model-assignment-memory-${purpose}`}
								value={formatModelRef(stored)}
								emptyLabel={`Use default (${MEMORY_MODEL_DEFAULT_TIERS[purpose]})`}
								storedModel={stored}
								providerModelGroups={providerModelGroups}
								fieldError={fieldErrors?.[`memoryModels.${purpose}`]}
								notes={[
									formatModelEnvOverride(
										settings.runtime.modelOverrides.memoryModels[purpose],
									),
								]}
								warning={describeStoredModelDiagnostic(settings, stored)}
								onChange={(value) => onCommand(createSetMemoryModelCommand(purpose, value))}
							/>
						);
					})}
				</ModelGroup>

				<ModelGroup
					title="Agent types"
					description="Discovered agent definitions can inherit their default, use a tier, or pin a model."
				>
					{settings.agentModels.length === 0 ? (
						<div className={styles.emptyState}>No agent types discovered.</div>
					) : (
						settings.agentModels.map((agent) => {
							const effective = formatAgentEffective(agent);
							return (
								<ModelAssignmentRow
									key={agent.key}
									title={agent.key}
									description={
										agent.description ? `${agent.name}: ${agent.description}` : agent.name
									}
									selectId={`model-assignment-agent-${agent.key}`}
									value={formatAgentOverride(agent.storedOverride)}
									emptyLabel={`Use agent default (${agent.defaultModel})`}
									storedModel={
										agent.storedOverride?.kind === "model"
											? agent.storedOverride.model
											: undefined
									}
									providerModelGroups={providerModelGroups}
									fieldError={fieldErrors?.[`agentModelOverrides.${agent.key}`]}
									notes={[
										formatAgentEnvOverride(agent.runtimeOverride),
										agent.effective.error ? undefined : effective,
									]}
									warning={agent.effective.error ? effective : undefined}
									tierOptions
									onChange={(value) => onCommand(createSetAgentModelCommand(agent.key, value))}
								/>
							);
						})
					)}
				</ModelGroup>
			</div>
		</div>
	);
}

function ModelGroup({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<section className={styles.modelAssignmentGroup}>
			<div className={styles.modelAssignmentGroupHeader}>
				<h3>{title}</h3>
				<p>{description}</p>
			</div>
			<div className={styles.modelAssignmentRows}>{children}</div>
		</section>
	);
}

function ModelAssignmentRow({
	title,
	description,
	selectId,
	value,
	emptyLabel,
	storedModel,
	providerModelGroups,
	fieldError,
	notes = [],
	warning,
	tierOptions = false,
	onChange,
}: {
	title: string;
	description: string;
	selectId: string;
	value: string;
	emptyLabel: string;
	storedModel?: ModelRef;
	providerModelGroups: ProviderModelGroup[];
	fieldError?: string;
	notes?: Array<string | undefined>;
	warning?: string;
	tierOptions?: boolean;
	onChange: (value: string) => void;
}) {
	const storedValue = formatModelRef(storedModel);
	return (
		<div className={styles.modelAssignmentRow}>
			<div className={styles.modelAssignmentCopy}>
				<label className={styles.itemTitle} htmlFor={selectId}>
					{title}
				</label>
				<div className={styles.itemSubtitle}>{description}</div>
				{notes.filter(Boolean).map((note) => (
					<div className={styles.hint} key={note}>
						{note}
					</div>
				))}
				{warning && <div className={styles.messageBanner}>{warning}</div>}
				{fieldError && <div className={styles.fieldError}>{fieldError}</div>}
			</div>
			<select
				id={selectId}
				className={styles.fieldSelect}
				value={value}
				onChange={(event) => onChange(event.target.value)}
			>
				<option value="">{emptyLabel}</option>
				{tierOptions && (
					<>
						<option value="best">Best</option>
						<option value="balanced">Balanced</option>
						<option value="fast">Fast</option>
					</>
				)}
				{storedModel && !hasModelOption(providerModelGroups, storedModel) && (
					<option value={storedValue}>Stored: {storedValue}</option>
				)}
				{providerModelGroups.map(({ provider, catalogEntry }) => (
					<optgroup key={provider.id} label={provider.label}>
						{catalogEntry?.models.map((model) => (
							<option
								key={`${selectId}-${provider.id}-${model.id}`}
								value={modelOptionValue(provider, model)}
							>
								{model.label}
							</option>
						))}
					</optgroup>
				))}
			</select>
		</div>
	);
}

function providerModelOptions(settings: SettingsSnapshot): ProviderModelGroup[] {
	return settings.settings.providers
		.filter((provider) => provider.enabled)
		.map((provider) => ({
			provider,
			catalogEntry: settings.catalog.find((entry) => entry.providerId === provider.id),
		}))
		.filter((entry) => (entry.catalogEntry?.models.length ?? 0) > 0);
}

function hasModelOption(providerModelGroups: ProviderModelGroup[], modelRef: ModelRef): boolean {
	return providerModelGroups.some(
		({ provider, catalogEntry }) =>
			provider.id === modelRef.providerId &&
			(catalogEntry?.models.some((model) => model.id === modelRef.modelId) ?? false),
	);
}

function modelOptionValue(
	provider: ProviderModelGroup["provider"],
	model: NonNullable<ProviderModelGroup["catalogEntry"]>["models"][number],
): string {
	return `${provider.id}:${model.id}`;
}

export function formatModelRef(model: ModelRef | undefined): string {
	return model ? `${model.providerId}:${model.modelId}` : "";
}

export function parseModelRef(value: string): ModelRef | undefined {
	if (!value) return undefined;
	const separatorIndex = value.indexOf(":");
	if (separatorIndex <= 0 || separatorIndex === value.length - 1) return undefined;
	return {
		providerId: value.slice(0, separatorIndex),
		modelId: value.slice(separatorIndex + 1),
	};
}

function parseAgentModelOverride(value: string): AgentModelOverride | undefined {
	if (!value) return undefined;
	if (value === "best" || value === "balanced" || value === "fast") {
		return { kind: "tier", tier: value };
	}
	const model = parseModelRef(value);
	return model ? { kind: "model", model } : undefined;
}

function formatAgentOverride(override: AgentModelOverride | undefined): string {
	if (!override) return "";
	if (override.kind === "tier") return override.tier;
	return formatModelRef(override.model);
}

function formatModelEnvOverride(
	override:
		| SettingsSnapshot["runtime"]["modelOverrides"]["defaults"][Tier]
		| SettingsSnapshot["runtime"]["modelOverrides"]["memoryModels"][MemoryModelPurpose],
): string | undefined {
	if (!override) return undefined;
	const label = override.displayLabel
		? `${override.model.providerId}:${override.displayLabel}`
		: formatModelRef(override.model);
	const diagnostic =
		override.catalogStatus === "missing" && override.diagnostic
			? ` (${override.diagnostic})`
			: "";
	return `Env override ${override.envVar}: ${label}${diagnostic}`;
}

function formatAgentEnvOverride(
	override: SettingsSnapshot["agentModels"][number]["runtimeOverride"],
): string | undefined {
	if (!override) return undefined;
	const selection =
		override.selection.kind === "model" && override.displayLabel
			? `${override.selection.model.providerId}:${override.displayLabel}`
			: formatAgentOverride(override.selection);
	const diagnostic = override.diagnostic ? ` (${override.diagnostic})` : "";
	return `Env override ${override.envVar}: ${selection}${diagnostic}`;
}

function formatAgentEffective(agent: SettingsSnapshot["agentModels"][number]): string {
	const model = agent.effective.model ? ` -> ${formatModelRef(agent.effective.model)}` : "";
	const error = agent.effective.error ? ` (${agent.effective.error})` : "";
	return `Effective: ${agent.effective.label}${model}${error}`;
}

function describeStoredModelDiagnostic(
	settings: SettingsSnapshot,
	modelRef: ModelRef | undefined,
): string | undefined {
	if (!modelRef) return undefined;
	const provider = settings.settings.providers.find(
		(candidate) => candidate.id === modelRef.providerId,
	);
	if (!provider) return `Stored provider '${modelRef.providerId}' no longer exists.`;
	if (!provider.enabled) return `Stored provider '${modelRef.providerId}' is disabled.`;
	const catalogEntry = settings.catalog.find((entry) => entry.providerId === modelRef.providerId);
	if (!catalogEntry || catalogEntry.models.length === 0) return undefined;
	if (catalogEntry.models.some((model) => model.id === modelRef.modelId)) return undefined;
	return `Stored model '${modelRef.modelId}' is not in the loaded catalog for provider '${modelRef.providerId}'.`;
}
