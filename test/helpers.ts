import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Mneme } from "../src/mneme.ts";

export interface Sandbox {
	root: string;
	globalDir: string;
	projectRoot: string;
	projectDir: string;
	load(): Mneme;
}

/** A throwaway global store plus a fake repo with its own project store. */
export function createSandbox(): Sandbox {
	const root = mkdtempSync(path.join(tmpdir(), "mneme-test-"));
	const globalDir = path.join(root, "global", "mneme");
	const projectRoot = path.join(root, "repo");
	mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
	mkdirSync(globalDir, { recursive: true });
	process.env.PI_MNEME_HOME = globalDir;

	return {
		root,
		globalDir,
		projectRoot,
		projectDir: path.join(projectRoot, ".pi", "mneme"),
		load: () => Mneme.load(projectRoot),
	};
}

/** Drop a memory file into a store without going through the tools. */
export function seedEntry(
	storeDir: string,
	kind: "user" | "env" | "exp",
	id: string,
	frontmatterAndBody: string,
): string {
	const dir = path.join(storeDir, kind);
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${id}.md`);
	writeFileSync(file, frontmatterAndBody, "utf8");
	return file;
}

export function memoryFile(options: {
	id: string;
	kind: "user" | "env" | "exp";
	title: string;
	body: string;
	created?: string;
	updated?: string;
}): string {
	const stamp = options.created ?? "2026-01-01T00:00:00+00:00";
	return [
		"---",
		`id: ${options.id}`,
		`kind: ${options.kind}`,
		`title: ${JSON.stringify(options.title)}`,
		`created: ${stamp}`,
		`updated: ${options.updated ?? stamp}`,
		"---",
		"",
		options.body,
		"",
	].join("\n");
}
