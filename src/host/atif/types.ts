export interface AtifToolCall {
	tool_call_id: string;
	function_name: string;
	arguments?: Record<string, unknown>;
}

export interface AtifObservationResult {
	source_call_id?: string;
	content?: string;
}

export interface AtifObservation {
	results: AtifObservationResult[];
}

export interface AtifMetrics {
	prompt_tokens?: number;
	completion_tokens?: number;
	cached_tokens?: number;
	cost_usd?: number;
	extra?: Record<string, unknown>;
}

export interface AtifStep {
	step_id: number;
	timestamp?: string;
	source: "system" | "user" | "agent";
	message: string;
	model_name?: string;
	reasoning_content?: string;
	tool_calls?: AtifToolCall[];
	observation?: AtifObservation;
	metrics?: AtifMetrics;
	extra?: Record<string, unknown>;
}

export interface AtifFinalMetrics {
	total_prompt_tokens?: number;
	total_completion_tokens?: number;
	total_cached_tokens?: number;
	total_cost_usd?: number;
	total_steps?: number;
	extra?: Record<string, unknown>;
}

export interface AtifAgentMetadata {
	name: string;
	version: string;
	model_name?: string;
	extra?: Record<string, unknown>;
}

export interface AtifTrajectory {
	schema_version: "ATIF-v1.6";
	session_id: string;
	agent: AtifAgentMetadata;
	steps: AtifStep[];
	notes?: string;
	final_metrics?: AtifFinalMetrics;
	extra?: Record<string, unknown>;
}
