// Verifies #57 reports real process observations without claiming unenforced host limits.
import { expect, it } from "vitest";
import { hostResources } from "../../src/introspection/host.ts";

it("#57 observes the actual process and labels inaccessible workspace evidence", async () => {
	const report = await hostResources(process.cwd());
	expect(report.process.pid).toBe(process.pid);
	expect(report.process.node).toBe(process.version);
	expect(report.process.rssBytes).toBeGreaterThan(0);
	expect(report.observedAt).toBeGreaterThan(0);
	expect(report.system.containerLimit).toBe("unobserved");
	expect(report.scope).toBe("current-process-namespace");
	expect(report.filesystem.kind).toBe("available");
	expect((await hostResources("/this-path-does-not-exist-unit-inspection")).filesystem).toEqual({
		kind: "unavailable",
		reason: "permission-or-unsupported",
	});
});
