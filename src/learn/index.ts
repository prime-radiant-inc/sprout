export {
	type Canary,
	type CanaryHarness,
	type CanaryResult,
	type CanaryRunOutcome,
	type CanaryTask,
	canariesPassed,
	exampleCanaries,
	mutationRegressesCanaries,
	runCanarySuite,
} from "./canary-suite.ts";
export {
	type LearnMutation,
	LearnProcess,
	type LearnProcessOptions,
	type LearnSink,
	type ProcessResult,
} from "./learn-process.ts";
export { MetricsStore } from "./metrics-store.ts";
export {
	type ArmDirection,
	type ArmResult,
	type CompareOptions,
	type CompareResult,
	compareArms,
	shouldAcceptMutation,
} from "./multi-run-ab.ts";
export {
	type CellObservation,
	type CurationProposal,
	curatePrograms,
	type DetectPatternsOptions,
	detectRecurringPatterns,
	detectRepairCandidates,
	type FabricationCandidate,
	normalizeCellCode,
	proposeProgramFromCandidate,
	type RepairCandidate,
	type RepairOptions,
} from "./quartermaster.ts";
export { shouldLearn } from "./should-learn.ts";
