/**
 * A memory entry: one Markdown file holding one self-contained conclusion.
 *
 * The frontmatter is a fixed, flat schema, so it is parsed and rendered by a
 * small dedicated reader/writer instead of a general YAML library.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from "node:fs";
import * as path from "node:path";
import { KINDS, type Kind, type Scope, entryPath, kindDir } from "./paths.ts";

export const VERIFY_KINDS = ["file", "command", "url"] as const;
export type VerifyKind = (typeof VERIFY_KINDS)[number];

export interface Verify {
	kind: VerifyKind;
	ref: string;
	expect: string;
}

export interface Entry {
	id: string;
	kind: Kind;
	scope: Scope;
	title: string;
	body: string;
	created: string;
	updated: string;
	verify?: Verify;
	tags?: string[];
	/** Absolute path of the backing file. */
	file: string;
}

export interface EntryProblem {
	file: string;
	message: string;
}

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidId(id: string): boolean {
	return ID_RE.test(id) && id.length <= 80;
}

/** ISO 8601 seconds with the local UTC offset. */
export function nowIso(date: Date = new Date()): string {
	const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
	const offsetMin = -date.getTimezoneOffset();
	const sign = offsetMin >= 0 ? "+" : "-";
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		`T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
		`${sign}${pad(offsetMin / 60)}:${pad(offsetMin % 60)}`
	);
}

function needsQuote(value: string): boolean {
	return (
		value.length === 0 ||
		value !== value.trim() ||
		/[:#"'\n\r\t[\]{}&*!|>%@`,]/.test(value) ||
		/^[-?]/.test(value)
	);
}

function renderScalar(value: string): string {
	return needsQuote(value) ? JSON.stringify(value) : value;
}

function parseScalar(raw: string): string {
	const value = raw.trim();
	if (value.startsWith('"')) {
		try {
			return JSON.parse(value) as string;
		} catch {
			return value.slice(1, value.endsWith('"') ? -1 : undefined);
		}
	}
	if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
		return value.slice(1, -1).replace(/''/g, "'");
	}
	return value;
}

