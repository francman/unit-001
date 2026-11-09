// Exercises actual setup/readline input ownership without contacting a provider.
import { createLoginInteraction } from "../../dist/interaction.js";
import { SetupUI } from "../../dist/setup-ui.js";

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => controller.abort());
const terminal = {
	input: process.stdin,
	output: process.stdout,
	out: (text) => process.stdout.write(text),
	err: (text) => process.stderr.write(text),
};
const ui = new SetupUI(terminal, "handoff-fixture", process.env.NO_COLOR === undefined);
let login;
try {
	await ui.choose(
		{ step: 1, title: "Choose a provider", description: "Terminal ownership fixture" },
		[{ id: "continue", label: "Continue to fixture login" }],
		"continue",
		controller.signal,
	);
	await ui.suspend();
	login = createLoginInteraction(terminal, controller.signal, "linux");
	if (process.argv[2] === "poll") {
		login.interaction.notify({ type: "progress", message: "Waiting for fixture authorization" });
		await new Promise((_resolve, reject) => {
			login.interaction.signal.addEventListener("abort", () => reject(login.interaction.signal.reason), { once: true });
		});
	}
	const code = await login.interaction.prompt({ type: "text", message: "Fixture authorization code:" });
	login.close();
	login = undefined;
	if (code !== "fixture-auth-code") throw Error("Authorization input was lost or duplicated");
	await ui.choose(
		{ step: 3, title: "Login input received once", description: "Setup owns the terminal again" },
		[{ id: "finish", label: "Finish terminal fixture" }],
		"finish",
		controller.signal,
	);
	process.exitCode = 0;
} catch (error) {
	if (controller.signal.aborted || login?.interaction.signal.aborted || error?.constructor.name === "SetupCancelled")
		process.exitCode = 130;
	else throw error;
} finally {
	login?.close();
	await ui.close();
}
