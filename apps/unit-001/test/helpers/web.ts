// Setup shared by the web gateway tests: a free loopback port and the headers of a browser mutation request.
import { once } from "node:events";
import { createServer } from "node:net";

/** Reserves an ephemeral loopback port and releases it, so a gateway can be given its exact origin before it listens. */
export async function freePort(): Promise<number> {
	const reservation = createServer().listen(0, "127.0.0.1");
	await once(reservation, "listening");
	const address = reservation.address();
	if (address === null || typeof address === "string") throw new Error("Expected a TCP address.");
	await new Promise<void>((resolve) => reservation.close(() => resolve()));
	return address.port;
}

/** The headers the page sends with a mutation: its own origin, JSON, and the session's CSRF token. */
export function sessionHeaders(origin: string, csrfToken: string) {
	return { Origin: origin, "Content-Type": "application/json", "X-Unit-CSRF": csrfToken };
}
