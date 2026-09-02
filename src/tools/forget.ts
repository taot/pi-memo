/** `memory_forget`: delete a memory. */
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Mneme } from "../mneme.ts";
import { summarizeEntry } from "./format.ts";

const ForgetParams = Type.Object({ id: Type.String({ description: "Id of the memory to delete" }) }, {
	additionalProperties: false,
});

export function createForgetTool(getMneme: () => Mneme): ToolDefinition {
	return {
		name: "memory_forget",
		label: "Forget memory",
		description: "Delete a memory file and drop it from the index, the retrieval cache and the usage stats.",
		promptSnippet: "Delete a stored memory",
		promptGuidelines: [
			"Delete a memory with memory_forget only when it is wrong or obsolete, not merely unused.",
		],
		parameters: ForgetParams,
		async execute(_toolCallId, rawParams) {
			const { id } = rawParams as { id: string };
			const entry = getMneme().forget(id);
			return {
				content: [{ type: "text", text: `Forgot ${summarizeEntry(entry)}` }],
				details: { id: entry.id, scope: entry.scope, kind: entry.kind, file: entry.file },
			};
		},
	};
}
