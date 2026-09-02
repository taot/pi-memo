/**
 * Retrieval cache (`<store>/.cache/index.json`).
 *
 * Holds tokenized documents plus the hash of the memory files they came from.
 * Everything here is rebuildable, so a missing or stale cache is never an error.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Entry } from "../store/entry.ts";
import { cacheDir } from "../store/paths.ts";
import { TOKENIZER_VERSION, tokenize } from "./tokenize.ts";
import type { TokenizedDoc } from "./bm25.ts";

export const CACHE_VERSION = 1;

export interface CacheFile {
	version: number;
	tokenizer: string;
	sourceHash: string;
	docs: TokenizedDoc[];
}

function cacheFilePath(storeDir: string): string {
	return path.join(cacheDir(storeDir), "index.json");
}

/** Hash of the memory files backing a store. */
export function sourceHash(entries: Entry[]): string {
	const hash = createHash("sha256");
	for (const entry of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
		hash.update([entry.id, entry.updated, entry.title, entry.body, (entry.tags ?? []).join(",")].join("\u0000"));
	}
	return hash.digest("hex");
}

export function tokenizeEntry(entry: Entry): TokenizedDoc {
	return {
		id: entry.id,
		title: tokenize(entry.title),
		body: tokenize(entry.body),
		tags: tokenize((entry.tags ?? []).join(" ")),
	};
}

export function readCache(storeDir: string): CacheFile | undefined {
	const file = cacheFilePath(storeDir);
	if (!existsSync(file)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as CacheFile;
		if (parsed.version !== CACHE_VERSION || parsed.tokenizer !== TOKENIZER_VERSION) return undefined;
		if (!Array.isArray(parsed.docs)) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

export function writeCache(storeDir: string, cache: CacheFile): void {
	const file = cacheFilePath(storeDir);
	mkdirSync(cacheDir(storeDir), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(cache)}\n`, "utf8");
	renameSync(tmp, file);
}

/**
 * Return tokenized docs for a store, reusing the cache when the source hash
 * still matches and rewriting it otherwise.
 */
export function syncCache(storeDir: string, entries: Entry[]): TokenizedDoc[] {
	const hash = sourceHash(entries);
	const cached = readCache(storeDir);
	if (cached && cached.sourceHash === hash) return cached.docs;

	const docs = entries.map(tokenizeEntry);
	try {
		writeCache(storeDir, { version: CACHE_VERSION, tokenizer: TOKENIZER_VERSION, sourceHash: hash, docs });
	} catch {
		/* a read-only store still works, just without a cache */
	}
	return docs;
}
