import { describe, expect, it } from "vitest";
import { type Entry, isValidId, nowIso, parseEntry, serializeEntry } from "../src/store/entry.ts";

const base: Entry = {
	id: "wayland-no-window-positioning",
	kind: "env",
	scope: "global",
	title: "Wayland 不暴露窗口坐标设定，KDE 下 set_outer_position 不生效",
	body: "Wayland 协议没有把窗口放到 (x, y) 的请求。",
	created: "2026-08-31T14:22:07-04:00",
	updated: "2026-08-31T14:22:07-04:00",
	verify: { kind: "url", ref: "https://wayland.freedesktop.org/docs/html/", expect: "xdg-shell" },
	tags: ["kde", "wayland"],
	file: "/tmp/wayland-no-window-positioning.md",
};

describe("entry serialization", () => {
	it("round-trips every field", () => {
		const text = serializeEntry(base);
		const parsed = parseEntry(base.file, text, "env", "global");
		expect(parsed.problem).toBeUndefined();
		expect(parsed.entry).toMatchObject({
			id: base.id,
			title: base.title,
			body: base.body,
			verify: base.verify,
			tags: base.tags,
		});
	});

	it("rejects a filename that does not match the id", () => {
		const text = serializeEntry(base);
		const parsed = parseEntry("/tmp/other-name.md", text, "env", "global");
		expect(parsed.problem?.message).toMatch(/does not match filename/);
	});

	it("rejects a kind that does not match its directory", () => {
		const text = serializeEntry(base);
		const parsed = parseEntry(base.file, text, "exp", "global");
		expect(parsed.problem?.message).toMatch(/does not match directory/);
	});

	it("rejects an incomplete verify block", () => {
		const text = serializeEntry(base).replace("  expect: xdg-shell\n", "");
		const parsed = parseEntry(base.file, text, "env", "global");
		expect(parsed.problem?.message).toMatch(/verify needs/);
	});

	it("reports missing frontmatter", () => {
		const parsed = parseEntry(base.file, "just text", "env", "global");
		expect(parsed.problem?.message).toMatch(/frontmatter/);
	});
});

describe("ids and timestamps", () => {
	it("accepts kebab-case only", () => {
		expect(isValidId("build-and-check")).toBe(true);
		expect(isValidId("Build_And_Check")).toBe(false);
		expect(isValidId("trailing-")).toBe(false);
	});

	it("writes a local ISO timestamp with an offset", () => {
		expect(nowIso(new Date())).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
	});
});
