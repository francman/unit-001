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
	request(request: ServiceRequest, signal: AbortSignal): Promise<ServiceResponse>;
	watch(listener: (event: ServiceClientEvent) => void, signal: AbortSignal): Promise<void>;
}

/** Wraps the existing local socket protocol without opening storage or changing ownership. */
export function localServiceClient(endpoint: string): ServiceClient {
	return {
		session: basename(endpoint, ".sock"),
		request: (request, signal) => requestService(endpoint, request, signal),
		watch: (listener, signal) => watchService(endpoint, (view) => listener({ type: "view", view }), signal),
	};
}
