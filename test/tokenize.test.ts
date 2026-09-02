import { describe, expect, it } from "vitest";
import { tokenize } from "../src/retrieval/tokenize.ts";

describe("tokenize", () => {
	it("keeps the full code identifier and its parts", () => {
		const tokens = tokenize("tokio::block_in_place");
		expect(tokens).toContain("tokio::block_in_place");
		expect(tokens).toEqual(expect.arrayContaining(["tokio", "block_in_place", "block", "in", "place"]));
	});

	it("splits camelCase", () => {
		expect(tokenize("setOuterPosition")).toEqual(expect.arrayContaining(["setouterposition", "set", "outer", "position"]));
	});

	it("segments Chinese into words", () => {
		const tokens = tokenize("Wayland 不暴露窗口坐标设定");
		expect(tokens).toContain("wayland");
		expect(tokens).toContain("窗口");
		expect(tokens).toContain("坐标");
	});

	it("drops punctuation and whitespace", () => {
		expect(tokenize("  ...  ")).toEqual([]);
	});

	it("normalizes case and width", () => {
		expect(tokenize("ＫＤＥ")).toContain("kde");
	});
});
