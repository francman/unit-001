// #14: Runs the actual provider-free managed owner in a disposable Linux permission fixture.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Agent } from "../../dist/agent.js";
import { operatorEndpoint, runService, serviceEndpoint } from "../../dist/service.js";

globalThis.fetch = async () => {
	throw new Error("Network is forbidden in managed mission acceptance");
};
const id = "11111111-1111-4111-8111-111111111111";
const state = `/var/lib/unit-001/agents/${id}`;
const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown.abort());
const agent = await Agent.open(
	{
		storage: await openNodeSqliteStorage(`${state}/default.sqlite`),
		models: createModels(),
		model: null,
		name: "bob",
		cwd: `${state}/workspace`,
		mission: { kind: "managed", installationId: id, session: "default" },
	},
	context,
);
try {
	await runService(
		agent,
		serviceEndpoint(state, "default", "linux"),
		"mission-fixture",
		(text) => process.stdout.write(text),
		shutdown.signal,
		id,
		operatorEndpoint(id, "default"),
	);
} finally {
	await agent.close(context);
}
