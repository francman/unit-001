// Runs a downgrade from a selected fixture core. The test links ../../deploy to that installed core's lib directory.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createUpdateContext, rollbackUpdate } from "../../deploy/update-activation.mjs";

const [root, record, view, authorityPath, change] = JSON.parse(process.argv[2]);
const events = [];
let held = null;
const result = await rollbackUpdate(record, {
	root,
	executingModule: createUpdateContext(root).executingModule,
	control(_record, args) {
		events.push(args[0]);
		if (args[0] === "service-status")
			return { installationId: record.id, version: record.releaseVersion, maintenance: { protocol: 1 } };
		if (args[0] === "maintenance-enter") {
			held = args[2];
			return { protocol: 1, state: "held", operationId: held, result: "drained" };
		}
		assert.equal(args[0], "maintenance-release");
		assert.equal(args[2], held);
		held = null;
	},
	missionStatus() {
		events.push("mission-status");
		if (held === null) return view;
		if (change === "task") return { ...view, loopRollback: "live-loop" };
		const authority = JSON.parse(readFileSync(authorityPath, "utf8"));
		authority.operationIntent.action = "open";
		writeFileSync(authorityPath, JSON.stringify(authority));
		return view;
	},
});
assert.equal(held, null);
process.stdout.write(JSON.stringify({ result, events }));
