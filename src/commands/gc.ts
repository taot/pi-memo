/**
 * `/memo-gc`: check the stores, report candidates, rebuild index and cache.
 *
 * The report never edits or deletes memories. Acting on it is the model's job,
 * through `memory_revise` and `memory_forget`.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Entry } from "../store/entry.ts";
import type { Memo, StoreState } from "../memo.ts";
import { titleSimilarity } from "../memo.ts";
import { findProjectRoot, reportFilePath } from "../store/paths.ts";
import { nowIso } from "../store/entry.ts";

export const STALE_DAYS = 90;
const COMMAND_TIMEOUT_MS = 10_000;
const URL_TIMEOUT_MS = 10_000;

export interface VerifyResult {
	entry: Entry;
	status: "ok" | "failed" | "skipped" | "error";
	detail: string;
}

export interface SimilarPair {
	a: Entry;
	b: Entry;
	similarity: number;
	field: "title" | "body";
}

export interface GcOptions {
	cwd: string;
	checkUrls: boolean;
}

export interface GcResult {
	aborted: boolean;
	conflicts: Map<string, string[]>;
	problems: { file: string; message: string }[];
	verify: VerifyResult[];
	similar: SimilarPair[];
	stale: Entry[];
	reports: string[];
	summary: string;
}

function runCommand(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		execFile(
			process.env.SHELL || "/bin/sh",
			["-c", command],
			{ cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout, stderr) => {
				resolve({ ok: !error, output: `${stdout}${stderr}` });
			},
		);
	});
}

async function checkVerify(entry: Entry, options: GcOptions): Promise<VerifyResult> {
	const verify = entry.verify;
	if (!verify) {
		return { entry, status: "skipped", detail: "no verify block" };
	}

	if (verify.kind === "file") {
		const base = entry.scope === "project" ? findProjectRoot(options.cwd) : "/";
		const file = verify.ref.startsWith("~")
			? path.join(process.env.HOME ?? "", verify.ref.slice(1))
			: path.resolve(base, verify.ref);
		if (!existsSync(file)) return { entry, status: "failed", detail: `missing file ${file}` };
		try {
			const text = readFileSync(file, "utf8");
			return text.includes(verify.expect)
				? { entry, status: "ok", detail: file }
				: { entry, status: "failed", detail: `${file} no longer contains "${verify.expect}"` };
		} catch (error) {
			return { entry, status: "error", detail: `cannot read ${file}: ${(error as Error).message}` };
		}
	}

	if (verify.kind === "command") {
		const cwd = entry.scope === "project" ? findProjectRoot(options.cwd) : (process.env.HOME ?? options.cwd);
		const { ok, output } = await runCommand(verify.ref, cwd);
		if (!ok && output.trim().length === 0) {
			return { entry, status: "error", detail: `command failed: ${verify.ref}` };
		}
		return output.includes(verify.expect)
			? { entry, status: "ok", detail: verify.ref }
			: { entry, status: "failed", detail: `output of "${verify.ref}" no longer contains "${verify.expect}"` };
	}

	// url
	try {
		const response = await fetch(verify.ref, {
			method: options.checkUrls ? "GET" : "HEAD",
			signal: AbortSignal.timeout(URL_TIMEOUT_MS),
		});
		if (!response.ok) {
			return { entry, status: "failed", detail: `${verify.ref} returned HTTP ${response.status}` };
		}
		if (!options.checkUrls) {
			return { entry, status: "ok", detail: `HTTP ${response.status} (content not checked)` };
		}
		const text = await response.text();
		return text.includes(verify.expect)
			? { entry, status: "ok", detail: `${verify.ref} contains the expected text` }
			: { entry, status: "failed", detail: `${verify.ref} no longer contains "${verify.expect}"` };
	} catch (error) {
		return { entry, status: "error", detail: `cannot fetch ${verify.ref}: ${(error as Error).message}` };
	}
}

function findSimilar(entries: Entry[], threshold = 0.6): SimilarPair[] {
	const pairs: SimilarPair[] = [];
	for (let i = 0; i < entries.length; i++) {
		for (let j = i + 1; j < entries.length; j++) {
			const a = entries[i] as Entry;
			const b = entries[j] as Entry;
			const title = titleSimilarity(a.title, b.title);
			if (title >= threshold) {
				pairs.push({ a, b, similarity: title, field: "title" });
				continue;
			}
			const body = titleSimilarity(a.body, b.body);
			if (body >= threshold) pairs.push({ a, b, similarity: body, field: "body" });
		}
	}
	return pairs.sort((x, y) => y.similarity - x.similarity);
}

function findStale(memo: Memo, now: number): Entry[] {
	const cutoff = now - STALE_DAYS * 86_400_000;
	return memo.entries().filter((entry) => {
		const usage = memo.usageOf(entry.id);
		if (usage && usage.hits > 0) {
			const last = Date.parse(usage.last_hit);
			if (!Number.isNaN(last) && last >= cutoff) return false;
			return true;
		}
		const created = Date.parse(entry.created);
		return !Number.isNaN(created) && created < cutoff;
	});
}

function renderReport(store: StoreState, result: Omit<GcResult, "reports" | "summary" | "aborted">): string {
	const mine = <T extends { entry: Entry }>(items: T[]) => items.filter((item) => item.entry.scope === store.scope);
	const lines = [
		`# memo GC report (${store.scope})`,
		"",
		`Generated ${nowIso()}`,
		`Store: ${store.dir}`,
		`Entries: ${store.entries.size}`,
		"",
		"This report suggests; it never edits. Act on it with memory_revise or memory_forget.",
		"",
	];

	const problems = result.problems.filter((problem) => problem.file.startsWith(store.dir));
	lines.push("## Format problems", "");
	lines.push(problems.length === 0 ? "None." : problems.map((p) => `- ${p.file}: ${p.message}`).join("\n"));
	lines.push("");

	const failed = mine(result.verify).filter((item) => item.status !== "ok" && item.status !== "skipped");
	lines.push("## Failed verify checks", "");
	lines.push(
		failed.length === 0 ? "None." : failed.map((item) => `- ${item.entry.id} (${item.status}): ${item.detail}`).join("\n"),
	);
	lines.push("");

	const missingVerify = [...store.entries.values()].filter((entry) => entry.kind === "env" && !entry.verify);
	lines.push("## env entries without verify", "");
	lines.push(missingVerify.length === 0 ? "None." : missingVerify.map((entry) => `- ${entry.id}`).join("\n"));
	lines.push("");

	const similar = result.similar.filter((pair) => pair.a.scope === store.scope || pair.b.scope === store.scope);
	lines.push("## Possible duplicates", "");
	lines.push(
		similar.length === 0
			? "None."
			: similar
					.map(
						(pair) =>
							`- ${pair.a.id} <-> ${pair.b.id} (${pair.field} similarity ${pair.similarity.toFixed(2)})`,
					)
					.join("\n"),
	);
	lines.push("");

	const stale = result.stale.filter((entry) => entry.scope === store.scope);
	lines.push(`## Not hit in ${STALE_DAYS} days`, "");
	lines.push(stale.length === 0 ? "None." : stale.map((entry) => `- ${entry.id} — ${entry.title}`).join("\n"));
	lines.push("");

	return lines.join("\n");
}

export async function runGc(memo: Memo, options: GcOptions): Promise<GcResult> {
	memo.reload();

	if (memo.conflicts.size > 0) {
		const detail = [...memo.conflicts].map(([id, files]) => `- ${id}: ${files.join(", ")}`).join("\n");
		return {
			aborted: true,
			conflicts: memo.conflicts,
			problems: memo.problems,
			verify: [],
			similar: [],
			stale: [],
			reports: [],
			summary: `memo GC stopped: ${memo.conflicts.size} conflicting id(s). Resolve them by hand.\n${detail}`,
		};
	}

	const entries = memo.entries();
	const verify: VerifyResult[] = [];
	for (const entry of entries) {
		if (entry.kind !== "env") continue;
		verify.push(await checkVerify(entry, options));
	}
	const similar = findSimilar(entries);
	const stale = findStale(memo, Date.now());

	const reports: string[] = [];
	for (const store of memo.stores) {
		memo.refresh(store);
		const file = reportFilePath(store.dir);
		writeFileSync(file, renderReport(store, { conflicts: memo.conflicts, problems: memo.problems, verify, similar, stale }), "utf8");
		reports.push(file);
	}

	const failed = verify.filter((item) => item.status === "failed" || item.status === "error");
	const summary = [
		`memo GC: ${entries.length} entries checked.`,
		`- format problems: ${memo.problems.length}`,
		`- failed verify checks: ${failed.length}`,
		`- possible duplicates: ${similar.length}`,
		`- not hit in ${STALE_DAYS} days: ${stale.length}`,
		`- reports: ${reports.join(", ")}`,
		options.checkUrls ? "- url content checked" : "- url checks: HTTP status only (--check-urls=true for content)",
	].join("\n");

	return { aborted: false, conflicts: memo.conflicts, problems: memo.problems, verify, similar, stale, reports, summary };
}

export function parseGcArgs(args: string): GcOptions["checkUrls"] {
	const match = /--check-urls(?:=(\S+))?/.exec(args ?? "");
	if (!match) return false;
	const value = match[1];
	return value === undefined || value === "true" || value === "1" || value === "yes";
}
