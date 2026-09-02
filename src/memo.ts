/**
 * Runtime view over the global and project stores.
 *
 * Everything the tools and commands need goes through here: the combined id
 * view, id-conflict detection, retrieval, mutations, index and cache upkeep,
 * and pending usage counters.
 */
import { existsSync, readFileSync } from "node:fs";
import {
	type Entry,
	type EntryProblem,
	type Verify,
	deleteEntryFile,
	isValidId,
	nowIso,
	writeEntryFile,
} from "./store/entry.ts";
import { loadStoreEntries } from "./store/entry.ts";
import { renderSessionIndex, renderStoreIndex, writeStoreIndex } from "./store/index-file.ts";
import { withStoreLock } from "./store/lock.ts";
import {
	KINDS_BY_SCOPE,
	type Kind,
	type Scope,
	globalStoreDir,
	indexFilePath,
	isKindAllowed,
	projectStoreDir,
} from "./store/paths.ts";
import { type UsageMap, type UsageRecord, forgetUsage, mergeUsage, readUsage, writeUsage } from "./store/usage.ts";
import { type TokenizedDoc, buildIndex, scoreQuery } from "./retrieval/bm25.ts";
import { syncCache, tokenizeEntry } from "./retrieval/cache.ts";
import { finalScore } from "./retrieval/score.ts";
import { tokenize } from "./retrieval/tokenize.ts";

export class MemoError extends Error {}

export interface StoreState {
	scope: Scope;
	dir: string;
	entries: Map<string, Entry>;
	usage: UsageMap;
	pendingHits: Map<string, number>;
	docs: Map<string, TokenizedDoc>;
}

export interface SearchHit {
	entry: Entry;
	score: number;
}

export interface WriteParams {
	scope: Scope;
	kind: Kind;
	id: string;
	title: string;
	body: string;
	verify?: Verify;
	tags?: string[];
}

export interface ReviseParams {
	id: string;
	title?: string;
	body?: string;
	verify?: Verify | null;
	tags?: string[] | null;
}

/** Token overlap of two titles, used to flag near-duplicates. */
export function titleSimilarity(a: string, b: string): number {
	const left = new Set(tokenize(a));
	const right = new Set(tokenize(b));
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	for (const token of left) if (right.has(token)) shared++;
	return shared / (left.size + right.size - shared);
}

export const SIMILAR_TITLE_THRESHOLD = 0.6;

export class Memo {
	readonly cwd: string;
	readonly stores: StoreState[] = [];
	/** id -> files, for ids that resolve to more than one memory file. */
	conflicts = new Map<string, string[]>();
	problems: EntryProblem[] = [];

	private constructor(cwd: string) {
		this.cwd = cwd;
	}

	static load(cwd: string): Memo {
		const memo = new Memo(cwd);
		memo.reload();
		return memo;
	}

	/** Re-read both stores from disk and refresh caches. */
	reload(): void {
		const pending = new Map<string, Map<string, number>>();
		for (const store of this.stores) pending.set(store.scope, store.pendingHits);

		this.stores.length = 0;
		this.problems = [];

		const global = globalStoreDir();
		const project = projectStoreDir(this.cwd);
		const dirs: { scope: Scope; dir: string }[] = [{ scope: "global", dir: global }];
		if (project !== global) dirs.push({ scope: "project", dir: project });

		const seen = new Map<string, string[]>();

		for (const { scope, dir } of dirs) {
			const loaded = loadStoreEntries(dir, scope, KINDS_BY_SCOPE[scope]);
			this.problems.push(...loaded.problems);
			const entries = new Map<string, Entry>();
			for (const entry of loaded.entries) {
				entries.set(entry.id, entry);
				seen.set(entry.id, [...(seen.get(entry.id) ?? []), entry.file]);
			}
			// Files sharing an id inside one store: keep both paths for the report.
			for (const [id, files] of loaded.duplicates) seen.set(id, files);

			const docs = existsSync(dir) ? syncCache(dir, loaded.entries) : loaded.entries.map(tokenizeEntry);
			this.stores.push({
				scope,
				dir,
				entries,
				usage: readUsage(dir),
				pendingHits: pending.get(scope) ?? new Map(),
				docs: new Map(docs.map((doc) => [doc.id, doc])),
			});
		}

		this.conflicts = new Map([...seen].filter(([, files]) => files.length > 1));
	}

