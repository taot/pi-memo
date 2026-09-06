/**
 * pi-memo: long-term memory for pi.
 *
 * Memories are Markdown files under `~/.pi/memo` (global) and
 * `<repo>/.pi/memo` (project). Every session gets a fixed index snapshot in
 * context; the model reads, writes, revises and forgets entries through tools.
 */
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Memo, MemoError } from "./memo.ts";
import { closingNudge } from "./store/index-file.ts";
import { runGc, parseGcArgs } from "./commands/gc.ts";
import { runStats } from "./commands/stats.ts";
import { createForgetTool } from "./tools/forget.ts";
import { createReviseTool } from "./tools/revise.ts";
import { createRecallTool } from "./tools/recall.ts";
import { createWriteTool } from "./tools/write.ts";

const INDEX_MESSAGE_TYPE = "memo-index";
const REMINDER_MESSAGE_TYPE = "memo-write-reminder";

type AgentMessage = ContextEvent["messages"][number];

interface IndexMessage {
	role: "custom";
	customType: string;
	content: string;
	display: boolean;
	timestamp: number;
}

export default function memoExtension(pi: ExtensionAPI): void {
	let memo: Memo | undefined;
	/** Fixed snapshot for this session; refreshed only on the next session. */
	let sessionIndex: IndexMessage | undefined;
	/** Built with the snapshot: which tools it names depends on what is stored. */
	let writeReminder: IndexMessage | undefined;

	const getMemo = (): Memo => {
		if (!memo) memo = Memo.load(process.cwd());
		return memo;
	};

	pi.on("session_start", async (_event, ctx) => {
		try {
			memo = Memo.load(ctx.cwd);
			memo.syncIndexFiles();
			sessionIndex = {
				role: "custom",
				customType: INDEX_MESSAGE_TYPE,
				content: memo.sessionIndex(),
				display: false,
				timestamp: Date.now(),
			};
			writeReminder = {
				role: "custom",
				customType: REMINDER_MESSAGE_TYPE,
				content: closingNudge(memo.entries().length > 0),
				display: false,
				timestamp: Date.now(),
			};
			if (memo.conflicts.size > 0) {
				ctx.ui.notify(
					`memo: ${memo.conflicts.size} conflicting memory id(s) excluded; run /memo-gc for details`,
					"warning",
				);
			}
			if (memo.problems.length > 0) {
				ctx.ui.notify(`memo: ${memo.problems.length} unreadable memory file(s)`, "warning");
			}
		} catch (error) {
			sessionIndex = undefined;
			writeReminder = undefined;
			ctx.ui.notify(`memo: failed to load memories: ${(error as Error).message}`, "error");
		}
	});

	// The snapshot rides at the head of every LLM call, and the write trigger at
	// the tail.
	//
	// The trigger used to sit inside the snapshot, and measurably did nothing:
	// four arm-A runs called the memory tools zero times, same as with no trigger
	// at all (eval/agent-smoke/NOTES.md). A payload dump ruled out delivery — pi
	// turns the snapshot into a plain `role: "user"` message, the same channel as
	// the one nudge that did produce a write. What set that nudge apart was
	// position: it was part of the task statement the model was working to
	// satisfy, not a preamble sitting in front of it. At the tail this lands
	// directly after the task on the first call, and after the latest tool result
	// on every call after that, which is the closest we can get without editing
	// the user's own message.
	pi.on("context", async (event) => {
		if (!sessionIndex || !writeReminder) return;
		return {
			messages: [sessionIndex as unknown as AgentMessage, ...event.messages, writeReminder as unknown as AgentMessage],
		};
	});

	pi.on("agent_settled", async () => {
		memo?.flushUsage();
	});

	pi.on("session_shutdown", async () => {
		memo?.flushUsage();
	});

	pi.registerTool(createRecallTool(getMemo));
	pi.registerTool(createWriteTool(getMemo));
	pi.registerTool(createReviseTool(getMemo));
	pi.registerTool(createForgetTool(getMemo));

	pi.registerCommand("memo-gc", {
		description: "Check memories, report duplicates/stale/failed verifications, rebuild index and cache",
		getArgumentCompletions: (prefix: string) => {
			const items = [{ value: "--check-urls=true", label: "--check-urls=true" }];
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			ctx.ui.notify("memo: running GC...", "info");
			try {
				// The injected snapshot stays fixed for the session; tools read live
				// state, so recall still sees whatever GC rebuilt.
				const result = await runGc(getMemo(), { cwd: ctx.cwd, checkUrls: parseGcArgs(args) });
				ctx.ui.notify(result.aborted ? "memo GC stopped: id conflicts" : "memo GC done", result.aborted ? "warning" : "info");
				// No delivery mode: while idle, pi appends and renders the message
				// immediately. `nextTurn` would defer it until the next prompt.
				await pi.sendMessage({ customType: "memo-gc", content: result.summary, display: true });
			} catch (error) {
				ctx.ui.notify(`memo GC failed: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("memo-stats", {
		description: "Show memory counts, unused ratio and injected index size",
		handler: async (_args: string, ctx: ExtensionContext) => {
			try {
				const stats = runStats(getMemo());
				await pi.sendMessage({ customType: "memo-stats", content: stats.text, display: true });
			} catch (error) {
				ctx.ui.notify(`memo stats failed: ${(error as Error).message}`, "error");
			}
		},
	});
}

export { Memo, MemoError };
