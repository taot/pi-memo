/** `memory_write`: store one new memory. */
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Mneme } from "../mneme.ts";
import type { Verify } from "../store/entry.ts";
import type { Kind, Scope } from "../store/paths.ts";
import { summarizeEntry } from "./format.ts";

const VerifySchema = Type.Object(
	{
		kind: Type.Union([Type.Literal("file"), Type.Literal("command"), Type.Literal("url")]),
		ref: Type.String({ description: "File path, read-only command, or documentation URL" }),
		expect: Type.String({ description: "Text the check must find" }),
	},
	{ additionalProperties: false },
);

const WriteParams = Type.Object(
	{
		scope: Type.Union([Type.Literal("global"), Type.Literal("project")], {
			description: "global: still true in another repo. project: only true here.",
		}),
		kind: Type.Union([Type.Literal("user"), Type.Literal("env"), Type.Literal("exp")], {
			description: "user: preferences and standing commitments. env: verifiable facts. exp: what to do next time.",
		}),
		id: Type.String({ description: "kebab-case id, unique across global and project memory" }),
		title: Type.String({ description: "One sentence that stands on its own; the search hook in the index" }),
		body: Type.String({ description: "The memory itself, usually under 200 words" }),
		verify: Type.Optional(VerifySchema),
		tags: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);

interface WriteInput {
	scope: Scope;
	kind: Kind;
	id: string;
	title: string;
	body: string;
	verify?: Verify;
	tags?: string[];
}

export function createWriteTool(getMneme: () => Mneme): ToolDefinition {
	return {
		name: "memory_write",
		label: "Write memory",
		description:
			"Store one self-contained memory as a Markdown file. `user` memories are global only. " +
			"Give `env` memories a `verify` check, and say what to do next time in an `exp` body. " +
			"Rejects an id that already exists; use memory_revise for that.",
		promptSnippet: "Store a durable memory (user preference, verifiable fact, or experience)",
		promptGuidelines: [
			"Write a verifiable cause or fact as an `env` memory with memory_write, and the strategy or what-to-do-next-time as an `exp` memory; write both when a lesson has each.",
		],
		parameters: WriteParams,
		async execute(_toolCallId, rawParams) {
			const params = rawParams as WriteInput;
			const mneme = getMneme();

			const existing = mneme.locate(params.id);
			if (existing) {
				throw new Error(
					`id "${params.id}" already exists in the ${existing.entry.scope} store (${existing.entry.file}). ` +
						"Use memory_revise to update it, or pick a different id.",
				);
			}

			const similar = mneme.similarTitles(params.title);
			if (similar.length > 0) {
				const list = similar.map((hit) => `- ${summarizeEntry(hit.entry)}`).join("\n");
				return {
					content: [
						{
							type: "text",
							text:
								`Not written. Existing memories have a very similar title:\n${list}\n\n` +
								"Call memory_recall on those ids, then either memory_revise one of them or write with a title that says something different.",
						},
					],
					details: { written: false, similar: similar.map((hit) => hit.entry.id) },
				};
			}

			const entry = mneme.write({
				scope: params.scope,
				kind: params.kind,
				id: params.id,
				title: params.title,
				body: params.body,
				...(params.verify ? { verify: params.verify } : {}),
				...(params.tags ? { tags: params.tags } : {}),
			});

			return {
				content: [{ type: "text", text: `Wrote ${summarizeEntry(entry)}\n${entry.file}` }],
				details: { written: true, id: entry.id, scope: entry.scope, kind: entry.kind, file: entry.file },
			};
		},
	};
}
