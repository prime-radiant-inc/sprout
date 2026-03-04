import { describe, expect, test } from "bun:test";
import {
	persistPlanEndMetadataUpdate,
	persistRunningMetadata,
	persistTerminalMetadata,
} from "../../src/host/session-metadata-updater.ts";

describe("session metadata updater", () => {
	test("persistRunningMetadata writes running status and saves", async () => {
		const calls: string[] = [];
		const metadata = {
			setStatus: (status: string) => {
				calls.push(`status:${status}`);
			},
			updateTurn: () => {},
			save: async () => {
				calls.push("save");
			},
		};

		await persistRunningMetadata(metadata);

		expect(calls).toEqual(["status:running", "save"]);
	});

	test("persistTerminalMetadata writes interrupted when aborted", async () => {
		const calls: string[] = [];
		const metadata = {
			setStatus: (status: string) => {
				calls.push(`status:${status}`);
			},
			updateTurn: () => {},
			save: async () => {
				calls.push("save");
			},
		};

		await persistTerminalMetadata(metadata, true);

		expect(calls).toEqual(["status:interrupted", "save"]);
	});

	test("persistTerminalMetadata writes idle when not aborted", async () => {
		const calls: string[] = [];
		const metadata = {
			setStatus: (status: string) => {
				calls.push(`status:${status}`);
			},
			updateTurn: () => {},
			save: async () => {
				calls.push("save");
			},
		};

		await persistTerminalMetadata(metadata, false);

		expect(calls).toEqual(["status:idle", "save"]);
	});

	test("persistPlanEndMetadataUpdate writes turn/context and emits context_update", async () => {
		const calls: string[] = [];
		const updates: Array<{ turn: number; tokens: number; window: number }> = [];
		const emitted: Array<{ kind: string; data: Record<string, unknown> }> = [];
		const metadata = {
			setStatus: () => {},
			updateTurn: (turn: number, contextTokens: number, contextWindowSize: number) => {
				updates.push({ turn, tokens: contextTokens, window: contextWindowSize });
				calls.push("updateTurn");
			},
			save: async () => {
				calls.push("save");
			},
		};

		await persistPlanEndMetadataUpdate({
			metadata,
			turn: 4,
			contextTokens: 123,
			contextWindowSize: 200_000,
			emitContextUpdate: (data) => {
				emitted.push({ kind: "context_update", data });
			},
		});

		expect(updates).toEqual([{ turn: 4, tokens: 123, window: 200_000 }]);
		expect(calls).toEqual(["updateTurn", "save"]);
		expect(emitted).toEqual([
			{
				kind: "context_update",
				data: {
					context_tokens: 123,
					context_window_size: 200_000,
				},
			},
		]);
	});
});
