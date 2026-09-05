/** `memory_recall`: read entries by id, or search them by query. */
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Memo } from "../memo.ts";
import type { Kind } from "../store/paths.ts";
import { formatEntries } from "./format.ts";

const RecallParams = Type.Union([
	Type.Object(
		{
			query: Type.String({ description: "Free-text search over titles, bodies and tags" }),
			kind: Type.Optional(
				Type.Union([Type.Literal("user"), Type.Literal("env"), Type.Literal("exp")], {
					description: "Prefer this memory kind",
				}),
			),
			limit: Type.Optional(Type.Integer({ default: 5, maximum: 15, minimum: 1 })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			ids: Type.Array(Type.String(), { description: "Ids from the memory index" }),
		},
		{ additionalProperties: false },
	),
]);

type RecallInput = { query?: string; kind?: Kind; limit?: number; ids?: string[] };

export function createRecallTool(getMemo: () => Memo): ToolDefinition {
	return {
		name: "memory_recall",
		label: "Recall memory",
		description:
			"Read stored long-term memories. Pass `ids` to load listed entries in full, or `query` to search " +
			"every memory (user preferences, verifiable environment facts, and experience notes). " +
			"Exactly one of `query` or `ids` must be given.",
		promptSnippet: "Read or search stored long-term memories (user, env, exp)",
		promptGuidelines: [
			"When you start on an unfamiliar part of this repo, or hit an error, convention or constraint you have not seen here before, search memory_recall with a query before planning from scratch — the index shows titles only, and caps how many it lists. Skip this when the index says no memories are stored.",
			"When the memo memory index lists an entry that looks relevant, call memory_recall for its full text instead of guessing the content from the title.",
		],
		parameters: RecallParams,
		async execute(_toolCallId, rawParams) {
			const params = rawParams as RecallInput;
			const memo = getMemo();
			const hasQuery = typeof params.query === "string" && params.query.trim().length > 0;
			const hasIds = Array.isArray(params.ids) && params.ids.length > 0;
			if (hasQuery === hasIds) {
				throw new Error("memory_recall needs exactly one of `query` or `ids`");
			}

			if (hasIds) {
				const found = [];
				const missing: string[] = [];
				for (const id of params.ids as string[]) {
					const located = memo.locate(id);
					if (!located) {
						missing.push(id);
						continue;
					}
					found.push(located.entry);
					memo.noteHit(located.entry);
				}
				const text = [
					found.length > 0 ? formatEntries(found) : "No entries found.",
					missing.length > 0 ? `\n\nUnknown ids: ${missing.join(", ")}` : "",
				].join("");
				return {
					content: [{ type: "text", text }],
					details: { mode: "ids", found: found.map((entry) => entry.id), missing },
				};
			}

			const limit = Math.min(params.limit ?? 5, 15);
			const hits = memo.search(params.query as string, {
				...(params.kind ? { kind: params.kind } : {}),
				limit,
			});
			for (const hit of hits) memo.noteHit(hit.entry);

			const text =
				hits.length === 0
					? "No memories matched."
					: formatEntries(hits.map((hit) => hit.entry));
			return {
				content: [{ type: "text", text }],
				details: {
					mode: "query",
					query: params.query,
					hits: hits.map((hit) => ({ id: hit.entry.id, score: Number(hit.score.toFixed(4)) })),
				},
			};
		},
	};
}
