// #56: Supplies a real socket boundary and exact host-authored proposal for disposable root issuer acceptance.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { parseChannelSetupInput } from "../../dist/channels/contract.js";
import { requestChannelSetup } from "../../dist/channels/registry.js";
import { writeMissionAuthority } from "../../dist/missions/authority.js";

const installationId = "11111111-1111-4111-8111-111111111111";
const location = { kind: "managed", installationId, session: "default" };
const proposalFile = "/tmp/unit-channel-proposal.json";
if (process.argv[2] === "prepare") {
	if (process.geteuid() !== 0) throw new Error("Fixture preparation requires its disposable administrator.");
	const creator = {
		schemaVersion: 1,
		installationId,
		session: "default",
		revision: 1,
		creator: { kind: "human", id: "fixture-creator", uid: 1811 },
		ceiling: {
			allowedTools: [],
			maxCycles: 1,
			maxRequests: 1,
			maxRetries: 0,
			maxConsecutiveNoProgress: 1,
			maxDurationMs: 1000,
		},
		approvals: [],
	};
	await writeMissionAuthority(location, creator);
	const state = { revision: 0, channels: {}, receipts: {} };
	const request = requestChannelSetup(
		state,
		parseChannelSetupInput({
			requestId: "setup-1",
			channelId: "creator",
			expectedRevision: 0,
			adapter: "telegram",
			destination: "creator-1811",
			capabilities: ["status"],
			expiresAt: Date.now() + 300000,
		}),
		creator,
		[{ id: "telegram", capabilities: ["status"], setup: "managed-bot" }],
		Date.now(),
	);
	writeFileSync(proposalFile, `${JSON.stringify(request)}\n`, { mode: 0o644 });
} else {
	const directory = `/var/lib/unit-001/agents/${installationId}/control`;
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const server = createServer((socket) => {
		let text = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			text += chunk;
			if (text.length > 4096) return socket.destroy();
			if (!text.includes("\n")) return;
			const request = JSON.parse(text.slice(0, text.indexOf("\n")));
			const response =
				request.type === "channels" && request.request?.operation === "status"
					? {
							type: "channels",
							result: {
								operation: "status",
								view: { channels: [{ request: JSON.parse(readFileSync(proposalFile, "utf8")) }] },
							},
						}
					: { type: "error", message: "Unsupported fixture operation." };
			socket.end(`${JSON.stringify(response)}\n`);
		});
	});
	server.listen(join(directory, "default.sock"));
	process.once("SIGTERM", () => server.close(() => process.exit(0)));
}