function parseInlineList(raw: string): string[] {
	const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
	if (inner.trim().length === 0) return [];
	const items: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (const ch of inner) {
		if (quote) {
			current += ch;
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === ",") {
			items.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	items.push(current);
	return items.map(parseScalar).filter((item) => item.length > 0);
}

export function serializeEntry(entry: Entry): string {
	const lines = ["---"];
	lines.push(`id: ${renderScalar(entry.id)}`);
	lines.push(`kind: ${entry.kind}`);
	lines.push(`title: ${renderScalar(entry.title)}`);
	lines.push(`created: ${renderScalar(entry.created)}`);
	lines.push(`updated: ${renderScalar(entry.updated)}`);
	if (entry.verify) {
		lines.push("verify:");
		lines.push(`  kind: ${entry.verify.kind}`);
		lines.push(`  ref: ${renderScalar(entry.verify.ref)}`);
		lines.push(`  expect: ${renderScalar(entry.verify.expect)}`);
	}
	if (entry.tags && entry.tags.length > 0) {
		lines.push(`tags: [${entry.tags.map(renderScalar).join(", ")}]`);
	}
	lines.push("---");
	lines.push("");
	lines.push(entry.body.trim());
	lines.push("");
	return lines.join("\n");
}

interface RawFrontmatter {
	fields: Map<string, string>;
	verify: Map<string, string>;
	body: string;
}

function splitFrontmatter(text: string): RawFrontmatter | undefined {
	const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) return undefined;
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return undefined;
	const head = normalized.slice(4, end + 1);
	const body = normalized.slice(end + 4).replace(/^\n/, "");

	const fields = new Map<string, string>();
	const verify = new Map<string, string>();
	let inVerify = false;
	for (const line of head.split("\n")) {
		if (line.trim().length === 0) continue;
		const indented = /^\s/.test(line);
		const match = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (!match) continue;
		const key = match[1] as string;
		const value = match[2] as string;
		if (indented && inVerify) {
			verify.set(key, value);
			continue;
		}
		inVerify = key === "verify" && value.trim().length === 0;
		if (!inVerify) fields.set(key, value);
	}
	return { fields, verify, body };
}

export interface ParseResult {
	entry?: Entry;
	problem?: EntryProblem;
}

/** Parse one memory file. `kind`/`scope` come from the store layout. */
export function parseEntry(file: string, text: string, kind: Kind, scope: Scope): ParseResult {
	const raw = splitFrontmatter(text);
	if (!raw) return { problem: { file, message: "missing or malformed frontmatter" } };

	const id = parseScalar(raw.fields.get("id") ?? "");
	const title = parseScalar(raw.fields.get("title") ?? "");
	const declaredKind = parseScalar(raw.fields.get("kind") ?? "");
	const created = parseScalar(raw.fields.get("created") ?? "");
	const updated = parseScalar(raw.fields.get("updated") ?? "");

	const basename = path.basename(file, ".md");
	if (!id) return { problem: { file, message: "missing id" } };
	if (id !== basename) return { problem: { file, message: `id "${id}" does not match filename "${basename}"` } };
	if (!isValidId(id)) return { problem: { file, message: `id "${id}" is not kebab-case` } };
	if (!title) return { problem: { file, message: "missing title" } };
	if (declaredKind !== kind) {
		return { problem: { file, message: `kind "${declaredKind}" does not match directory "${kind}"` } };
	}
	if (!created || !updated) return { problem: { file, message: "missing created/updated" } };

	let verify: Verify | undefined;
	if (raw.fields.has("verify") || raw.verify.size > 0) {
		const vKind = parseScalar(raw.verify.get("kind") ?? "") as VerifyKind;
		const ref = parseScalar(raw.verify.get("ref") ?? "");
		const expect = parseScalar(raw.verify.get("expect") ?? "");
		if (!VERIFY_KINDS.includes(vKind) || !ref || !expect) {
			return { problem: { file, message: "verify needs kind (file|command|url), ref and expect" } };
		}
		verify = { kind: vKind, ref, expect };
	}

	const tagsRaw = raw.fields.get("tags");
	const tags = tagsRaw === undefined ? undefined : parseInlineList(tagsRaw);

	return {
		entry: {
			id,
			kind,
			scope,
			title,
			body: raw.body.trim(),
			created,
			updated,
			...(verify ? { verify } : {}),
			...(tags && tags.length > 0 ? { tags } : {}),
			file,
		},
	};
}

export interface LoadedStore {
	entries: Entry[];
	problems: EntryProblem[];
	/** Ids present more than once inside this store (different kinds). */
	duplicates: Map<string, string[]>;
}

/** Read every memory file of a store directory. */
export function loadStoreEntries(storeDir: string, scope: Scope, kinds: readonly Kind[] = KINDS): LoadedStore {
	const entries: Entry[] = [];
	const problems: EntryProblem[] = [];
	const byId = new Map<string, string[]>();

	for (const kind of kinds) {
		const dir = kindDir(storeDir, kind);
		if (!existsSync(dir)) continue;
		let names: string[];
		try {
			names = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
		} catch (error) {
			problems.push({ file: dir, message: `cannot read directory: ${(error as Error).message}` });
			continue;
		}
		for (const name of names) {
			const file = path.join(dir, name);
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch (error) {
				problems.push({ file, message: `cannot read file: ${(error as Error).message}` });
				continue;
			}
			const result = parseEntry(file, text, kind, scope);
			if (result.problem) {
				problems.push(result.problem);
				continue;
			}
			const entry = result.entry as Entry;
			entries.push(entry);
			byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry.file]);
		}
	}

	const duplicates = new Map<string, string[]>();
	for (const [id, files] of byId) {
		if (files.length > 1) duplicates.set(id, files);
	}
	return { entries, problems, duplicates };
}

export function writeEntryFile(storeDir: string, entry: Entry): string {
	const file = entryPath(storeDir, entry.kind, entry.id);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, serializeEntry({ ...entry, file }), "utf8");
	return file;
}

export function deleteEntryFile(entry: Entry): void {
	rmSync(entry.file, { force: true });
}
