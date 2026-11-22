// Renders a local Markdown subset: no HTML parsing, links, images or other URL-bearing elements.
import { el } from "./dom.ts";

type Span = string | { kind: "code"; text: string } | { kind: "em" | "strong"; children: Span[] };
type Block =
	| { kind: "paragraph" | "quote"; text: Span[] }
	| { kind: "heading"; level: number; text: Span[] }
	| { kind: "list"; start: number | null; items: Span[][] }
	| { kind: "fence"; text: string };

const headings = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

/** Builds assistant text from fixed DOM elements. The optional caret follows the last rendered text. */
export function markdown(source: string, caret?: HTMLElement): HTMLElement {
	const body = el("div", "min-w-0 [overflow-wrap:anywhere] [&>*+*]:mt-3");
	let end: HTMLElement | undefined;
	for (const block of parseMarkdown(source)) {
		switch (block.kind) {
			case "paragraph":
			case "quote":
				end = el(
					block.kind === "quote" ? "blockquote" : "p",
					block.kind === "quote" ? "border-l-2 border-line pl-3 whitespace-pre-wrap text-fg-2" : "whitespace-pre-wrap",
				);
				appendSpans(end, block.text);
				body.append(end);
				break;
			case "heading":
				end = el(headings[block.level - 1], block.level <= 2 ? "text-md font-semibold" : "font-semibold");
				appendSpans(end, block.text);
				body.append(end);
				break;
			case "list": {
				const list =
					block.start === null ? el("ul", "list-disc space-y-1 pl-6") : el("ol", "list-decimal space-y-1 pl-6");
				if (list instanceof HTMLOListElement && block.start !== null && block.start !== 1) list.start = block.start;
				for (const item of block.items) {
					end = el("li", "whitespace-pre-wrap");
					appendSpans(end, item);
					list.append(end);
				}
				body.append(list);
				break;
			}
			case "fence":
				end = el("code", "font-mono", block.text);
				body.append(el("pre", "max-w-full overflow-x-auto rounded-md border border-stroke-3 bg-card p-3 text-base [overflow-wrap:normal]", end));
				break;
		}
	}
	if (caret) {
		if (end) end.append(caret);
		else body.append(caret);
	}
	return body;
}

const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const heading = /^ {0,3}(#{1,6})[ \t]+(\S.*)$/;
const listItem = /^ {0,3}(?:[-+*]|(\d{1,9})[.)])[ \t]+(\S.*)$/;
const quote = /^ {0,3}>[ \t]?(.*)$/;

/** Parses shallow blocks and asterisk emphasis / single-backtick code spans; unsupported markup stays text. */
export function parseMarkdown(source: string): Block[] {
	const lines = source.split(/\r\n?|\n/);
	const blocks: Block[] = [];
	for (let i = 0; i < lines.length;) {
		const line = lines[i++];
		if (!line.trim()) continue;

		const opening = fence.exec(line);
		if (opening && (opening[1][0] === "~" || !opening[2].includes("`"))) {
			const start = i;
			while (i < lines.length) {
				const closing = fence.exec(lines[i]);
				if (closing && closing[1][0] === opening[1][0] && closing[1].length >= opening[1].length && !closing[2].trim()) break;
				i++;
			}
			blocks.push({ kind: "fence", text: lines.slice(start, i).join("\n") });
			i++;
			continue;
		}

		const title = heading.exec(line);
		if (title) {
			blocks.push({ kind: "heading", level: title[1].length, text: parseSpans(title[2].replace(/[ \t]+#+[ \t]*$/, "")) });
			continue;
		}

		const firstItem = listItem.exec(line);
		if (firstItem) {
			const start = firstItem[1] === undefined ? null : Number(firstItem[1]);
			const items = [parseSpans(firstItem[2])];
			while (i < lines.length) {
				const next = listItem.exec(lines[i]);
				if (!next || (next[1] === undefined) !== (start === null)) break;
				items.push(parseSpans(next[2]));
				i++;
			}
			blocks.push({ kind: "list", start, items });
			continue;
		}

		const firstQuote = quote.exec(line);
		if (firstQuote) {
			const quoted = [firstQuote[1]];
			while (i < lines.length) {
				const next = quote.exec(lines[i]);
				if (!next) break;
				quoted.push(next[1]);
				i++;
			}
			blocks.push({ kind: "quote", text: parseSpans(quoted.join("\n")) });
			continue;
		}

		const start = i - 1;
		while (i < lines.length && lines[i].trim() && !heading.test(lines[i]) && !listItem.test(lines[i]) && !quote.test(lines[i])) {
			const next = fence.exec(lines[i]);
			if (next && (next[1][0] === "~" || !next[2].includes("`"))) break;
			i++;
		}
		blocks.push({ kind: "paragraph", text: parseSpans(lines.slice(start, i).join("\n")) });
	}
	return blocks;
}

const inlineCode = /(?<!`)`([^`\n]+)`(?!`)/g;
// An emphasis span can contain inline code, but not another emphasis span or a line break.
const inline = /(?<!`)`([^`\n]+)`(?!`)|(?<!\*)(\*{1,2})(?!\*)(?=\S)((?:[^*`\n]|`[^`\n]+`)+?)(?<!\s)\2(?!\*)/g;

function parseSpans(text: string, syntax = inline): Span[] {
	const spans: Span[] = [];
	let from = 0;
	for (const match of text.matchAll(syntax)) {
		const [, code, marker, content] = match;
		if (from < match.index) spans.push(text.slice(from, match.index));
		spans.push(code !== undefined ? { kind: "code", text: code } : { kind: marker === "**" ? "strong" : "em", children: parseSpans(content, inlineCode) });
		from = match.index + match[0].length;
	}
	if (from < text.length) spans.push(text.slice(from));
	return spans;
}

function appendSpans(node: HTMLElement, spans: readonly Span[]): void {
	for (const span of spans) {
		if (typeof span === "string") node.append(span);
		else if (span.kind === "code") node.append(el("code", "rounded-xs bg-fill px-1 font-mono", span.text));
		else {
			const emphasis = el(span.kind);
			appendSpans(emphasis, span.children);
			node.append(emphasis);
		}
	}
}
