/** Drives the extension through a stubbed ExtensionAPI, without running pi. */
import { beforeEach, describe, expect, it } from "vitest";
import memoExtension from "../src/index.ts";
import { CLOSING_NUDGE } from "../src/store/index-file.ts";
import { createSandbox, type Sandbox } from "./helpers.ts";

interface Registered {
	tools: Map<string, any>;
	commands: Map<string, any>;
	handlers: Map<string, Function[]>;
	messages: { customType: string; content: string; options?: unknown }[];
	notifications: string[];
}

function stubPi(): { pi: any; registered: Registered } {
	const registered: Registered = {
		tools: new Map(),
		commands: new Map(),
		handlers: new Map(),
		messages: [],
		notifications: [],
	};
	const pi = {
		on(event: string, handler: Function) {
			registered.handlers.set(event, [...(registered.handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: any) {
			registered.tools.set(tool.name, tool);
		},
		registerCommand(name: string, options: any) {
			registered.commands.set(name, options);
		},
		async sendMessage(message: any, options?: unknown) {
			registered.messages.push({ ...message, options });
		},
	};
	return { pi, registered };
}

function stubCtx(cwd: string, registered: Registered) {
	return {
		cwd,
		ui: {
			notify: (message: string) => registered.notifications.push(message),
		},
	} as any;
}

let sandbox: Sandbox;

beforeEach(() => {
	sandbox = createSandbox();
});

describe("extension wiring", () => {
	it("registers the four memory tools and both commands", () => {
		const { pi, registered } = stubPi();
		memoExtension(pi);
		expect([...registered.tools.keys()].sort()).toEqual([
			"memory_forget",
			"memory_recall",
			"memory_revise",
			"memory_write",
		]);
		expect([...registered.commands.keys()].sort()).toEqual(["memo-gc", "memo-stats"]);
	});

	// A guideline that only classifies ("write env vs exp") never tells the model
	// when to reach for the tool, which is how the store stayed empty. Each tool
	// must keep at least one guideline that names an observable moment.
	it("gives every memory tool a guideline with a trigger condition", () => {
		const { pi, registered } = stubPi();
		memoExtension(pi);
		for (const name of ["memory_recall", "memory_write", "memory_revise", "memory_forget"]) {
			const guidelines: string[] = registered.tools.get(name).promptGuidelines ?? [];
			expect(guidelines.length, name).toBeGreaterThan(0);
			expect(guidelines.some((line) => /^(When|Before) /.test(line)), name).toBe(true);
		}
	});

	it("injects the index snapshot and recalls what was written in the same session", async () => {
		const { pi, registered } = stubPi();
		memoExtension(pi);
		const ctx = stubCtx(sandbox.projectRoot, registered);

		for (const handler of registered.handlers.get("session_start") ?? []) await handler({}, ctx);

		const write = registered.tools.get("memory_write");
		await write.execute("call-1", {
			scope: "project",
			kind: "env",
			id: "build-and-check",
			title: "改代码后运行 npm run check",
			body: "TypeScript 改动后必须跑 `npm run check`。",
		}, undefined, undefined, ctx);

		const recall = registered.tools.get("memory_recall");
		const byQuery = await recall.execute("call-2", { query: "npm run check" }, undefined, undefined, ctx);
		expect(byQuery.content[0].text).toContain("build-and-check");

		const byId = await recall.execute("call-3", { ids: ["build-and-check"] }, undefined, undefined, ctx);
		expect(byId.content[0].text).toContain("TypeScript 改动后必须跑");

		// A fresh session picks the entry up in its injected snapshot.
		for (const handler of registered.handlers.get("session_start") ?? []) await handler({}, ctx);
		const contextHandler = (registered.handlers.get("context") ?? [])[0] as Function;
		const result = await contextHandler({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
		expect(result.messages).toHaveLength(3);
		expect(result.messages[0].customType).toBe("memo-index");
		expect(result.messages[0].content).toContain("build-and-check");
		expect(result.messages[0].display).toBe(false);
		// The write trigger goes last, after the task, not in front of it.
		expect(result.messages.at(-1).customType).toBe("memo-write-reminder");
		expect(result.messages.at(-1).content).toBe(CLOSING_NUDGE);
		expect(result.messages.at(-1).display).toBe(false);
	});

	it("rejects a recall that passes neither query nor ids", async () => {
		const { pi, registered } = stubPi();
		memoExtension(pi);
		const ctx = stubCtx(sandbox.projectRoot, registered);
		for (const handler of registered.handlers.get("session_start") ?? []) await handler({}, ctx);

		const recall = registered.tools.get("memory_recall");
		await expect(recall.execute("call-1", {}, undefined, undefined, ctx)).rejects.toThrow(/exactly one/);
	});

	it("flushes usage when the agent settles", async () => {
		const { pi, registered } = stubPi();
		memoExtension(pi);
		const ctx = stubCtx(sandbox.projectRoot, registered);
		for (const handler of registered.handlers.get("session_start") ?? []) await handler({}, ctx);

		await registered.tools
			.get("memory_write")
			.execute("c1", { scope: "project", kind: "exp", id: "lesson-one", title: "a lesson", body: "next time do X" }, undefined, undefined, ctx);
		await registered.tools.get("memory_recall").execute("c2", { ids: ["lesson-one"] }, undefined, undefined, ctx);
		for (const handler of registered.handlers.get("agent_settled") ?? []) await handler({}, ctx);

		const stats = registered.commands.get("memo-stats");
		await stats.handler("", ctx);
		expect(registered.messages.at(-1)?.content).toContain("Never recalled: 0");
		expect(registered.messages.at(-1)?.options).toBeUndefined();
	});

	it("runs /memo-gc and reports through a message", async () => {
		const { pi, registered } = stubPi();
		memoExtension(pi);
		const ctx = stubCtx(sandbox.projectRoot, registered);
		for (const handler of registered.handlers.get("session_start") ?? []) await handler({}, ctx);

		await registered.tools
			.get("memory_write")
			.execute("c1", { scope: "project", kind: "env", id: "one-fact", title: "a fact", body: "text" }, undefined, undefined, ctx);
		await registered.commands.get("memo-gc").handler("", ctx);

		expect(registered.messages.at(-1)?.customType).toBe("memo-gc");
		expect(registered.messages.at(-1)?.content).toContain("memo GC: 1 entries checked");
		expect(registered.messages.at(-1)?.options).toBeUndefined();
	});
});
