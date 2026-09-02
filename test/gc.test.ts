import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runGc, parseGcArgs } from "../src/commands/gc.ts";
import { runStats } from "../src/commands/stats.ts";
import { createSandbox, memoryFile, seedEntry, type Sandbox } from "./helpers.ts";

let sandbox: Sandbox;

beforeEach(() => {
	sandbox = createSandbox();
});

describe("/memo-gc", () => {
	it("reports a failed file verification and writes a report", async () => {
		writeFileSync(path.join(sandbox.projectRoot, "process.rs"), "fn main() {}\n", "utf8");
		const memo = sandbox.load();
		memo.write({
			scope: "project",
			kind: "env",
			id: "agent-bin-env",
			title: "agent binary path comes from an env var",
			body: "text",
			verify: { kind: "file", ref: "process.rs", expect: "PI_DIOXUS_AGENT_BIN" },
		});

		const result = await runGc(memo, { cwd: sandbox.projectRoot, checkUrls: false });
		expect(result.aborted).toBe(false);
		expect(result.verify[0]?.status).toBe("failed");

		const report = readFileSync(path.join(sandbox.projectDir, "GC-REPORT.md"), "utf8");
		expect(report).toContain("agent-bin-env");
		expect(report).toContain("no longer contains");
	});

	it("passes a file verification that still matches", async () => {
		writeFileSync(path.join(sandbox.projectRoot, "process.rs"), "let bin = PI_DIOXUS_AGENT_BIN;\n", "utf8");
		const memo = sandbox.load();
		memo.write({
			scope: "project",
			kind: "env",
			id: "agent-bin-env",
			title: "agent binary path comes from an env var",
			body: "text",
			verify: { kind: "file", ref: "process.rs", expect: "PI_DIOXUS_AGENT_BIN" },
		});
		const result = await runGc(memo, { cwd: sandbox.projectRoot, checkUrls: false });
		expect(result.verify[0]?.status).toBe("ok");
	});

	it("checks a read-only command", async () => {
		const memo = sandbox.load();
		memo.write({
			scope: "project",
			kind: "env",
			id: "echo-check",
			title: "echo prints its argument",
			body: "text",
			verify: { kind: "command", ref: "echo memo-ok", expect: "memo-ok" },
		});
		const result = await runGc(memo, { cwd: sandbox.projectRoot, checkUrls: false });
		expect(result.verify[0]?.status).toBe("ok");
	});

	it("flags entries never hit in 90 days", async () => {
		const old = "2020-01-01T00:00:00+00:00";
		seedEntry(
			sandbox.projectDir,
			"exp",
			"ancient",
			memoryFile({ id: "ancient", kind: "exp", title: "an old lesson", body: "text", created: old }),
		);
		const result = await runGc(sandbox.load(), { cwd: sandbox.projectRoot, checkUrls: false });
		expect(result.stale.map((entry) => entry.id)).toEqual(["ancient"]);
	});

	it("stops before writing anything when ids conflict", async () => {
		seedEntry(sandbox.globalDir, "env", "twice", memoryFile({ id: "twice", kind: "env", title: "global", body: "a" }));
		seedEntry(sandbox.projectDir, "env", "twice", memoryFile({ id: "twice", kind: "env", title: "project", body: "b" }));

		const result = await runGc(sandbox.load(), { cwd: sandbox.projectRoot, checkUrls: false });
		expect(result.aborted).toBe(true);
		expect(result.summary).toContain("twice");
		expect(existsSync(path.join(sandbox.projectDir, "GC-REPORT.md"))).toBe(false);
	});

	it("parses the url flag", () => {
		expect(parseGcArgs("")).toBe(false);
		expect(parseGcArgs("--check-urls=true")).toBe(true);
		expect(parseGcArgs("--check-urls=false")).toBe(false);
	});
});

describe("/memo-stats", () => {
	it("counts entries, unused ratio and index size", () => {
		const memo = sandbox.load();
		memo.write({ scope: "project", kind: "env", id: "one", title: "first fact", body: "text" });
		memo.write({ scope: "global", kind: "user", id: "two", title: "user preference", body: "text" });
		memo.noteHit(memo.locate("one")!.entry);
		memo.flushUsage();

		const stats = runStats(memo);
		expect(stats.total).toBe(2);
		expect(stats.unused).toBe(1);
		expect(stats.indexEntries).toBe(2);
		expect(stats.text).toContain("Total entries: 2");
	});
});
