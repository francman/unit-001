// Exercises credential ownership from a child process: hold the lock or increment the stored counter.
import { once } from "node:events";
import { FileCredentialStore } from "../../src/credentials.ts";

const [file, operation] = process.argv.slice(2);
if (file === undefined || operation === undefined) throw new Error("usage: increment.ts <file> <count|hold>");

const store = new FileCredentialStore(file);
if (operation === "hold") {
	await store.modify("counter", async () => {
		const disconnected = once(process, "disconnect");
		process.send?.("LOCKED");
		await disconnected;
		return undefined;
	});
} else {
	for (let index = 0; index < Number(operation); index++) {
		await store.modify("counter", async (current) => ({
			type: "api_key",
			key: String(Number(current?.type === "api_key" ? current.key : 0) + 1),
		}));
	}
}
