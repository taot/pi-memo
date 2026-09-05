import { describe, expect, it } from "vitest";
import type { Entry } from "../src/store/entry.ts";
import { CLOSING_NUDGE, MAX_INDEX_ENTRIES, estimateTokens, renderSessionIndex, renderStoreIndex } from "../src/store/index-file.ts";

function entry(id: string, overrides: Partial<Entry> = {}): Entry {
	return {
		id,
		kind: "env",
		scope: "global",
		title: `title of ${id}`,
		body: "body",
		created: "2026-01-01T00:00:00+00:00",
		updated: "2026-01-01T00:00:00+00:00",
		file: `/tmp/${id}.md`,
		...overrides,
	};
}

describe("MEMORY.md", () => {
	it("groups by kind and links each file", () => {
		const text = renderStoreIndex("project", [entry("a"), entry("b", { kind: "exp" })]);
		expect(text).toContain("# Project memory index");
		expect(text).toContain("## env");
		expect(text).toContain("- [a](env/a.md) — title of a");
		expect(text).toContain("- [b](exp/b.md) — title of b");
	});
});

describe("session index snapshot", () => {
	const empty = new Map<string, { hits: number; last_hit: string }>();

	it("lists project entries before global ones", () => {
		const text = renderSessionIndex({
			entries: [entry("g"), entry("p", { scope: "project" })],
			usage: empty,
			conflicts: new Map(),
		});
		expect(text.indexOf("p —")).toBeLessThan(text.indexOf("g —"));
	});

	// The write trigger has to survive a cold start: with an empty store the index
	// lists nothing, so this line is all that is left of it in the snapshot.
	it("closes with the write nudge, empty store included", () => {
		for (const entries of [[], [entry("g")]]) {
			const text = renderSessionIndex({ entries, usage: empty, conflicts: new Map() });
			expect(text.trimEnd().endsWith(CLOSING_NUDGE)).toBe(true);
		}
	});

	it("caps the number of listed entries and says how many are left", () => {
		const entries = Array.from({ length: MAX_INDEX_ENTRIES + 7 }, (_, i) => entry(`e${i}`));
		const text = renderSessionIndex({ entries, usage: empty, conflicts: new Map() });
		const listed = text.split("\n").filter((line) => /^- \[g\/env\]/.test(line));
		expect(listed).toHaveLength(MAX_INDEX_ENTRIES);
		expect(text).toContain("7 more entries not listed");
	});

	it("orders by last hit within a scope", () => {
		const usage = new Map([
			["old", { hits: 1, last_hit: "2026-01-01T00:00:00+00:00" }],
			["fresh", { hits: 1, last_hit: "2026-08-01T00:00:00+00:00" }],
		]);
		const text = renderSessionIndex({ entries: [entry("old"), entry("fresh")], usage, conflicts: new Map() });
		expect(text.indexOf("fresh —")).toBeLessThan(text.indexOf("old —"));
	});
});

describe("token estimate", () => {
	it("counts CJK characters individually", () => {
		expect(estimateTokens("窗口坐标")).toBe(4);
		expect(estimateTokens("abcd")).toBe(1);
	});
});
