// Reads a stored mission document only through its validator: Durable returns same-version fields as stored.
import type { Context } from "@earendil-works/chord/context";
import type { Harness, JsonObject, SessionDocToken, Tx } from "@earendil-works/pi-durable";

/**
 * The validator's result for a stored document read inside the caller's transaction; undefined when the document
 * cannot be read (for example a newer version) or fails validation. The cause is dropped: every caller treats an
 * unreadable record as closed, never as an error to report.
 */
export async function storedDoc<T extends JsonObject, R>(
	tx: Tx,
	doc: SessionDocToken<T>,
	check: (value: unknown) => R,
): Promise<R | undefined> {
	try {
		return check(await tx.doc(doc));
	} catch {
		return undefined;
	}
}

/** A stored document's snapshot after full validation; throws the validator's error, with its cause, on a bad record. */
export async function readDoc<T extends JsonObject>(
	harness: Harness,
	context: Context,
	doc: SessionDocToken<T>,
	check: (value: unknown) => unknown,
): Promise<Readonly<T> | undefined> {
	const saved = await harness.snapshot(doc, context);
	if (saved !== undefined) check(saved);
	return saved;
}
