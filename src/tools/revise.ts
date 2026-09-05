/** `memory_revise`: update a memory in place. */
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Memo } from "../memo.ts";
import type { Verify } from "../store/entry.ts";
import { summarizeEntry } from "./format.ts";

const ReviseParams = Type.Object(
	{
		id: Type.String({ description: "Id of the memory to update" }),
		title: Type.Optional(Type.String()),
		body: Type.Optional(Type.String()),
		verify: Type.Optional(
			Type.Union([
				Type.Object(
					{
						kind: Type.Union([Type.Literal("file"), Type.Literal("command"), Type.Literal("url")]),
						ref: Type.String(),
						expect: Type.String(),
					},
					{ additionalProperties: false },
				),
				Type.Null(),
			]),
		),
		tags: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
	},
	{ additionalProperties: false },
);

interface ReviseInput {
	id: string;
	title?: string;
	body?: string;
	verify?: Verify | null;
	tags?: string[] | null;
}

export function createReviseTool(getMemo: () => Memo): ToolDefinition {
	return {
		name: "memory_revise",
		label: "Revise memory",
		description:
			"Update an existing memory in place. Scope, kind and creation time are kept. " +
			"Omitted fields stay unchanged; `null` clears `verify` or `tags`.",
		promptSnippet: "Update a stored memory in place",
		promptGuidelines: [
			"When a memory you recalled no longer matches what you just observed in the repo, correct it with memory_revise as soon as you notice — do not leave it stale, and do not write a second entry about the same thing.",
		],
		parameters: ReviseParams,
		async execute(_toolCallId, rawParams) {
			const params = rawParams as ReviseInput;
			const entry = getMemo().revise({
				id: params.id,
				...(params.title !== undefined ? { title: params.title } : {}),
				...(params.body !== undefined ? { body: params.body } : {}),
				...(params.verify !== undefined ? { verify: params.verify } : {}),
				...(params.tags !== undefined ? { tags: params.tags } : {}),
			});
			return {
				content: [{ type: "text", text: `Revised ${summarizeEntry(entry)}\n${entry.file}` }],
				details: { id: entry.id, scope: entry.scope, kind: entry.kind, updated: entry.updated },
			};
		},
	};
}
