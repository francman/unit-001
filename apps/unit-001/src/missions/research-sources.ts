// Host-provided research sources and the one text extractor both fetching and verification use.
import { createHash } from "node:crypto";

/** One fetched source: its exact body is content-addressed, so a citation always names the bytes it quotes. */
export type ResearchSource = { url: string; contentType: string; body: string; sha256: string };

/** Where research reads from. This release has only fixtures; a live adapter is a later slice behind owner decisions. */
export type ResearchSources = {
	byUrl(url: string): ResearchSource | undefined;
	bySha256(sha256: string): ResearchSource | undefined;
};

/** Content types research accepts; anything else is refused as unreadable. */
export const RESEARCH_CONTENT_TYPES = ["text/html", "text/plain", "text/markdown", "application/json"];

/**
 * Builds the fixture adapter from host-provided entries, verifying each body against its declared SHA-256: a fixture
 * whose bytes do not match is refused at startup, so a citation can never point at silently changed text.
 */
export function fixtureSources(entries: ResearchSource[]): ResearchSources {
	for (const entry of entries) {
		if (sha256Of(entry.body) !== entry.sha256) throw new Error(`Research fixture ${entry.url} does not match its SHA-256.`);
		if (!RESEARCH_CONTENT_TYPES.includes(entry.contentType))
			throw new Error(`Research fixture ${entry.url} has an unreadable content type.`);
	}
	return {
		byUrl: (url) => entries.find((entry) => entry.url === url),
		bySha256: (sha256) => entries.find((entry) => entry.sha256 === sha256),
	};
}

/** No sources at all: the production default until an owner decision enables more. */
export const NO_RESEARCH_SOURCES: ResearchSources = { byUrl: () => undefined, bySha256: () => undefined };

/** The SHA-256 of a body's UTF-8 bytes, as research stores and cites it. */
export function sha256Of(body: string): string {
	return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Deterministic readable text: drops script and style blocks and tags, decodes the common entities and collapses
 * whitespace. The verifier uses the same function, so a quote is checked against exactly what the child was shown.
 */
export function extractText(source: ResearchSource): string {
	const text =
		source.contentType === "text/html"
			? source.body
					.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
					.replace(/<[^>]+>/g, " ")
					.replace(/&nbsp;/g, " ")
					.replace(/&lt;/g, "<")
					.replace(/&gt;/g, ">")
					.replace(/&quot;/g, '"')
					.replace(/&#39;/g, "'")
					.replace(/&amp;/g, "&")
			: source.body;
	return normalizeWhitespace(text);
}

/** Collapses every whitespace run to one space and trims, for text and quotes alike. */
export function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
