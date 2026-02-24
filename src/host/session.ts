import type { Agent } from "../agents/agent.ts";
import type { AgentEventEmitter } from "../agents/events.ts";
import type { SessionEvent } from "../kernel/types.ts";
import type { LearnProcess } from "../learn/learn-process.ts";

export interface SubmitOptions {
	agent: Agent;
	events: AgentEventEmitter;
	learnProcess?: LearnProcess;
}

/**
 * Wrap Agent.run() as an async generator that yields SessionEvent objects.
 * Learn processing runs concurrently via the background loop.
 * @deprecated Use SessionController.submitGoal() instead.
 */
export async function* submitGoal(
	goal: string,
	options: SubmitOptions,
): AsyncGenerator<SessionEvent> {
	const { agent, events, learnProcess } = options;

	// Buffer for events arriving from the emitter
	const buffer: SessionEvent[] = [];

	// Mutable resolve function: the event listener calls this to wake the generator
	let notify: (() => void) | null = null;

	const unsubscribe = events.on((event) => {
		buffer.push(event);
		if (notify) {
			notify();
			notify = null;
		}
	});

	// Start background Learn processing before the agent runs
	if (learnProcess) {
		learnProcess.startBackground();
	}

	// Start agent.run() as a background promise (fire-and-forget side effect)
	let agentDone = false;
	let agentError: unknown = null;
	agent
		.run(goal)
		.then(() => {
			agentDone = true;
		})
		.catch((err) => {
			agentError = err;
			agentDone = true;
		})
		.finally(() => {
			if (notify) {
				notify();
				notify = null;
			}
		});

	try {
		// Yield events as they arrive until agent completes
		while (!agentDone || buffer.length > 0) {
			if (buffer.length > 0) {
				yield buffer.shift()!;
			} else if (!agentDone) {
				// Wait for a new event or agent completion
				await new Promise<void>((resolve) => {
					notify = resolve;
				});
			}
		}

		// Re-throw agent errors after yielding all buffered events
		if (agentError) {
			throw agentError;
		}

		// Stop background Learn and drain remaining signals
		if (learnProcess) {
			await learnProcess.stopBackground();
			// Yield any events emitted during final drain
			while (buffer.length > 0) {
				yield buffer.shift()!;
			}
		}
	} finally {
		unsubscribe();
	}
}
