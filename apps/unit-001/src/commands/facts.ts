// Recognizes explicit OS fact questions without probabilistic intent inference.
import { defineEntry } from "@earendil-works/pi-durable";
import type { OperatingSystemFacts } from "../introspection/os.ts";

/** Host-authored display evidence; these entries never claim model output or token usage. */
export const HostFactEntry = defineEntry<{
	role: "user" | "assistant";
	text: string;
	input: string;
	facts: OperatingSystemFacts | null;
}>("unit.host.fact");

/** Matches only known OS questions; other conversation input follows the normal agent path. */
export function isOperatingSystemQuestion(input: string): boolean {
	const text = input
		.trim()
		.toLowerCase()
		.replace(/[?!.]+$/, "")
		.replace(/\s+/g, " ");
	return [
		"what os are you running",
		"what operating system are you running",
		"which os are you running",
		"which operating system are you running",
		"what os do you run on",
		"what operating system do you run on",
		"what is your operating system",
		"what is your os",
		"what os is this",
		"what operating system is this",
		"inspect os",
		"inspect operating system",
		"/inspect os",
	].includes(text);
}
