// Exercises the Markdown accepted from assistant replies without needing a browser or a gateway.
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./ui/markdown.ts";

describe("assistant transcript Markdown", () => {
	it("keeps paragraph line breaks and formats emphasis with inline code", () => {
		expect(parseMarkdown("## Summary\r\n\r\n**Use `a*b`** today.\r\nKeep *this* line.\r\n\r\nNext.")).toEqual([
			{ kind: "heading", level: 2, text: ["Summary"] },
			{
				kind: "paragraph",
				text: [
					{ kind: "strong", children: ["Use ", { kind: "code", text: "a*b" }] },
					" today.\nKeep ",
					{ kind: "em", children: ["this"] },
					" line.",
				],
			},
			{ kind: "paragraph", text: ["Next."] },
		]);
	});

	it("keeps adjacent lists, quotes and prose separate", () => {
		expect(parseMarkdown("Steps\n- Find it\n- Read it\n3. Try it\n4. Record it\n> One\n> two\nDone.")).toEqual([
			{ kind: "paragraph", text: ["Steps"] },
			{ kind: "list", start: null, items: [["Find it"], ["Read it"]] },
			{ kind: "list", start: 3, items: [["Try it"], ["Record it"]] },
			{ kind: "quote", text: ["One\ntwo"] },
			{ kind: "paragraph", text: ["Done."] },
		]);
	});

	it("does not format text inside a fence, even before the streamed closing fence arrives", () => {
		const code = "  # title\n```\n**bold**\n~~ ~~\n";
		const partial = `\`\`\`\`text\n${code}`;
		expect(parseMarkdown(partial)).toEqual([{ kind: "fence", text: code }]);
		expect(parseMarkdown(`${partial}\`\`\`\`\nDone.`)).toEqual([
			{ kind: "fence", text: code.slice(0, -1) },
			{ kind: "paragraph", text: ["Done."] },
		]);
	});

	it("does not interpret HTML, links, images or entities", () => {
		const text = '<b>Literal</b> &copy; ![diagram](https://example.invalid/picture.png) [reference](https://example.invalid/)';
		expect(parseMarkdown(text)).toEqual([{ kind: "paragraph", text: [text] }]);
	});

	it("keeps unfinished inline formatting literal", () => {
		expect(parseMarkdown("**not yet\n`still typing")).toEqual([{ kind: "paragraph", text: ["**not yet\n`still typing"] }]);
	});
});
