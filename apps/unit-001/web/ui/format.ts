// Formats numbers, times and owner field names as short words for the interface.

/** Owner field names arrive as snake_case, kebab-case or camelCase; shows them as plain lowercase words. */
export function humanize(value: string): string {
	return value
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replaceAll("_", " ")
		.replaceAll("-", " ")
		.toLowerCase();
}

/** A length of time at the scale that matters: "under 1 min", "45 min", "5 hours", "3 days". */
export function duration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "under 1 min";
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
	return `${Math.floor(hours / 24)} days`;
}

/** A local date and time without seconds ("Nov 21, 5:14 AM"); the year only when it is not this year. */
export function dateTime(ms: number): string {
	const date = new Date(ms);
	const sameYear = date.getFullYear() === new Date().getFullYear();
	return date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		...(sameYear ? {} : { year: "numeric" }),
		hour: "numeric",
		minute: "2-digit",
	});
}

/** A clock time without seconds ("5:14 AM"). */
export function clock(ms: number): string {
	return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** How long ago a time was, coarse: "just now", "12 min ago", "3 h ago", "2 days ago". */
export function ago(ms: number, now = Date.now()): string {
	const minutes = Math.floor((now - ms) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.floor(hours / 24);
	return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** How far ahead a time is, coarse: "now", "in 58 min", "in 3 hours". */
export function until(ms: number, now = Date.now()): string {
	const ahead = ms - now;
	return ahead < 60_000 ? "now" : `in ${duration(ahead)}`;
}

/** A cost estimate in dollars; amounts under a cent keep four decimals so they never read as zero. */
export function money(usd: number): string {
	return `$${usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

/** A count with thousands separators ("24,700"). */
export function count(value: number): string {
	return value.toLocaleString();
}

/** A count and the right noun: plural(1, "memory", "memories") is "1 memory". */
export function plural(value: number, one: string, many: string): string {
	return `${count(value)} ${value === 1 ? one : many}`;
}
