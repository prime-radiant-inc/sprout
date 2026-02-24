import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { InputArea } from "../../src/tui/input-area.tsx";

describe("InputArea", () => {
	test("renders prompt symbol", () => {
		const { lastFrame } = render(
			<InputArea onSubmit={() => {}} onSlashCommand={() => {}} isRunning={false} />,
		);
		const frame = lastFrame();
		expect(frame).toContain(">");
	});

	test("accumulates typed characters", async () => {
		const { lastFrame, stdin } = render(
			<InputArea onSubmit={() => {}} onSlashCommand={() => {}} isRunning={false} />,
		);

		stdin.write("hello");
		await flush();
		expect(lastFrame()).toContain("hello");
	});

	test("calls onSubmit with text on Enter and clears input", async () => {
		let submitted = "";
		const { lastFrame, stdin } = render(
			<InputArea
				onSubmit={(text) => {
					submitted = text;
				}}
				onSlashCommand={() => {}}
				isRunning={false}
			/>,
		);

		stdin.write("fix the bug");
		await flush();
		stdin.write("\r");
		await flush();

		expect(submitted).toBe("fix the bug");
		expect(lastFrame()).not.toContain("fix the bug");
	});

	test("calls onSlashCommand for slash input instead of onSubmit", async () => {
		let submitted = "";
		let slashCmd: any = null;
		const { stdin } = render(
			<InputArea
				onSubmit={(text) => {
					submitted = text;
				}}
				onSlashCommand={(cmd) => {
					slashCmd = cmd;
				}}
				isRunning={false}
			/>,
		);

		stdin.write("/help");
		await flush();
		stdin.write("\r");
		await flush();

		expect(submitted).toBe("");
		expect(slashCmd).toBeDefined();
		expect(slashCmd.kind).toBe("help");
	});

	test("does not submit empty input", async () => {
		let submitted = false;
		const { stdin } = render(
			<InputArea
				onSubmit={() => {
					submitted = true;
				}}
				onSlashCommand={() => {}}
				isRunning={false}
			/>,
		);

		stdin.write("\r");
		await flush();

		expect(submitted).toBe(false);
	});

	test("handles backspace", async () => {
		let submitted = "";
		const { stdin } = render(
			<InputArea
				onSubmit={(text) => {
					submitted = text;
				}}
				onSlashCommand={() => {}}
				isRunning={false}
			/>,
		);

		stdin.write("helloo");
		await flush();
		stdin.write("\x7F"); // backspace
		await flush();
		stdin.write("\r");
		await flush();
		expect(submitted).toBe("hello");
	});

	test("navigates history with Up arrow", async () => {
		const submissions: string[] = [];
		const { lastFrame, stdin } = render(
			<InputArea
				onSubmit={(text) => {
					submissions.push(text);
				}}
				onSlashCommand={() => {}}
				isRunning={false}
				initialHistory={["first goal", "second goal"]}
			/>,
		);

		// Up arrow = ESC [ A
		stdin.write("\x1B[A");
		await flush();
		expect(lastFrame()).toContain("second goal");

		stdin.write("\x1B[A");
		await flush();
		expect(lastFrame()).toContain("first goal");
	});

	test("navigates history with Down arrow", async () => {
		const { lastFrame, stdin } = render(
			<InputArea
				onSubmit={() => {}}
				onSlashCommand={() => {}}
				isRunning={false}
				initialHistory={["first goal", "second goal"]}
			/>,
		);

		// Go up twice
		stdin.write("\x1B[A");
		await flush();
		stdin.write("\x1B[A");
		await flush();
		expect(lastFrame()).toContain("first goal");

		// Down arrow = ESC [ B
		stdin.write("\x1B[B");
		await flush();
		expect(lastFrame()).toContain("second goal");
	});

	test("shows different prompt when running", () => {
		const { lastFrame } = render(
			<InputArea onSubmit={() => {}} onSlashCommand={() => {}} isRunning={true} />,
		);
		const frame = lastFrame();
		// When running, show a different prompt indicator
		expect(frame).toContain("...");
	});

	test("calls onInterrupt when Ctrl+C pressed while running", async () => {
		let interrupted = false;
		const { stdin } = render(
			<InputArea
				onSubmit={() => {}}
				onSlashCommand={() => {}}
				isRunning={true}
				onInterrupt={() => {
					interrupted = true;
				}}
			/>,
		);

		// Ctrl+C
		stdin.write("\x03");
		await flush();

		expect(interrupted).toBe(true);
	});

	test("calls onSteer instead of onSubmit when running", async () => {
		let submitted = "";
		let steered = "";
		const { stdin } = render(
			<InputArea
				onSubmit={(text) => {
					submitted = text;
				}}
				onSlashCommand={() => {}}
				isRunning={true}
				onSteer={(text) => {
					steered = text;
				}}
			/>,
		);

		stdin.write("try a different approach");
		await flush();
		stdin.write("\r");
		await flush();

		expect(submitted).toBe("");
		expect(steered).toBe("try a different approach");
	});

	test("steer messages are recallable via up-arrow", async () => {
		let steered = "";
		const { lastFrame, stdin } = render(
			<InputArea
				onSubmit={() => {}}
				onSlashCommand={() => {}}
				isRunning={true}
				onSteer={(text) => {
					steered = text;
				}}
			/>,
		);

		stdin.write("try a different approach");
		await flush();
		stdin.write("\r");
		await flush();

		expect(steered).toBe("try a different approach");

		// Now press up arrow — should recall the steer message
		stdin.write("\x1B[A");
		await flush();
		expect(lastFrame()).toContain("try a different approach");
	});

	test("Alt+Enter inserts newline instead of submitting", async () => {
		let submitted = "";
		const { lastFrame, stdin } = render(
			<InputArea
				onSubmit={(text) => {
					submitted = text;
				}}
				onSlashCommand={() => {}}
				isRunning={false}
			/>,
		);

		stdin.write("line1");
		await flush();
		// Alt+Enter (meta + return)
		stdin.write("\x1B\r");
		await flush();
		stdin.write("line2");
		await flush();

		// Should NOT have submitted
		expect(submitted).toBe("");
		// Should contain both lines
		expect(lastFrame()).toContain("line1");
		expect(lastFrame()).toContain("line2");

		// Now submit with regular Enter
		stdin.write("\r");
		await flush();
		expect(submitted).toBe("line1\nline2");
	});

	test("calls onExit when Ctrl+C pressed while idle", async () => {
		let exited = false;
		const { stdin } = render(
			<InputArea
				onSubmit={() => {}}
				onSlashCommand={() => {}}
				isRunning={false}
				onExit={() => {
					exited = true;
				}}
			/>,
		);

		stdin.write("\x03");
		await flush();

		expect(exited).toBe(true);
	});
});

async function flush() {
	await new Promise((resolve) => setTimeout(resolve, 10));
}
