// Shares the existing owner protocol between local and authenticated remote terminal clients.
import { basename } from "node:path";
import {
	requestService,
	type ServiceRequest,
	type ServiceResponse,
	type ServiceView,
	watchService,
} from "./service.ts";

export type ServiceClientEvent =
	| { readonly type: "view"; readonly view: ServiceView }
	| { readonly type: "connecting"; readonly message: string };

export interface ServiceClient {
	readonly session: string;
	readonly ownerSession: string;
	request(request: ServiceRequest, signal: AbortSignal): Promise<ServiceResponse>;
	watch(listener: (event: ServiceClientEvent) => void, signal: AbortSignal): Promise<void>;
}

/** Wraps the existing local socket protocol without opening storage or changing ownership. */
export function localServiceClient(endpoint: string): ServiceClient {
	return {
		session: basename(endpoint, ".sock"),
		ownerSession: basename(endpoint, ".sock"),
		request: (request, signal) => requestService(endpoint, request, signal),
		async watch(listener, signal) {
			if (signal.aborted) return;
			const startup = new AbortController();
			let deadline: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
				startup.abort(new Error("Service did not provide initial state within 5 seconds"));
			}, 5_000);
			try {
				await watchService(
					endpoint,
					(view) => {
						if (deadline !== undefined) {
							clearTimeout(deadline);
							deadline = undefined;
						}
						listener({ type: "view", view });
					},
					AbortSignal.any([signal, startup.signal]),
				);
				// The socket watch resolves on abort; only the startup deadline is a failure.
				startup.signal.throwIfAborted();
			} finally {
				clearTimeout(deadline);
			}
		},
	};
}
