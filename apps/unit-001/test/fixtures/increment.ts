// Child process for credentials.test.ts: bumps a counter stored as an API key, `count` times, through the store.
import { FileCredentialStore } from "../../src/credentials.ts";

const [file, count] = process.argv.slice(2);
if (file === undefined || count === undefined) throw new Error("usage: increment.ts <file> <count>");

const store = new FileCredentialStore(file);
for (let index = 0; index < Number(count); index++) {
	await store.modify("counter", async (current) => ({
		type: "api_key",
		key: String(Number(current?.type === "api_key" ? current.key : 0) + 1),
	}));
}
