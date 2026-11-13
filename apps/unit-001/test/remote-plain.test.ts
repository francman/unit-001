// #55: A recoverable first-view disconnect must not trip the plain client's local startup deadline.
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { runServiceAttach } from "../src/attach.ts";
import type { ServiceView } from "../src/service.ts";
import type { ServiceClient } from "../src/service-client.ts";

it("#55 keeps plain attachment alive while the remote retries its first view", async () => {
	vi.useFakeTimers();
	const input = new PassThrough();
	const errors: string[] = [];
	const ready = Promise.withResolvers<void>();
	const view: ServiceView = {
		pid: 42,
		version: "0.0.7",
		name: "agent",
		installationId: null,
		model: null,
		usage: null,
		entries: [],
		busy: false,
		text: "",
		textTruncated: false,
		tools: [],
		historyTruncated: false,
	};
	const client: ServiceClient = {
		session: "default@remote",
		ownerSession: "default",
		async request(request, signal) {
			if (request.type === "memory") {
				input.end("/detach\n");
				signal.throwIfAborted();
				return new Promise((_, reject) =>
					signal.addEventListener("abort", () => reject(new Error("Detached")), { once: true }),
				);
			}
			return { type: "cancelled" };
		},
		async watch(listener, signal) {
			listener({ type: "connecting", message: "Reconnecting view" });
			await ready.promise;
			listener({ type: "view", view });
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		},
	};
	const abort = new AbortController();
	const running = runServiceAttach(
		client,
		{
			input,
			out() {},
			err(text) {
				errors.push(text);
			},
		},
		abort.signal,
	);
	try {
		await vi.advanceTimersByTimeAsync(5_500);
		expect(errors.join("")).not.toContain("did not provide initial state");
		ready.resolve();
		await Promise.resolve();
		input.write("/memory remember keep this\n");
		expect(await running).toBe(0);
		expect(errors.join("")).toContain("Attached to agent; session default@remote");
		// #55: detaching while a memory mutation is pending must leave its retry ID in scrollback.
		expect(errors.join("")).toMatch(/Submitting memory request [0-9a-f-]{36}; retain this ID/);
	} finally {
		abort.abort();
		ready.resolve();
		input.destroy();
		vi.useRealTimers();
	}
});