	store(scope: Scope): StoreState {
		const found = this.stores.find((store) => store.scope === scope);
		if (!found) throw new MemoError(`no ${scope} memory store available`);
		return found;
	}

	hasProjectStore(): boolean {
		return this.stores.some((store) => store.scope === "project");
	}

	/** All usable entries; ids in conflict are excluded everywhere. */
	entries(): Entry[] {
		const out: Entry[] = [];
		for (const store of this.stores) {
			for (const entry of store.entries.values()) {
				if (!this.conflicts.has(entry.id)) out.push(entry);
			}
		}
		return out;
	}

	usageOf(id: string): UsageRecord | undefined {
		for (const store of this.stores) {
			const record = store.usage[id];
			if (record) return record;
		}
		return undefined;
	}

	usageMap(): Map<string, UsageRecord> {
		const map = new Map<string, UsageRecord>();
		for (const store of this.stores) {
			for (const [id, record] of Object.entries(store.usage)) map.set(id, record);
		}
		return map;
	}

	/** Locate an entry by id in the combined view. Throws on a conflicting id. */
	locate(id: string): { entry: Entry; store: StoreState } | undefined {
		this.assertNoConflict(id);
		for (const store of this.stores) {
			const entry = store.entries.get(id);
			if (entry) return { entry, store };
		}
		return undefined;
	}

	assertNoConflict(id: string): void {
		const files = this.conflicts.get(id);
		if (files) {
			throw new MemoError(
				`id "${id}" resolves to more than one memory file (${files.join(", ")}). ` +
					"Resolve the duplicate by hand; memory tools refuse to touch this id.",
			);
		}
	}

	// --- retrieval -------------------------------------------------------

	search(query: string, options: { kind?: Kind; limit?: number } = {}): SearchHit[] {
		const entries = this.entries();
		if (entries.length === 0) return [];

		const docs: TokenizedDoc[] = [];
		const byId = new Map<string, Entry>();
		for (const entry of entries) {
			const store = this.store(entry.scope);
			docs.push(store.docs.get(entry.id) ?? tokenizeEntry(entry));
			byId.set(entry.id, entry);
		}

		const index = buildIndex(docs);
		const raw = scoreQuery(index, tokenize(query));
		const now = Date.now();
		const hits: SearchHit[] = [];
		for (const [id, base] of raw) {
			const entry = byId.get(id);
			if (!entry) continue;
			hits.push({
				entry,
				score: finalScore(base, entry, { ...(options.kind ? { kind: options.kind } : {}), usage: this.usageOf(id), now }),
			});
		}
		hits.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
		return hits.slice(0, options.limit ?? 5);
	}

	/** Record a recall hit in memory; flushed on `agent_settled`. */
	noteHit(entry: Entry): void {
		const store = this.store(entry.scope);
		store.pendingHits.set(entry.id, (store.pendingHits.get(entry.id) ?? 0) + 1);
	}

	flushUsage(): void {
		for (const store of this.stores) {
			if (store.pendingHits.size === 0) continue;
			const at = nowIso();
			try {
				withStoreLock(store.dir, () => {
					const onDisk = readUsage(store.dir);
					const merged = mergeUsage(onDisk, store.pendingHits, at);
					writeUsage(store.dir, merged);
					store.usage = merged;
				});
				store.pendingHits.clear();
			} catch {
				// Keep the counters pending; the next settle retries.
			}
		}
	}

	// --- mutations -------------------------------------------------------

	write(params: WriteParams): Entry {
		const { scope, kind, id, title, body } = params;
		if (!isValidId(id)) throw new MemoError(`id "${id}" must be kebab-case (a-z, 0-9, dashes)`);
		if (!title.trim()) throw new MemoError("title must not be empty");
		if (!body.trim()) throw new MemoError("body must not be empty");
		if (!isKindAllowed(scope, kind)) {
			throw new MemoError(`kind "${kind}" is not allowed in the ${scope} store`);
		}
		if (scope === "project" && !this.hasProjectStore()) {
			throw new MemoError("no project store available for this working directory");
		}
		this.assertNoConflict(id);
		validateVerify(scope, params.verify);

		const existing = this.locate(id);
		if (existing) {
			throw new MemoError(
				`id "${id}" already exists in the ${existing.entry.scope} store (${existing.entry.file}). ` +
					"Use memory_revise to update it, or pick a different id.",
			);
		}

		const now = nowIso();
		const store = this.store(scope);
		const entry: Entry = {
			id,
			kind,
			scope,
			title: title.trim(),
			body: body.trim(),
			created: now,
			updated: now,
			...(params.verify ? { verify: params.verify } : {}),
			...(params.tags && params.tags.length > 0 ? { tags: params.tags } : {}),
			file: "",
		};

		withStoreLock(store.dir, () => {
			entry.file = writeEntryFile(store.dir, entry);
			store.entries.set(id, entry);
			this.refresh(store);
		});
		return entry;
	}

