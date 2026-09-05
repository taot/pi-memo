/** `memory_forget`: delete a memory. */
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Memo } from "../memo.ts";
import { summarizeEntry } from "./format.ts";

const ForgetParams = Type.Object({ id: Type.String({ description: "Id of the memory to delete" }) }, {
	additionalProperties: false,
});

export function createForgetTool(getMemo: () => Memo): ToolDefinition {
	return {
		name: "memory_forget",
		label: "Forget memory",
		description: "Delete a memory file and drop it from the index, the retrieval cache and the usage stats.",
		promptSnippet: "Delete a stored memory",
		promptGuidelines: [
			"When a memory turns out to be wrong, or to be about a file, command or behavior this repo no longer has, delete it with memory_forget; leave memories you simply did not use this session alone.",
		],
		parameters: ForgetParams,
		async execute(_toolCallId, rawParams) {
			const { id } = rawParams as { id: string };
			const entry = getMemo().forget(id);
			return {
				content: [{ type: "text", text: `Forgot ${summarizeEntry(entry)}` }],
				details: { id: entry.id, scope: entry.scope, kind: entry.kind, file: entry.file },
			};
		},
	};
}
