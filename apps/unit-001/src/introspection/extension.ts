// Exposes the shared deterministic OS collector through a read-only host tool.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import { operatingSystemFacts } from "./os.ts";

/** Installs factual OS inspection without shell arguments, model inference or privilege escalation. */
export function introspectionExtension(): Extension {
	return defineExtension({
		name: "unit.introspection",
		sections: [
			section(
				"preamble",
				() =>
					"For operating-system or environment questions use unit_inspect_os and report its current observed facts. Kernel release is not distribution version. Scope is this process namespace; do not claim physical-host or container knowledge that is unavailable. Never infer OS from your model identity or an installation's name.",
				{ tag: false },
			),
		],
		tools: [
			defineTool({
				name: "unit_inspect_os",
				description:
					"Read actual OS, userland distribution/version, kernel and architecture with source and observation time.",
				parameters: Type.Object({}),
				replay: "safe",
				execute: async () => ({ output: [{ type: "text", text: JSON.stringify(await operatingSystemFacts()) }] }),
			}),
		],
	});
}
