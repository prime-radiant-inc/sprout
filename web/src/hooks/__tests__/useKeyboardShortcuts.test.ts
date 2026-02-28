import { describe, expect, test } from "bun:test";
import { handleKeyboardShortcut, type ShortcutActions } from "../useKeyboardShortcuts.ts";

// Minimal fake targets to avoid needing a real DOM environment
const bodyTarget = { tagName: "BODY" };
const textareaTarget = { tagName: "TEXTAREA" };

describe("handleKeyboardShortcut", () => {
	test("Ctrl+/ triggers toggleSidebar", () => {
		let called = false;
		const actions: ShortcutActions = {
			toggleSidebar: () => { called = true; },
			clearFilter: () => {},
			focusInput: () => {},
		showHelp: () => {},
		};
		const handled = handleKeyboardShortcut(
			{ key: "/", ctrlKey: true, metaKey: false, target: bodyTarget } as unknown as KeyboardEvent,
			actions,
		);
		expect(called).toBe(true);
		expect(handled).toBe(true);
	});

	test("Cmd+/ triggers toggleSidebar", () => {
		let called = false;
		const actions: ShortcutActions = {
			toggleSidebar: () => { called = true; },
			clearFilter: () => {},
			focusInput: () => {},
		showHelp: () => {},
		};
		const handled = handleKeyboardShortcut(
			{ key: "/", ctrlKey: false, metaKey: true, target: bodyTarget } as unknown as KeyboardEvent,
			actions,
		);
		expect(called).toBe(true);
		expect(handled).toBe(true);
	});

	test("Escape triggers clearFilter", () => {
		let called = false;
		const actions: ShortcutActions = {
			toggleSidebar: () => {},
			clearFilter: () => { called = true; },
			focusInput: () => {},
		showHelp: () => {},
		};
		const handled = handleKeyboardShortcut(
			{ key: "Escape", ctrlKey: false, metaKey: false, target: bodyTarget } as unknown as KeyboardEvent,
			actions,
		);
		expect(called).toBe(true);
		expect(handled).toBe(true);
	});

	test("/ triggers focusInput when target is not an input", () => {
		let called = false;
		const actions: ShortcutActions = {
			toggleSidebar: () => {},
			clearFilter: () => {},
			focusInput: () => { called = true; },
			showHelp: () => {},
		};
		const handled = handleKeyboardShortcut(
			{ key: "/", ctrlKey: false, metaKey: false, target: bodyTarget } as unknown as KeyboardEvent,
			actions,
		);
		expect(called).toBe(true);
		expect(handled).toBe(true);
	});

	test("/ does NOT trigger focusInput when target is a textarea", () => {
		let called = false;
		const actions: ShortcutActions = {
			toggleSidebar: () => {},
			clearFilter: () => {},
			focusInput: () => { called = true; },
			showHelp: () => {},
		};
		const handled = handleKeyboardShortcut(
			{ key: "/", ctrlKey: false, metaKey: false, target: textareaTarget } as unknown as KeyboardEvent,
			actions,
		);
		expect(called).toBe(false);
		expect(handled).toBe(false);
	});

	test("/ does NOT trigger focusInput when target is an input", () => {
		let called = false;
		const actions: ShortcutActions = {
			toggleSidebar: () => {},
			clearFilter: () => {},
			focusInput: () => { called = true; },
			showHelp: () => {},
		};
		const handled = handleKeyboardShortcut(
			{ key: "/", ctrlKey: false, metaKey: false, target: { tagName: "INPUT" } } as unknown as KeyboardEvent,
			actions,
		);
		expect(called).toBe(false);
		expect(handled).toBe(false);
	});

	test("/ does NOT trigger focusInput when target is a select", () => {
		let called = false;
		const actions: ShortcutActions = {
			toggleSidebar: () => {},
			clearFilter: () => {},
			focusInput: () => { called = true; },
			showHelp: () => {},
		};
		const handled = handleKeyboardShortcut(
			{ key: "/", ctrlKey: false, metaKey: false, target: { tagName: "SELECT" } } as unknown as KeyboardEvent,
			actions,
		);
		expect(called).toBe(false);
		expect(handled).toBe(false);
	});

	test("Escape in textarea does NOT trigger clearFilter", () => {
		let cleared = false;
		const actions: ShortcutActions = {
			toggleSidebar: () => {},
			clearFilter: () => { cleared = true; },
			focusInput: () => {},
		showHelp: () => {},
		};
		const handled = handleKeyboardShortcut(
			{ key: "Escape", ctrlKey: false, metaKey: false, target: { tagName: "TEXTAREA" } } as unknown as KeyboardEvent,
			actions,
		);
		expect(cleared).toBe(false);
		expect(handled).toBe(false);
	});

	test("? triggers showHelp when target is not an input", () => {
		let called = false;
		const actions: ShortcutActions = {
			toggleSidebar: () => {},
			clearFilter: () => {},
			focusInput: () => {},
			showHelp: () => { called = true; },
		};
		const handled = handleKeyboardShortcut(
			{ key: "?", ctrlKey: false, metaKey: false, target: bodyTarget } as unknown as KeyboardEvent,
			actions,
		);
		expect(called).toBe(true);
		expect(handled).toBe(true);
	});

	test("? does NOT trigger showHelp when target is a textarea", () => {
		let called = false;
		const actions: ShortcutActions = {
			toggleSidebar: () => {},
			clearFilter: () => {},
			focusInput: () => {},
			showHelp: () => { called = true; },
		};
		const handled = handleKeyboardShortcut(
			{ key: "?", ctrlKey: false, metaKey: false, target: textareaTarget } as unknown as KeyboardEvent,
			actions,
		);
		expect(called).toBe(false);
		expect(handled).toBe(false);
	});

	test("unrecognized key returns false", () => {
		const actions: ShortcutActions = {
			toggleSidebar: () => {},
			clearFilter: () => {},
			focusInput: () => {},
		showHelp: () => {},
		};
		const handled = handleKeyboardShortcut(
			{ key: "a", ctrlKey: false, metaKey: false, target: bodyTarget } as unknown as KeyboardEvent,
			actions,
		);
		expect(handled).toBe(false);
	});
});
