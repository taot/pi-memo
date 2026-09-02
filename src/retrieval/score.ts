/**
 * Ranking on top of raw BM25:
 * `score = bm25 * kindBoost * scopeBoost * recencyBoost * hitBoost`.
 */
import type { Entry } from "../store/entry.ts";
import type { Kind } from "../store/paths.ts";
import type { UsageRecord } from "../store/usage.ts";

const KIND_MATCH_BOOST = 2;
const PROJECT_BOOST = 1.15;
const RECENCY_MAX_BOOST = 0.3;
const RECENCY_HALFLIFE_DAYS = 30;
const HIT_BOOST_WEIGHT = 0.1;

export function kindBoost(entry: Entry, requested?: Kind): number {
	if (!requested) return 1;
	return entry.kind === requested ? KIND_MATCH_BOOST : 1;
}

export function scopeBoost(entry: Entry): number {
	return entry.scope === "project" ? PROJECT_BOOST : 1;
}

export function recencyBoost(entry: Entry, now: number = Date.now()): number {
	const updated = Date.parse(entry.updated);
	if (Number.isNaN(updated)) return 1;
	const ageDays = Math.max(0, (now - updated) / 86_400_000);
	return 1 + RECENCY_MAX_BOOST * Math.exp(-ageDays / RECENCY_HALFLIFE_DAYS);
}

export function hitBoost(usage: UsageRecord | undefined): number {
	const hits = usage?.hits ?? 0;
	return 1 + HIT_BOOST_WEIGHT * Math.log(1 + hits);
}

export function finalScore(
	base: number,
	entry: Entry,
	options: { kind?: Kind; usage?: UsageRecord; now?: number },
): number {
	return (
		base *
		kindBoost(entry, options.kind) *
		scopeBoost(entry) *
		recencyBoost(entry, options.now) *
		hitBoost(options.usage)
	);
}
