/**
 * One tokenizer for prose, Chinese and code identifiers.
 *
 * 1. NFKC + lowercase.
 * 2. Chinese runs go through jieba (`cutForSearch`) when available, otherwise a
 *    unigram + bigram fallback that keeps recall usable without a native build.
 * 3. Code identifiers keep the full token and its parts
 *    (`tokio::block_in_place` -> the whole token plus tokio/block_in_place/block/in/place).
 * 4. Whitespace and punctuation are dropped.
 */
import { createRequire } from "node:module";

export const TOKENIZER_VERSION = "1";

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/;
const CJK_RUN = /[㐀-䶿一-鿿豈-﫿぀-ヿ]+/g;
/** A raw token: letters, digits and the punctuation that binds identifiers. */
const RAW_TOKEN = /[\p{L}\p{N}][\p{L}\p{N}_.:/+#$@-]*/gu;

type Jieba = { cutForSearch(text: string, hmm?: boolean): string[] };

let jiebaLoaded = false;
let jieba: Jieba | undefined;

function loadJieba(): Jieba | undefined {
	if (jiebaLoaded) return jieba;
	jiebaLoaded = true;
	try {
		const require = createRequire(import.meta.url);
		jieba = require("nodejieba") as Jieba;
	} catch {
		jieba = undefined;
	}
	return jieba;
}

/** True when jieba is available; the fallback segmenter is used otherwise. */
export function hasJieba(): boolean {
	return loadJieba() !== undefined;
}

function cutChinese(run: string): string[] {
	const engine = loadJieba();
	if (engine) {
		try {
			return engine.cutForSearch(run).filter((token) => token.trim().length > 0);
		} catch {
			/* fall through to the built-in segmenter */
		}
	}
	const out: string[] = [];
	const chars = [...run];
	for (let i = 0; i < chars.length; i++) {
		out.push(chars[i] as string);
		if (i + 1 < chars.length) out.push(`${chars[i]}${chars[i + 1]}`);
	}
	return out;
}

function splitIdentifier(token: string): string[] {
	const out: string[] = [];
	// Level 1: namespace/path separators.
	for (const part of token.split(/[.:/+#$@]+/)) {
		if (part.length === 0) continue;
		out.push(part);
		// Level 2: snake_case, kebab-case and camelCase.
		const pieces = part
			.split(/[_-]+/)
			.flatMap((piece) => piece.split(/(?<=\p{Ll}|\p{N})(?=\p{Lu})/gu))
			.filter((piece) => piece.length > 0);
		if (pieces.length > 1) out.push(...pieces);
	}
	return out;
}

export function tokenize(text: string): string[] {
	if (!text) return [];
	// Case is kept until the end so camelCase boundaries survive splitting.
	const normalized = text.normalize("NFKC");
	const tokens: string[] = [];

	for (const match of normalized.matchAll(RAW_TOKEN)) {
		const raw = (match[0] as string).replace(/[.:/+#$@-]+$/, "");
		if (raw.length === 0) continue;

		if (CJK.test(raw)) {
			// Mixed runs: segment the Chinese parts, keep the rest as identifiers.
			for (const run of raw.match(CJK_RUN) ?? []) tokens.push(...cutChinese(run));
			for (const rest of raw.split(CJK_RUN)) {
				if (rest.length === 0) continue;
				tokens.push(rest, ...splitIdentifier(rest));
			}
			continue;
		}

		tokens.push(raw);
		const parts = splitIdentifier(raw);
		if (parts.length > 1 || (parts[0] !== undefined && parts[0] !== raw)) tokens.push(...parts);
	}

	return tokens.filter((token) => token.length > 0).map((token) => token.toLowerCase());
}
