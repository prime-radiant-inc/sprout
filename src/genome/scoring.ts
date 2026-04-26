import type { Memory } from "../kernel/types.ts";
import type { ProjectActivityRecord } from "./projects.ts";

export interface MemoryScoreBreakdown {
	score: number;
	rawScore: number;
	activityDays: number;
	ageInActivityDays: number;
	daysSinceAccess: number;
	valueScore: number;
	hubScore: number;
	entityHubScore: number;
	mentionScore: number;
	newnessBoost: number;
	recencyMultiplier: number;
	expirationMultiplier: number;
}

export interface MemoryScoreOptions {
	now?: number;
	minImportance?: number;
}

const DEFAULT_MIN_IMPORTANCE = 0.1;

export function projectActivityDaysForMemory(
	memory: Memory,
	projects: readonly ProjectActivityRecord[],
): number {
	if (memory.project_ids && memory.project_ids.length > 0) {
		return Math.max(
			0,
			...memory.project_ids.map(
				(projectId) =>
					projects.find((project) => project.id === projectId)?.cumulative_active_days ?? 0,
			),
		);
	}
	return projects.reduce((sum, project) => sum + project.cumulative_active_days, 0);
}

export function stampMemoryActivitySnapshots(
	memory: Memory,
	projects: readonly ProjectActivityRecord[],
): void {
	const activityDays = projectActivityDaysForMemory(memory, projects);
	if (memory.activity_days_at_creation === undefined) {
		memory.activity_days_at_creation = activityDays;
	}
	if (memory.activity_days_at_last_access === undefined) {
		memory.activity_days_at_last_access = activityDays;
	}
}

export function markMemoryAccessActivity(
	memory: Memory,
	projects: readonly ProjectActivityRecord[],
): void {
	memory.activity_days_at_last_access = projectActivityDaysForMemory(memory, projects);
}

export function scoreMemory(
	memory: Memory,
	projects: readonly ProjectActivityRecord[],
	options: MemoryScoreOptions = {},
): MemoryScoreBreakdown {
	const now = options.now ?? Date.now();
	const activityDays = projectActivityDaysForMemory(memory, projects);
	const creationDay = memory.activity_days_at_creation ?? activityDays;
	const lastAccessDay = memory.activity_days_at_last_access ?? creationDay;
	const ageInActivityDays = Math.max(0, activityDays - creationDay);
	const daysSinceAccess = Math.max(0, activityDays - lastAccessDay);
	const accessCount = memory.access_count ?? memory.use_count;
	const mentionCount = memory.mention_count ?? 0;
	const inboundCount = (memory.inbound_links ?? []).filter((link) => link.type !== "null").length;
	const entityCount = (memory.entity_links ?? []).length;

	const accessRate = (accessCount * 0.95 ** daysSinceAccess) / Math.max(7, ageInActivityDays);
	const valueScore = Math.log1p(accessRate / 0.02) * 0.8;
	const hubScore =
		inboundCount <= 10 ? inboundCount * 0.04 : 0.4 + Math.log1p(inboundCount - 10) * 0.04;
	const entityHubScore = Math.min(entityCount * 0.03, 0.3);
	const mentionScore =
		mentionCount <= 5 ? mentionCount * 0.08 : 0.4 + Math.log1p(mentionCount - 5) * 0.08;
	const newnessBoost = Math.max(0, 2 - ageInActivityDays * 0.133);
	const rawScore = valueScore + hubScore + entityHubScore + mentionScore + newnessBoost;
	const recencyMultiplier = accessRecencyMultiplier(daysSinceAccess);
	const expirationMultiplier = expirationTrailoff(memory, now);
	const score = clamp01(sigmoidLike(rawScore) * recencyMultiplier * expirationMultiplier);

	return {
		score,
		rawScore,
		activityDays,
		ageInActivityDays,
		daysSinceAccess,
		valueScore,
		hubScore,
		entityHubScore,
		mentionScore,
		newnessBoost,
		recencyMultiplier,
		expirationMultiplier,
	};
}

export function applyMemoryScores(
	memories: readonly Memory[],
	projects: readonly ProjectActivityRecord[],
	options: MemoryScoreOptions = {},
): { updated: string[]; archived: string[] } {
	const minImportance = options.minImportance ?? DEFAULT_MIN_IMPORTANCE;
	const now = options.now ?? Date.now();
	const updated: string[] = [];
	const archived: string[] = [];

	for (const memory of memories) {
		if (memory.archived_at) continue;
		stampMemoryActivitySnapshots(memory, projects);
		const breakdown = scoreMemory(memory, projects, { ...options, now });
		const next = roundScore(breakdown.score);
		if (memory.importance_score !== next || memory.effective_importance !== next) {
			memory.importance_score = next;
			memory.effective_importance = next;
			memory.updated_at = now;
			updated.push(memory.id);
		}
		if (next < minImportance) {
			memory.archived_at = now;
			memory.archived_reason = `low importance score ${next}`;
			archived.push(memory.id);
		}
	}

	return { updated, archived };
}

function accessRecencyMultiplier(daysSinceAccess: number): number {
	if (daysSinceAccess <= 1) return 2;
	if (daysSinceAccess <= 7) return 1.5;
	if (daysSinceAccess <= 14) return 1.2;
	return Math.max(0.4, 0.95 ** (daysSinceAccess - 14));
}

function expirationTrailoff(memory: Memory, now: number): number {
	if (!memory.expires_at) return 1;
	if (memory.expires_at >= now) return 1;
	const daysExpired = (now - memory.expires_at) / (24 * 60 * 60 * 1000);
	if (daysExpired >= 5) return 0;
	return clamp01(1 - daysExpired / 5);
}

function sigmoidLike(rawScore: number): number {
	return 1 - Math.exp(-rawScore / 3);
}

function roundScore(value: number): number {
	return Math.round(value * 1000) / 1000;
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}
