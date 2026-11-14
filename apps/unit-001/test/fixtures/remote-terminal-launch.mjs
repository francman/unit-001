// Gives the controlled local tmux terminal a real disposable SSH client; no production host is contacted.
import { spawn } from "node:child_process";

const child = spawn(
	"docker",
	[
		"exec",
		"-it",
		"-e",
		"TERM=xterm-256color",
		"unit-remote-ssh-20261111",
		"node",
		"/repo/apps/unit-001/dist/bin.js",
		"remote",
		"connect",
		"fixture",
	],
	{ stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("error", (error) => {
	console.error(error.message);
	process.exitCode = 1;
});
child.once("exit", (code) => {
	process.exitCode = code ?? 1;
});
