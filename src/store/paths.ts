/**
 * Store locations.
 *
 * Global memory lives in `~/.pi/memo`, project memory in `<repo>/.pi/memo`.
 * `PI_MEMO_HOME` overrides the global store (used by tests).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export type Scope = "global" | "project";
export type Kind = "user" | "env" | "exp";

export const KINDS: readonly Kind[] = ["user", "env", "exp"] as const;

/** Kinds a scope may hold. `project x user` is illegal by design. */
export const KINDS_BY_SCOPE: Record<Scope, readonly Kind[]> = {
	global: ["user", "env", "exp"],
	project: ["env", "exp"],
};

export function isKindAllowed(scope: Scope, kind: Kind): boolean {
	return KINDS_BY_SCOPE[scope].includes(kind);
}

export function globalStoreDir(): string {
	const override = process.env.PI_MEMO_HOME;
	if (override && override.trim().length > 0) return path.resolve(override);
	return path.join(homedir(), ".pi", "memo");
}

/** Walk up from `cwd` looking for a repo root. Falls back to `cwd`. */
export function findProjectRoot(cwd: string): string {
	let dir = path.resolve(cwd);
	for (;;) {
		if (existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return path.resolve(cwd);
		dir = parent;
	}
}

export function projectStoreDir(cwd: string): string {
	return path.join(findProjectRoot(cwd), ".pi", "memo");
}

export function kindDir(storeDir: string, kind: Kind): string {
	return path.join(storeDir, kind);
}

export function entryPath(storeDir: string, kind: Kind, id: string): string {
	return path.join(storeDir, kind, `${id}.md`);
}

export function indexFilePath(storeDir: string): string {
	return path.join(storeDir, "MEMORY.md");
}

export function cacheDir(storeDir: string): string {
	return path.join(storeDir, ".cache");
}

export function localDir(storeDir: string): string {
	return path.join(storeDir, ".local");
}

export function usageFilePath(storeDir: string): string {
	return path.join(localDir(storeDir), "usage.json");
}

export function reportFilePath(storeDir: string): string {
	return path.join(storeDir, "GC-REPORT.md");
}
