import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { browserCommand, createLoginInteraction } from "../src/interaction.ts";
import type { Terminal } from "../src/repl.ts";

describe("browserCommand", () => {
	it("uses the opener of each platform and passes the URL as one argument", () => {
		const url = "https://example.com/auth?a=1&b=2";
		expect(browserCommand("darwin", url)).toEqual(["open", url]);
		expect(browserCommand("linux", url)).toEqual(["xdg-open", url]);
		expect(browserCommand("win32", url)).toEqual(["rundll32", "url.dll,FileProtocolHandler", url]);
	});

	it.each(["file:///etc/passwd", "javascript:alert(1)", "ms-msdt:/id", "calc.exe", "", "//example.com"])(
		"refuses %j, which is not a web URL",
		(url) => {
			expect(browserCommand("linux", url)).toBeUndefined();
		},
	);
});

function setup(lines = "") {
	const input = new PassThrough();
	input.end(lines);
	const err: string[] = [];
	const terminal: Terminal = { input, out: () => {}, err: (text) => void err.push(text) };
	const controller = new AbortController();
	// Not interactive (no output stream), so no browser is ever launched by these tests.
	const login = createLoginInteraction(terminal, controller.signal, "linux");
	return { login, err: () => err.join(""), controller };
}

describe("createLoginInteraction", () => {
	it("prints info messages with their links", () => {
		const { login, err } = setup();
		login.interaction.notify({
			type: "info",
			message: "Sign in",
			links: [{ url: "https://a.example", label: "Docs" }],
		});
		login.close();
		expect(err()).toBe("Sign in\n  Docs: https://a.example\n");
	});

	it("prints the sign-in URL and its instructions", () => {
		const { login, err } = setup();
		login.interaction.notify({
			type: "auth_url",
			url: "https://auth.example/start",
			instructions: "Approve the request.",
		});
		login.close();
		expect(err()).toContain("https://auth.example/start");
		expect(err()).toContain("Approve the request.");
	});

	it("prints the device code and where to enter it", () => {
		const { login, err } = setup();
		login.interaction.notify({
			type: "device_code",
			userCode: "ABCD-1234",
			verificationUri: "https://device.example",
		});
		login.close();
		expect(err()).toContain("https://device.example");
		expect(err()).toContain("ABCD-1234");
	});

	it("reads pasted text and codes", async () => {
		const { login } = setup("  the-code \n");
		expect(await login.interaction.prompt({ type: "manual_code", message: "Paste the code:" })).toBe("the-code");
		login.close();
	});

	it("selects by number or by id and asks again on a bad answer", async () => {
		const { login, err } = setup("9\n2\nfirst\n");
		const request = {
			type: "select",
			message: "Which plan?",
			options: [
				{ id: "first", label: "First" },
				{ id: "second", label: "Second", description: "paid" },
			],
		} as const;
		expect(await login.interaction.prompt(request)).toBe("second");
		expect(await login.interaction.prompt(request)).toBe("first");
		login.close();
		expect(err()).toContain("1. First");
		expect(err()).toContain("2. Second (paid)");
		expect(err()).toContain("Enter the number of one of the choices.");
	});

	it("fails clearly when the input ends before an answer", async () => {
		const { login } = setup("");
		await expect(login.interaction.prompt({ type: "text", message: "Name:" })).rejects.toThrow(/input ended/);
		login.close();
	});

	it("refuses a secret prompt rather than echoing it", async () => {
		const { login } = setup("sk-secret\n");
		await expect(login.interaction.prompt({ type: "secret", message: "API key:" })).rejects.toThrow(/not supported/);
		login.close();
	});

	it("cancels a pending prompt when the login is aborted", async () => {
		const input = new PassThrough(); // never answers
		const terminal: Terminal = { input, out: () => {}, err: () => {} };
		const controller = new AbortController();
		const login = createLoginInteraction(terminal, controller.signal, "linux");
		const pending = login.interaction.prompt({ type: "text", message: "Name:" });
		controller.abort();
		await expect(pending).rejects.toThrow();
		login.close();
	});
});
