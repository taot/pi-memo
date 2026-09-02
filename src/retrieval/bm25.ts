/**
 * Field-weighted BM25 over tokenized memory entries.
 *
 * Weights follow the design: `title*3 + body + tags*2`.
 */
export const FIELD_WEIGHTS = { title: 3, body: 1, tags: 2 } as const;

const K1 = 1.2;
const B = 0.75;

export interface TokenizedDoc {
	id: string;
	title: string[];
	body: string[];
	tags: string[];
}

interface IndexedDoc {
	id: string;
	tf: Map<string, number>;
	length: number;
}

export interface Bm25Index {
	docs: IndexedDoc[];
	df: Map<string, number>;
	avgLength: number;
}

function addField(tf: Map<string, number>, tokens: string[], weight: number): number {
	for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + weight);
	return tokens.length * weight;
}

export function buildIndex(docs: TokenizedDoc[]): Bm25Index {
	const indexed: IndexedDoc[] = [];
	const df = new Map<string, number>();
	let totalLength = 0;

	for (const doc of docs) {
		const tf = new Map<string, number>();
		let length = 0;
		length += addField(tf, doc.title, FIELD_WEIGHTS.title);
		length += addField(tf, doc.body, FIELD_WEIGHTS.body);
		length += addField(tf, doc.tags, FIELD_WEIGHTS.tags);
		for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
		indexed.push({ id: doc.id, tf, length });
		totalLength += length;
	}

	return {
		docs: indexed,
		df,
		avgLength: indexed.length > 0 ? totalLength / indexed.length : 0,
	};
}

/** Raw BM25 score per document id. Documents with no match are omitted. */
export function scoreQuery(index: Bm25Index, queryTokens: string[]): Map<string, number> {
	const scores = new Map<string, number>();
	if (index.docs.length === 0) return scores;

	const terms = [...new Set(queryTokens)];
	const total = index.docs.length;

	for (const doc of index.docs) {
		let score = 0;
		for (const term of terms) {
			const tf = doc.tf.get(term);
			if (!tf) continue;
			const df = index.df.get(term) ?? 0;
			const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
			const norm = index.avgLength > 0 ? doc.length / index.avgLength : 1;
			score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * norm)));
		}
		if (score > 0) scores.set(doc.id, score);
	}
	return scores;
}
