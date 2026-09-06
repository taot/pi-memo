/**
 * `MEMORY.md` (one per store) and the session index snapshot injected into
 * context. Both are generated; neither is edited by hand.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Entry } from "./entry.ts";
import { KINDS, type Kind, type Scope, indexFilePath } from "./paths.ts";
import type { UsageMap } from "./usage.ts";

/**
 * The write trigger, repeating what also rides in `memory_write`'s
 * `promptGuidelines`. Delivered as the *last* message in context, not part of
 * this snapshot — see the `context` hook in `src/index.ts` for why.
 *
 * This variant is for an empty store, where write is the only tool with anything
 * to do.
 *
 * The quality bar is `memory_write`'s own guideline wording, repeated verbatim
 * rather than paraphrased: one phrasing in two places is one thing to tune. It is
 * here because the one memory a run did write was a correct but single-use lesson
 * — how to keep `flask routes` backward compatible while adding a column — which
 * the next task in that repo could not reuse (eval/agent-smoke/NOTES.md 结论 8);
 * "skip a narration of what you just did" is the clause that rules that out.
 */
export const CLOSING_NUDGE =
	"Before you finish this task, ask whether anything you learned would have saved you time had you known it at the start — a non-obvious cause, a constraint that shaped the fix, an approach that worked after others failed. Store that with memory_write. Skip what is already plain from the code, the task text, or a single command, and skip a narration of what you just did; if nothing clears that bar, write nothing.";

/**
 * The trigger once the store has entries: the other three tools act on stored
 * memories, so they are worth naming only when there are some. Recall comes first
 * because the check it prompts — does an entry already cover this? — is what
 * routes the rest to revise instead of a duplicate write.
 *
 * Listing them against an empty index would be exactly the cold-start busywork the
 * recall guideline's own exemption is meant to prevent: three of four arm-A runs
 * opened with a recall that could only return nothing (eval/agent-smoke/NOTES.md).
 */
export const CLOSING_NUDGE_WITH_STORE = [
	CLOSING_NUDGE,
	"Check the memory index above first: read a listed entry with memory_recall instead of guessing it from the title, and if one already covers what you were about to store, or no longer matches what you saw in this repo, correct it with memory_revise rather than adding a second entry about the same thing. Delete one with memory_forget only when it is wrong or is about a file, command or behavior this repo no longer has — not merely because you did not use it.",
].join(" ");

/** The trigger that fits the store: the extra tools need something to act on. */
export function closingNudge(hasEntries: boolean): string {
	return hasEntries ? CLOSING_NUDGE_WITH_STORE : CLOSING_NUDGE;
}

/** Caps for the injected snapshot; whichever is reached first wins. */
export const MAX_INDEX_ENTRIES = 50;
export const MAX_INDEX_TOKENS = 2000;

/** Cheap token estimate: one per CJK character, one per four other characters. */
export function estimateTokens(text: string): number {
	let cjk = 0;
	let other = 0;
	for (const ch of text) {
		if (/[㐀-䶿一-鿿豈-﫿぀-ヿ]/.test(ch)) cjk++;
		else other++;
	}
	return cjk + Math.ceil(other / 4);
}

function byKind(entries: Entry[]): Map<Kind, Entry[]> {
	const grouped = new Map<Kind, Entry[]>();
	for (const kind of KINDS) {
		const of = entries.filter((entry) => entry.kind === kind).sort((a, b) => a.id.localeCompare(b.id));
		if (of.length > 0) grouped.set(kind, of);
	}
	return grouped;
}

export function renderStoreIndex(scope: Scope, entries: Entry[]): string {
	const lines = [`# ${scope === "project" ? "Project" : "Global"} memory index`, ""];
	for (const [kind, of] of byKind(entries)) {
		lines.push(`## ${kind}`);
		for (const entry of of) lines.push(`- [${entry.id}](${kind}/${entry.id}.md) — ${entry.title}`);
		lines.push("");
	}
	if (entries.length === 0) lines.push("_No memories yet._", "");
	return lines.join("\n");
}

export function writeStoreIndex(storeDir: string, scope: Scope, entries: Entry[]): void {
	const file = indexFilePath(storeDir);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, renderStoreIndex(scope, entries), "utf8");
}

export interface SessionIndexInput {
	entries: Entry[];
	usage: Map<string, UsageMap[string]>;
	/** id -> conflicting file paths, reported but never listed as usable. */
	conflicts: Map<string, string[]>;
	problems?: { file: string; message: string }[];
}

/**
 * Order for the snapshot: project entries first, then most recently hit.
 * Entries never hit fall back to their `updated` time.
 */
function snapshotOrder(entries: Entry[], usage: Map<string, UsageMap[string]>): Entry[] {
	const rank = (entry: Entry): number => {
		const hit = usage.get(entry.id)?.last_hit;
		const stamp = Date.parse(hit ?? entry.updated);
		return Number.isNaN(stamp) ? 0 : stamp;
	};
	return [...entries].sort((a, b) => {
		if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
		const diff = rank(b) - rank(a);
		return diff !== 0 ? diff : a.id.localeCompare(b.id);
	});
}

/** Render the fixed index snapshot injected at the head of the session context. */
export function renderSessionIndex(input: SessionIndexInput): string {
	const header = [
		"# memo memory index",
		"",
		"Stored long-term memories. Titles are hooks, not content:",
		"call memory_recall with `ids` for the full text of a listed entry, or with `query` to search everything.",
		"",
	];

	const ordered = snapshotOrder(input.entries, input.usage);
	const listed: Entry[] = [];
	let tokens = estimateTokens(header.join("\n"));

	for (const entry of ordered) {
		if (listed.length >= MAX_INDEX_ENTRIES) break;
		const line = `- [${entry.scope[0]}/${entry.kind}] ${entry.id} — ${entry.title}`;
		const cost = estimateTokens(line);
		if (tokens + cost > MAX_INDEX_TOKENS) break;
		tokens += cost;
		listed.push(entry);
	}

	const lines = [...header];
	if (listed.length === 0) {
		lines.push("_No memories stored yet._");
	} else {
		for (const entry of listed) {
			lines.push(`- [${entry.scope[0]}/${entry.kind}] ${entry.id} — ${entry.title}`);
		}
	}

	const remaining = input.entries.length - listed.length;
	if (remaining > 0) {
		lines.push("", `_${remaining} more entries not listed. Use memory_recall with a query to search them._`);
	}

	if (input.conflicts.size > 0) {
		lines.push("", "## Conflicting ids (excluded, resolve by hand)");
		for (const [id, files] of input.conflicts) {
			lines.push(`- ${id}: ${files.join(", ")}`);
		}
		lines.push("", "_Memory tools refuse to touch these ids until the duplicate files are resolved._");
	}

	if (input.problems && input.problems.length > 0) {
		lines.push("", "## Unreadable memory files");
		for (const problem of input.problems) lines.push(`- ${problem.file}: ${problem.message}`);
	}

	return lines.join("\n");
}
