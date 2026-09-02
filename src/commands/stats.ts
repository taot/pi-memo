/** `/mneme-stats`: entry counts, unused ratio, and the size of the injected index. */
import type { Mneme } from "../mneme.ts";
import { KINDS, type Kind, type Scope } from "../store/paths.ts";
import { MAX_INDEX_ENTRIES, MAX_INDEX_TOKENS, estimateTokens } from "../store/index-file.ts";

export interface StatsResult {
	total: number;
	byScopeKind: Map<string, number>;
	unused: number;
	unusedRatio: number;
	indexEntries: number;
	indexTokens: number;
	text: string;
}

export function runStats(mneme: Mneme): StatsResult {
	const entries = mneme.entries();
	const byScopeKind = new Map<string, number>();
	for (const entry of entries) {
		const key = `${entry.scope}/${entry.kind}`;
		byScopeKind.set(key, (byScopeKind.get(key) ?? 0) + 1);
	}

	const unused = entries.filter((entry) => (mneme.usageOf(entry.id)?.hits ?? 0) === 0).length;
	const index = mneme.sessionIndex();
	const indexEntries = index.split("\n").filter((line) => /^- \[[gp]\//.test(line)).length;
	const indexTokens = estimateTokens(index);

	const lines = ["# mneme stats", "", `Total entries: ${entries.length}`, ""];
	for (const scope of ["global", "project"] as Scope[]) {
		const store = mneme.stores.find((candidate) => candidate.scope === scope);
		if (!store) continue;
		const counts = KINDS.map((kind: Kind) => `${kind} ${byScopeKind.get(`${scope}/${kind}`) ?? 0}`).join(", ");
		lines.push(`- ${scope} (${store.dir}): ${counts}`);
	}
	lines.push(
		"",
		`Never recalled: ${unused} (${entries.length === 0 ? 0 : Math.round((unused / entries.length) * 100)}%)`,
		`Injected index: ${indexEntries} entries, ~${indexTokens} tokens ` +
			`(limits: ${MAX_INDEX_ENTRIES} entries / ${MAX_INDEX_TOKENS} tokens)`,
	);
	if (mneme.conflicts.size > 0) lines.push(`Conflicting ids: ${mneme.conflicts.size}`);
	if (mneme.problems.length > 0) lines.push(`Unreadable files: ${mneme.problems.length}`);

	return {
		total: entries.length,
		byScopeKind,
		unused,
		unusedRatio: entries.length === 0 ? 0 : unused / entries.length,
		indexEntries,
		indexTokens,
		text: lines.join("\n"),
	};
}
