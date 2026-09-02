/**
 * pi-mneme: long-term memory for pi.
 *
 * Memories are Markdown files under `~/.pi/mneme` (global) and
 * `<repo>/.pi/mneme` (project). Every session gets a fixed index snapshot in
 * context; the model reads, writes, revises and forgets entries through tools.
 */
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Mneme, MnemeError } from "./mneme.ts";
import { runGc, parseGcArgs } from "./commands/gc.ts";
import { runStats } from "./commands/stats.ts";
import { createForgetTool } from "./tools/forget.ts";
import { createReviseTool } from "./tools/revise.ts";
import { createRecallTool } from "./tools/recall.ts";
import { createWriteTool } from "./tools/write.ts";

const INDEX_MESSAGE_TYPE = "mneme-index";

type AgentMessage = ContextEvent["messages"][number];

interface IndexMessage {
	role: "custom";
	customType: string;
	content: string;
	display: boolean;
	timestamp: number;
}

export default function mnemeExtension(pi: ExtensionAPI): void {
	let mneme: Mneme | undefined;
	/** Fixed snapshot for this session; refreshed only on the next session. */
	let sessionIndex: IndexMessage | undefined;

	const getMneme = (): Mneme => {
		if (!mneme) mneme = Mneme.load(process.cwd());
		return mneme;
	};

	pi.on("session_start", async (_event, ctx) => {
		try {
			mneme = Mneme.load(ctx.cwd);
			mneme.syncIndexFiles();
			sessionIndex = {
				role: "custom",
				customType: INDEX_MESSAGE_TYPE,
				content: mneme.sessionIndex(),
				display: false,
				timestamp: Date.now(),
			};
			if (mneme.conflicts.size > 0) {
				ctx.ui.notify(
					`mneme: ${mneme.conflicts.size} conflicting memory id(s) excluded; run /mneme-gc for details`,
					"warning",
				);
			}
			if (mneme.problems.length > 0) {
				ctx.ui.notify(`mneme: ${mneme.problems.length} unreadable memory file(s)`, "warning");
			}
		} catch (error) {
			sessionIndex = undefined;
			ctx.ui.notify(`mneme: failed to load memories: ${(error as Error).message}`, "error");
		}
	});

	// The snapshot rides at the head of every LLM call for this session.
	pi.on("context", async (event) => {
		if (!sessionIndex) return;
		return { messages: [sessionIndex as unknown as AgentMessage, ...event.messages] };
	});

	pi.on("agent_settled", async () => {
		mneme?.flushUsage();
	});

	pi.on("session_shutdown", async () => {
		mneme?.flushUsage();
	});

	pi.registerTool(createRecallTool(getMneme));
	pi.registerTool(createWriteTool(getMneme));
	pi.registerTool(createReviseTool(getMneme));
	pi.registerTool(createForgetTool(getMneme));

	pi.registerCommand("mneme-gc", {
		description: "Check memories, report duplicates/stale/failed verifications, rebuild index and cache",
		getArgumentCompletions: (prefix: string) => {
			const items = [{ value: "--check-urls=true", label: "--check-urls=true" }];
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			ctx.ui.notify("mneme: running GC...", "info");
			try {
				// The injected snapshot stays fixed for the session; tools read live
				// state, so recall still sees whatever GC rebuilt.
				const result = await runGc(getMneme(), { cwd: ctx.cwd, checkUrls: parseGcArgs(args) });
				ctx.ui.notify(result.aborted ? "mneme GC stopped: id conflicts" : "mneme GC done", result.aborted ? "warning" : "info");
				// No delivery mode: while idle, pi appends and renders the message
				// immediately. `nextTurn` would defer it until the next prompt.
				await pi.sendMessage({ customType: "mneme-gc", content: result.summary, display: true });
			} catch (error) {
				ctx.ui.notify(`mneme GC failed: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("mneme-stats", {
		description: "Show memory counts, unused ratio and injected index size",
		handler: async (_args: string, ctx: ExtensionContext) => {
			try {
				const stats = runStats(getMneme());
				await pi.sendMessage({ customType: "mneme-stats", content: stats.text, display: true });
			} catch (error) {
				ctx.ui.notify(`mneme stats failed: ${(error as Error).message}`, "error");
			}
		},
	});
}

export { Mneme, MnemeError };
