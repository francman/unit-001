// Contends for a session lock, then holds it until its process is killed.
import { acquireSessionLock } from "../../src/lock.ts";

await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
try {
	const release = await acquireSessionLock(process.argv[2]);
	process.stdout.write("LOCKED\n");
	process.stdin.resume();
	await new Promise<void>((resolve) => process.stdin.once("end", resolve));
	await release();
} catch (error) {
	if (!(error instanceof Error) || !error.message.includes("already running")) throw error;
	process.stdout.write("BUSY\n");
	process.stdin.destroy();
}
