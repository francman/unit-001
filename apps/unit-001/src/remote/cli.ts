// Routes local remote commands without loading provider credentials or opening the owner's storage.
import { randomUUID } from "node:crypto";
import type { Terminal as RichTerminal } from "@earendil-works/pi-tui";
import { runServiceAttach } from "../attach.ts";
import { runMissionSetup } from "../missions/setup.ts";
import { sanitizeTerminalText } from "../render.ts";
import type { Terminal } from "../repl.ts";
import { runRichServiceAttach } from "../terminal-ui.ts";
import { REMOTE_USAGE, type RemoteCommand } from "./args.ts";
import { connectRemoteClient } from "./client.ts";
import { addRemoteProfile, listRemoteProfiles, readRemoteProfile, removeRemoteProfile } from "./profiles.ts";
import { discoverRemote } from "./ssh.ts";

export interface RemoteCommandContext {
	readonly directory: string;
	readonly terminal: Terminal;
	readonly richTerminal?: RichTerminal;
	readonly colorMode: "color" | "monochrome";
}

/** Runs an explicit command against a profile while preserving the existing remote owner. */
export async function runRemoteCommand(
	command: RemoteCommand,
	context: RemoteCommandContext,
	signal: AbortSignal,
): Promise<number> {
	const { terminal, directory } = context;
	if (command.action === "help") {
		terminal.out(`${REMOTE_USAGE}\n`);
		return 0;
	}
	if (command.action === "list") {
		for (const profile of await listRemoteProfiles(directory))
			terminal.out(`${profile.name}\t${profile.host}\t${profile.session}\t${profile.installationId}\n`);
		return 0;
	}
	if (command.action === "remove") {
		await removeRemoteProfile(directory, command.name);
		terminal.out(`Removed remote bookmark ${command.name}.\n`);
		return 0;
	}
	if (command.action === "add") {
		const discovered = await discoverRemote(command.host, command.agentName, command.session, signal);
		await addRemoteProfile(directory, { schema: 1, name: command.name, ...discovered });
		terminal.out(
			`Pinned ${command.name} to installation ${discovered.installationId}; session ${discovered.session}.\n`,
		);
		return 0;
	}
	const profile = await readRemoteProfile(directory, command.name);
	terminal.err(`Connecting to ${profile.name} (${profile.host})…\n`);
	const client = await connectRemoteClient(profile, command.session ?? profile.session, signal);
	try {
		if (command.action === "connect") {
			return !command.plain && context.richTerminal !== undefined
				? await runRichServiceAttach(client, context.richTerminal, signal, {
						colorMode: context.colorMode,
						missionSetup: async (flowSignal) => {
							const status = await client.request({ type: "status" }, flowSignal);
							if (status.type === "error") throw new Error(status.message);
							if (status.type !== "status") throw new Error("Unexpected remote status response.");
							return runMissionSetup(
								terminal,
								status.name,
								async (request) => {
									const response = await client.request({ type: "mission", request }, flowSignal);
									if (response.type === "error") throw new Error(response.message);
									if (response.type !== "mission") throw new Error("Unexpected remote mission response.");
									return response.result;
								},
								flowSignal,
								context.colorMode !== "monochrome",
							);
						},
					})
				: await runServiceAttach(client, terminal, signal);
		}
		const requestId = command.action === "send" ? (command.requestId ?? randomUUID()) : undefined;
		if (requestId !== undefined)
			terminal.err(`Request ID ${sanitizeTerminalText(requestId)}; retain it if the outcome is unknown.\n`);
		const response = await client.request(
			command.action === "send"
				? { type: "send", prompt: command.prompt, requestId }
				: { type: command.action === "cancel" ? "cancel" : "status" },
			signal,
		);
		if (response.type === "error") {
			terminal.err(`${sanitizeTerminalText(response.message)}\n`);
			return 1;
		}
		if (response.type === "reply") {
			if (response.reply.status === "failed") {
				terminal.err(`${sanitizeTerminalText(response.reply.reason)}\n`);
				return 1;
			}
			terminal.out(`${sanitizeTerminalText(response.reply.text)}\n`);
		} else terminal.out(`${JSON.stringify(response)}\n`);
		return 0;
	} finally {
		await client.close();
	}
}
