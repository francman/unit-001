// Persists the session admission barrier used by controlled release maintenance.

import { lstat, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defineDoc } from "@earendil-works/pi-durable";

export type MaintenanceState =
	| { protocol: 1; state: "open"; operationId: null }
	| { protocol: 1; state: "held"; operationId: string };

export type MaintenanceResult =
	| { type: "maintenance"; protocol: 1; state: "open"; operationId: null }
	| { type: "maintenance"; protocol: 1; state: "held"; operationId: string; result: "drained" | "deferred" };

/** Session-wide durable admission state; a restart cannot silently release a hold. */
export const MaintenanceDoc = defineDoc<{ current: MaintenanceState }>({
	kind: "unit.maintenance",
	version: 1,
	scope: "session",
	initial: () => ({ current: { protocol: 1, state: "open", operationId: null } }),
	checkpointWhen: () => true,
});

/** Validates the local operator's bounded maintenance identity. */
export function validateOperationId(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 200)
		throw new Error("Maintenance operation ID must contain 1 to 200 characters.");
}

/** Requires managed maintenance controls to match the administrator's durable update decision. */
export async function authorizeManagedMaintenance(
	id: string,
	version: string,
	operationId: string,
	action: "enter" | "release",
): Promise<void> {
	if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid managed maintenance identity.");
	const directory = `/etc/unit-001/agents/${id}`;
	const journal: unknown = JSON.parse(await readProtectedFile(`${directory}/update/journal.json`));
	const installation: unknown = JSON.parse(await readProtectedFile(`${directory}/installation.json`));
	if (
		typeof installation !== "object" ||
		installation === null ||
		!("id" in installation) ||
		installation.id !== id ||
		!("releaseVersion" in installation) ||
		installation.releaseVersion !== version ||
		!("desiredState" in installation) ||
		installation.desiredState !== "running"
	)
		throw new Error("Managed maintenance does not match running operator intent.");
	validateMaintenanceAuthorization(journal, id, version, operationId, action);
}

/** Validates the privileged journal boundary without allowing candidate checks to release execution. */
export function validateMaintenanceAuthorization(
	journal: unknown,
	id: string,
	version: string,
	operationId: string,
	action: "enter" | "release",
): void {
	if (
		typeof journal !== "object" ||
		journal === null ||
		!("schemaVersion" in journal) ||
		journal.schemaVersion !== 1 ||
		!("id" in journal) ||
		journal.id !== id ||
		!("operationId" in journal) ||
		journal.operationId !== operationId ||
		!("phase" in journal) ||
		!("candidateVersion" in journal) ||
		!("previousRecord" in journal) ||
		typeof journal.previousRecord !== "object" ||
		journal.previousRecord === null ||
		!("id" in journal.previousRecord) ||
		journal.previousRecord.id !== id ||
		!("releaseVersion" in journal.previousRecord)
	)
		throw new Error("Managed maintenance operation is not authorized by its update journal.");
	const previous = journal.previousRecord.releaseVersion === version;
	const candidate = journal.candidateVersion === version;
	const allowed =
		action === "release"
			? (journal.phase === "committed" && candidate) ||
				(journal.phase === "restored" && previous) ||
				(journal.phase === "complete" && (previous || candidate))
			: (journal.phase === "holding" && previous) ||
				(["backed-up", "candidate", "committed"].includes(String(journal.phase)) && candidate) ||
				(journal.phase === "restored" && previous);
	if (!allowed) throw new Error("Update phase does not authorize this maintenance control.");
}

async function readProtectedFile(path: string): Promise<string> {
	const file = await lstat(path);
	if (!file.isFile() || file.uid !== 0 || (file.mode & 0o022) !== 0 || file.size > 65536)
		throw new Error("Untrusted administrator maintenance metadata.");
	for (let parent = dirname(path); parent !== "/"; parent = dirname(parent)) {
		const info = await lstat(parent);
		if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0)
			throw new Error("Untrusted administrator maintenance directory.");
	}
	return readFile(path, "utf8");
}
