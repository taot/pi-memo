/**
 * Per-store recall statistics (`.local/usage.json`).
 *
 * Hits accumulate in memory during a session and are merged to disk on
 * `agent_settled`, so recall stays cheap and crash-safe enough.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { localDir, usageFilePath } from "./paths.ts";
import { nowIso } from "./entry.ts";

export interface UsageRecord {
	hits: number;
	last_hit: string;
}

export type UsageMap = Record<string, UsageRecord>;

export function readUsage(storeDir: string): UsageMap {
	const file = usageFilePath(storeDir);
	if (!existsSync(file)) return {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as UsageMap;
		if (!parsed || typeof parsed !== "object") return {};
		return parsed;
	} catch {
		return {};
	}
}

export function writeUsage(storeDir: string, usage: UsageMap): void {
	const file = usageFilePath(storeDir);
	mkdirSync(localDir(storeDir), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(usage, null, 2)}\n`, "utf8");
	renameSync(tmp, file);
}

/** Merge pending in-memory hits into the on-disk map. */
export function mergeUsage(usage: UsageMap, pending: Map<string, number>, at: string = nowIso()): UsageMap {
	const merged: UsageMap = { ...usage };
	for (const [id, count] of pending) {
		if (count <= 0) continue;
		const previous = merged[id];
		merged[id] = { hits: (previous?.hits ?? 0) + count, last_hit: at };
	}
	return merged;
}

export function forgetUsage(usage: UsageMap, id: string): UsageMap {
	if (!(id in usage)) return usage;
	const next = { ...usage };
	delete next[id];
	return next;
}

export function usageFileDir(storeDir: string): string {
	return path.dirname(usageFilePath(storeDir));
}