	revise(params: ReviseParams): Entry {
		const found = this.locate(params.id);
		if (!found) throw new MemoError(`no memory with id "${params.id}"`);
		const { entry, store } = found;

		if (params.title !== undefined && !params.title.trim()) throw new MemoError("title must not be empty");
		if (params.body !== undefined && !params.body.trim()) throw new MemoError("body must not be empty");
		if (params.verify) validateVerify(entry.scope, params.verify);

		const next: Entry = {
			...entry,
			title: params.title?.trim() ?? entry.title,
			body: params.body?.trim() ?? entry.body,
			updated: nowIso(),
		};
		if (params.verify === null) delete next.verify;
		else if (params.verify !== undefined) next.verify = params.verify;
		if (params.tags === null) delete next.tags;
		else if (params.tags !== undefined) {
			if (params.tags.length > 0) next.tags = params.tags;
			else delete next.tags;
		}

		withStoreLock(store.dir, () => {
			next.file = writeEntryFile(store.dir, next);
			store.entries.set(next.id, next);
			this.refresh(store);
		});
		return next;
	}

	forget(id: string): Entry {
		const found = this.locate(id);
		if (!found) throw new MemoError(`no memory with id "${id}"`);
		const { entry, store } = found;

		withStoreLock(store.dir, () => {
			deleteEntryFile(entry);
			store.entries.delete(id);
			store.pendingHits.delete(id);
			store.usage = forgetUsage(readUsage(store.dir), id);
			writeUsage(store.dir, store.usage);
			this.refresh(store);
		});
		return entry;
	}

	/** Rewrite `MEMORY.md` and the retrieval cache for one store. */
	refresh(store: StoreState): void {
		const entries = [...store.entries.values()];
		writeStoreIndex(store.dir, store.scope, entries);
		const docs = syncCache(store.dir, entries);
		store.docs = new Map(docs.map((doc) => [doc.id, doc]));
	}

	/** Entries whose title is close to `title`, for write-time dedupe. */
	similarTitles(title: string, threshold = SIMILAR_TITLE_THRESHOLD): SearchHit[] {
		return this.entries()
			.map((entry) => ({ entry, score: titleSimilarity(entry.title, title) }))
			.filter((hit) => hit.score >= threshold)
			.sort((a, b) => b.score - a.score);
	}

	/**
	 * Bring `MEMORY.md` back in sync after loading. The retrieval cache is
	 * already rebuilt by `reload()` whenever the source hash changed.
	 */
	syncIndexFiles(): void {
		for (const store of this.stores) {
			if (!existsSync(store.dir)) continue;
			const entries = [...store.entries.values()];
			const desired = renderStoreIndex(store.scope, entries);
			const file = indexFilePath(store.dir);
			const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
			if (current === desired) continue;
			try {
				withStoreLock(store.dir, () => writeStoreIndex(store.dir, store.scope, entries));
			} catch {
				// Another session holds the lock; it will write the same content.
			}
		}
	}

	sessionIndex(): string {
		return renderSessionIndex({
			entries: this.entries(),
			usage: this.usageMap(),
			conflicts: this.conflicts,
			problems: this.problems,
		});
	}
}

function validateVerify(scope: Scope, verify?: Verify | null): void {
	if (!verify) return;
	if (!verify.ref.trim()) throw new MemoError("verify.ref must not be empty");
	if (!verify.expect.trim()) throw new MemoError("verify.expect must not be empty");
	if (/:\d+$/.test(verify.ref) && verify.kind === "file") {
		throw new MemoError("verify.ref must not carry a line number");
	}
	if (scope === "global" && verify.kind === "file" && !/^([~/]|[A-Za-z]:[\\/])/.test(verify.ref)) {
		throw new MemoError(
			"a global memory must not verify against a project-relative file; use an absolute path or a different verify kind",
		);
	}
}
