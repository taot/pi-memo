/** Shared rendering of memory entries for tool output. */
import type { Entry } from "../store/entry.ts";

export function formatEntry(entry: Entry): string {
	const lines = [`## ${entry.id}  [${entry.scope}/${entry.kind}]`, `title: ${entry.title}`, `updated: ${entry.updated}`];
	if (entry.verify) {
		lines.push(`verify: ${entry.verify.kind} ${entry.verify.ref} -> ${entry.verify.expect}`);
	}
	if (entry.tags && entry.tags.length > 0) lines.push(`tags: ${entry.tags.join(", ")}`);
	lines.push("", entry.body);
	return lines.join("\n");
}

export function formatEntries(entries: Entry[]): string {
	return entries.map(formatEntry).join("\n\n---\n\n");
}

export function summarizeEntry(entry: Entry): string {
	return `[${entry.scope}/${entry.kind}] ${entry.id} — ${entry.title}`;
}
