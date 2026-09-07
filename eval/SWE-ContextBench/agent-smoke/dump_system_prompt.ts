/**
 * Print the system prompt the agent actually sees when pi runs with pi-memo.
 *
 *   node --experimental-strip-types dump_system_prompt.ts
 *
 * pi assembles the prompt in dist/core/system-prompt.js from: a fixed preamble,
 * one line per tool (each tool's `promptSnippet`), a Guidelines block (built-in
 * lines plus every tool's `promptGuidelines`), the pi doc paths, then
 * --append-system-prompt, AGENTS.md/CLAUDE.md inside <project_context>, and
 * skills. This reproduces the first three, which is where pi-memo lives.
 *
 * Zero cost, no LLM call. Run it whenever a tool's prompt text changes.
 */
// Deep relative paths: pi's `exports` map only publishes ".", "./rpc-entry" and
// "./client", and neither buildSystemPrompt nor the tool contributions are
// re-exported from the main entry. Fragile across pi upgrades on purpose --
// if this stops resolving, the prompt assembly probably moved too.
const PI = "../../node_modules/@earendil-works/pi-coding-agent/dist";
const { buildSystemPrompt } = await import(`${PI}/core/system-prompt.js`);
const { readToolSystemPromptContribution } = await import(`${PI}/core/tools/read.js`);
const { bashToolSystemPromptContribution } = await import(`${PI}/core/tools/bash.js`);
const { editToolSystemPromptContribution } = await import(`${PI}/core/tools/edit.js`);
const { writeToolSystemPromptContribution } = await import(`${PI}/core/tools/write.js`);

import { createForgetTool } from "../../src/tools/forget.ts";
import { createRecallTool } from "../../src/tools/recall.ts";
import { createReviseTool } from "../../src/tools/revise.ts";
import { createWriteTool } from "../../src/tools/write.ts";

// The tools never run here, so the Memo getter is never called.
const getMemo = () => null as never;
const memoTools = [
	createRecallTool(getMemo),
	createWriteTool(getMemo),
	createReviseTool(getMemo),
	createForgetTool(getMemo),
];

const builtin: Record<string, string> = {
	read: readToolSystemPromptContribution.snippet,
	bash: bashToolSystemPromptContribution.snippet,
	edit: editToolSystemPromptContribution.snippet,
	write: writeToolSystemPromptContribution.snippet,
};

const toolSnippets: Record<string, string> = { ...builtin };
for (const tool of memoTools) {
	if (tool.promptSnippet) toolSnippets[tool.name] = tool.promptSnippet;
}

process.stdout.write(
	buildSystemPrompt({
		selectedTools: [...Object.keys(builtin), ...memoTools.map((tool) => tool.name)],
		toolSnippets,
		promptGuidelines: memoTools.flatMap((tool) => tool.promptGuidelines ?? []),
		cwd: "<workspace>",
	}),
);
process.stdout.write("\n");
