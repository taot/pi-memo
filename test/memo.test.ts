import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoError } from "../src/memo.ts";
import { createSandbox, memoryFile, seedEntry, type Sandbox } from "./helpers.ts";

let sandbox: Sandbox;

beforeEach(() => {
	sandbox = createSandbox();
});

describe("write", () => {
	it("stores a project memory and updates MEMORY.md", () => {
		const memo = sandbox.load();
		const entry = memo.write({
			scope: "project",
			kind: "env",
			id: "build-and-check",
			title: "改代码后运行 npm run check",
			body: "每次改动 TypeScript 后跑 `npm run check`。",
			verify: { kind: "file", ref: "package.json", expect: "check" },
		});

		expect(entry.file).toBe(path.join(sandbox.projectDir, "env", "build-and-check.md"));
		expect(existsSync(entry.file)).toBe(true);
		const index = readFileSync(path.join(sandbox.projectDir, "MEMORY.md"), "utf8");
		expect(index).toContain("[build-and-check](env/build-and-check.md)");
		expect(index).toContain("改代码后运行 npm run check");
	});

	it("refuses user memories in the project store", () => {
		const memo = sandbox.load();
		expect(() =>
			memo.write({ scope: "project", kind: "user", id: "likes-tabs", title: "偏好 tab 缩进", body: "always tabs" }),
		).toThrow(MemoError);
	});

	it("refuses a duplicate id in the other scope", () => {
		const memo = sandbox.load();
		memo.write({ scope: "global", kind: "exp", id: "shared-id", title: "global entry", body: "one" });
		expect(() => memo.write({ scope: "project", kind: "exp", id: "shared-id", title: "project entry", body: "two" })).toThrow(
			/already exists/,
		);
	});

	it("refuses a project-relative verify file on a global memory", () => {
		const memo = sandbox.load();
		expect(() =>
			memo.write({
				scope: "global",
				kind: "env",
				id: "global-file-ref",
				title: "global fact",
				body: "text",
				verify: { kind: "file", ref: "src/agent/process.rs", expect: "PI_DIOXUS_AGENT_BIN" },
			}),
		).toThrow(/project-relative/);
	});

	it("flags near-duplicate titles instead of silently adding one", () => {
		const memo = sandbox.load();
		memo.write({ scope: "project", kind: "exp", id: "e2e-window", title: "E2E 窗口定位使用 kdotool", body: "one" });
		expect(memo.similarTitles("E2E 窗口定位使用 kdotool").map((hit) => hit.entry.id)).toEqual(["e2e-window"]);
	});
});

describe("recall", () => {
	it("finds a memory by query and counts the hit", () => {
		const memo = sandbox.load();
		memo.write({
			scope: "project",
			kind: "env",
			id: "wayland-no-window-positioning",
			title: "Wayland 不暴露窗口坐标设定",
			body: "winit 的 set_outer_position 在 KDE 下不生效。",
		});
		memo.write({ scope: "project", kind: "exp", id: "prefer-vitest", title: "测试使用 vitest", body: "npm run test" });

		const hits = memo.search("set_outer_position 窗口");
		expect(hits[0]?.entry.id).toBe("wayland-no-window-positioning");

		memo.noteHit(hits[0]!.entry);
		memo.flushUsage();
		const usage = JSON.parse(readFileSync(path.join(sandbox.projectDir, ".local", "usage.json"), "utf8"));
		expect(usage["wayland-no-window-positioning"].hits).toBe(1);
	});

	it("prefers the requested kind", () => {
		const memo = sandbox.load();
		memo.write({ scope: "project", kind: "env", id: "cache-env", title: "cache directory layout", body: "cache lives here" });
		memo.write({ scope: "project", kind: "exp", id: "cache-exp", title: "cache directory layout", body: "cache lives here" });
		expect(memo.search("cache directory", { kind: "exp" })[0]?.entry.id).toBe("cache-exp");
	});

	it("sees writes made in the same session", () => {
		const memo = sandbox.load();
		memo.write({ scope: "global", kind: "user", id: "prefers-chinese", title: "用户偏好中文回复", body: "回答用中文。" });
		expect(memo.search("中文回复")[0]?.entry.id).toBe("prefers-chinese");
	});
});

describe("revise and forget", () => {
	it("keeps created and clears optional fields with null", () => {
		const memo = sandbox.load();
		const first = memo.write({
			scope: "project",
			kind: "env",
			id: "revise-me",
			title: "old title",
			body: "old body",
			tags: ["a"],
			verify: { kind: "file", ref: "package.json", expect: "name" },
		});

		const revised = memo.revise({ id: "revise-me", title: "new title", verify: null, tags: null });
		expect(revised.created).toBe(first.created);
		expect(revised.title).toBe("new title");
		expect(revised.body).toBe("old body");
		expect(revised.verify).toBeUndefined();
		expect(revised.tags).toBeUndefined();

		const text = readFileSync(revised.file, "utf8");
		expect(text).not.toContain("verify:");
		expect(text).toContain("title: new title");
	});

	it("deletes the file, the index line and the usage record", () => {
		const memo = sandbox.load();
		const entry = memo.write({ scope: "project", kind: "exp", id: "gone-soon", title: "temporary", body: "text" });
		memo.noteHit(entry);
		memo.flushUsage();

		memo.forget("gone-soon");
		expect(existsSync(entry.file)).toBe(false);
		expect(readFileSync(path.join(sandbox.projectDir, "MEMORY.md"), "utf8")).not.toContain("gone-soon");
		const usage = JSON.parse(readFileSync(path.join(sandbox.projectDir, ".local", "usage.json"), "utf8"));
		expect(usage["gone-soon"]).toBeUndefined();
		expect(memo.search("temporary")).toEqual([]);
	});

	it("reports an unknown id", () => {
		const memo = sandbox.load();
		expect(() => memo.forget("never-existed")).toThrow(/no memory with id/);
	});
});

describe("id conflicts", () => {
	it("excludes conflicting ids and refuses every tool operation on them", () => {
		seedEntry(sandbox.globalDir, "env", "twice", memoryFile({ id: "twice", kind: "env", title: "global copy", body: "a" }));
		seedEntry(sandbox.projectDir, "env", "twice", memoryFile({ id: "twice", kind: "env", title: "project copy", body: "b" }));

		const memo = sandbox.load();
		expect(memo.conflicts.has("twice")).toBe(true);
		expect(memo.entries().map((entry) => entry.id)).not.toContain("twice");
		expect(() => memo.locate("twice")).toThrow(/more than one memory file/);
		expect(() => memo.forget("twice")).toThrow(/more than one memory file/);
		expect(() => memo.write({ scope: "project", kind: "env", id: "twice", title: "another", body: "c" })).toThrow(
			/more than one memory file/,
		);
		expect(memo.sessionIndex()).toContain("Conflicting ids");
	});
});
