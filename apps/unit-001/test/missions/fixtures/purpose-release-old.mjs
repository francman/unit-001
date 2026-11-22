// #72: Copy into an untouched published 0.0.9 app (`app/purpose-release-old.mjs`) and run with its bundled Linux Node:
// `runtime/bin/node app/purpose-release-old.mjs FILE`. It opens a database that holds the purpose document it does not
// know, then agrees an amendment through its own approval path.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Agent } from "./dist/agent.js";

assert.equal(JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8")).version, "0.0.9");
const file = process.argv[2];
const agent = await Agent.open(
	{
		storage: await openNodeSqliteStorage(file),
		models: createModels(),
		model: null,
		cwd: dirname(file),
		mission: { kind: "developer-local", directory: dirname(file), session: "default" },
		name: "bob",
	},
	context,
);
try {
	// Step 2a: the published reader sees the current owner's agreement unchanged.
	const before = await agent.mission({ operation: "status" }, context);
	assert.equal(before.agreementValid, true);
	assert.deepEqual(before.formation.agreement, JSON.parse(await readFile(`${file}.seeded`, "utf8")));
	// Step 2b: it amends the purpose; the database write is the one the current owner must import.
	const draft = await agent.mission(
		{
			operation: "draft",
			expectedRevision: 1,
			requestId: "draft-2",
			terms: { ...before.formation.agreement.terms, objective: "Keep dependencies and lockfiles secure" },
		},
		context,
	);
	const proposal = await agent.mission(
		{ operation: "propose", expectedRevision: draft.formation.draft.revision, requestId: "propose-2" },
		context,
	);
	const agreed = await agent.mission(
		{
			operation: "approve-local",
			expectedRevision: proposal.formation.draft.revision,
			digest: proposal.formation.draft.digest,
			requestId: "approve-2",
		},
		context,
	);
	assert.equal(agreed.agreementValid, true);
	assert.equal(agreed.formation.agreement.revision, 2);
	await writeFile(`${file}.amended`, JSON.stringify(agreed.formation.agreement));
	console.log("published 0.0.9 opened the purpose database and agreed revision 2");
} finally {
	await agent.close(context);
}
