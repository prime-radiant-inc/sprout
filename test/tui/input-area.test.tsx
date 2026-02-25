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

	test.todo("cursor does not insert extra spaces in text", async () => {
		const { lastFrame, stdin } = render(
			<InputArea onSubmit={() => {}} onSlashCommand={() => {}} isRunning={false} />,
		);

		stdin.write("hello world");
		await flush();

		// Move cursor to middle (after "hello")
		stdin.write("\x01"); // Ctrl-A (start)
		await flush();
		for (let i = 0; i < 5; i++) {
			stdin.write("\x1B[C"); // right arrow
			await flush();
		}

		const frame = lastFrame()!;
		// "hello" and "world" should appear WITHOUT extra space between them
		// (cursor should overlay the space char, not insert a new one)
		expect(frame).toContain("hello");
		expect(frame).toContain("world");
		expect(frame).not.toContain("hello  world"); // no double-space
	});

	test("second Ctrl+C while running calls onExit", async () => {
		let interruptCount = 0;
		let exited = false;
		const { stdin } = render(
			<InputArea
				onSubmit={() => {}}
				onSlashCommand={() => {}}
				isRunning={true}
				onInterrupt={() => {
					interruptCount++;
				}}
				onExit={() => {
					exited = true;
				}}
			/>,
		);

		// First Ctrl+C — interrupts
		stdin.write("\x03");
		await flush();
		expect(interruptCount).toBe(1);
		expect(exited).toBe(false);

		// Second Ctrl+C while still running — should exit
		stdin.write("\x03");
		await flush();
		expect(exited).toBe(true);
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

	test("left arrow moves cursor backward", async () => {
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
		stdin.write("abc");
		await flush();
		stdin.write("\x1B[D"); // left arrow
		await flush();
		stdin.write("X");
		await flush();
		stdin.write("\r");
		await flush();
		expect(submitted).toBe("abXc");
	});

	test("Ctrl-A moves to start of line", async () => {
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
		stdin.write("hello");
		await flush();
		stdin.write("\x01"); // Ctrl-A
		await flush();
		stdin.write("X");
		await flush();
		stdin.write("\r");
		await flush();
		expect(submitted).toBe("Xhello");
	});

	test("Ctrl-E moves to end of line", async () => {
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
		stdin.write("hello");
		await flush();
		stdin.write("\x01"); // Ctrl-A
		await flush();
		stdin.write("\x05"); // Ctrl-E
		await flush();
		stdin.write("!");
		await flush();
		stdin.write("\r");
		await flush();
		expect(submitted).toBe("hello!");
	});

	test("Ctrl-K kills to end of line", async () => {
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
		stdin.write("hello world");
		await flush();
		stdin.write("\x01"); // Ctrl-A
		await flush();
		for (let i = 0; i < 5; i++) {
			stdin.write("\x1B[C"); // right arrow
			await flush();
		}
		stdin.write("\x0B"); // Ctrl-K
		await flush();
		stdin.write("\r");
		await flush();
		expect(submitted).toBe("hello");
	});

	test("Ctrl-W kills word backward", async () => {
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
		stdin.write("hello world");
		await flush();
		stdin.write("\x17"); // Ctrl-W
		await flush();
		stdin.write("\r");
		await flush();
		expect(submitted).toBe("hello");
	});

	test("backspace deletes before cursor, not just from end", async () => {
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
		stdin.write("abcd");
		await flush();
		stdin.write("\x1B[D"); // left arrow
		await flush();
		stdin.write("\x7F"); // backspace
		await flush();
		stdin.write("\r");
		await flush();
		expect(submitted).toBe("abd");
	});

	test("Ctrl-F moves cursor forward", async () => {
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
		stdin.write("abc");
		await flush();
		stdin.write("\x01"); // Ctrl-A (go to start)
		await flush();
		stdin.write("\x06"); // Ctrl-F (forward one)
		await flush();
		stdin.write("X");
		await flush();
		stdin.write("\r");
		await flush();
		expect(submitted).toBe("aXbc");
	});

	test("Ctrl-B moves cursor backward", async () => {
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
		stdin.write("abc");
		await flush();
		stdin.write("\x02"); // Ctrl-B (backward one)
		await flush();
		stdin.write("X");
		await flush();
		stdin.write("\r");
		await flush();
		expect(submitted).toBe("abXc");
	});

	test("Ctrl-U kills to start of line", async () => {
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
		stdin.write("hello world");
		await flush();
		// Move to middle: Ctrl-A then 5 rights
		stdin.write("\x01");
		await flush();
		for (let i = 0; i < 5; i++) {
			stdin.write("\x1B[C");
			await flush();
		}
		stdin.write("\x15"); // Ctrl-U
		await flush();
		stdin.write("\r");
		await flush();
		expect(submitted).toBe("world");
	});

	test("Ctrl+J inserts newline", async () => {
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
		// Ctrl+J = \n (line feed)
		stdin.write("\n");
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

	test("up arrow from first line navigates history", async () => {
		const { lastFrame, stdin } = render(
			<InputArea
				onSubmit={() => {}}
				onSlashCommand={() => {}}
				isRunning={false}
				initialHistory={["prev command"]}
			/>,
		);
		stdin.write("\x1B[A"); // up arrow
		await flush();
		expect(lastFrame()).toContain("prev command");
	});

	test("up arrow within multiline text moves cursor, not history", async () => {
		let submitted = "";
		const { stdin } = render(
			<InputArea
				onSubmit={(text) => {
					submitted = text;
				}}
				onSlashCommand={() => {}}
				isRunning={false}
				initialHistory={["should not appear"]}
			/>,
		);
		stdin.write("line1");
		await flush();
		stdin.write("\x1B\r"); // Alt-Enter
		await flush();
		stdin.write("line2");
		await flush();
		// Up from line 2 → move to line 1, not history
		stdin.write("\x1B[A");
		await flush();
		stdin.write("X");
		await flush();
		stdin.write("\r");
		await flush();
		expect(submitted).toContain("line1");
		expect(submitted).toContain("line2");
		expect(submitted).not.toContain("should not appear");
	});
});

async function flush() {
	await new Promise((resolve) => setTimeout(resolve, 10));
}
