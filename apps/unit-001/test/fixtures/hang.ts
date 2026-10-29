// Child process for crash.test.ts: submits a prompt, enters a model request that never completes, and reports it.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Agent } from "../../src/agent.ts";

const [file, cwd] = process.argv.slice(2);
if (file === undefined || cwd === undefined) throw new Error("usage: hang.ts <session file> <cwd>");

const faux = fauxProvider();
faux.setResponses([
	() => {
		process.stdout.write("REQUESTED\n");
		return new Promise(() => {});
	},
]);
const models = createModels();
models.setProvider(faux.provider);

const agent = await Agent.open(
	{ storage: await openNodeSqliteStorage(file), models, model: { provider: "faux", modelId: "faux-1" }, cwd },
	BACKGROUND_CONTEXT,
);
await agent.submit("Capital of France?", BACKGROUND_CONTEXT, { requestId: "q1" });
await new Promise(() => {});
