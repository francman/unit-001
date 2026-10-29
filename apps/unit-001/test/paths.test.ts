import { describe, expect, it } from "vitest";
import { UsageError } from "../src/errors.ts";
import { dataDirectory, sessionFile, validateSessionName } from "../src/paths.ts";

describe("dataDirectory", () => {
	it("uses the per-user data directory of each platform", () => {
		expect(dataDirectory({ platform: "linux", env: {}, home: "/home/ada" })).toBe("/home/ada/.local/share/unit-001");
		expect(dataDirectory({ platform: "darwin", env: {}, home: "/Users/ada" })).toBe(
			"/Users/ada/Library/Application Support/unit-001",
		);
		expect(dataDirectory({ platform: "win32", env: {}, home: "C:\\Users\\ada" })).toBe(
			"C:\\Users\\ada\\AppData\\Roaming\\unit-001",
		);
	});

	it("follows APPDATA on Windows and an absolute XDG_DATA_HOME elsewhere", () => {
		expect(dataDirectory({ platform: "win32", env: { APPDATA: "D:\\Roaming" }, home: "C:\\Users\\ada" })).toBe(
			"D:\\Roaming\\unit-001",
		);
		expect(dataDirectory({ platform: "linux", env: { XDG_DATA_HOME: "/data" }, home: "/home/ada" })).toBe(
			"/data/unit-001",
		);
	});

	it("ignores a relative XDG_DATA_HOME, as the specification requires", () => {
		expect(dataDirectory({ platform: "linux", env: { XDG_DATA_HOME: "relative" }, home: "/home/ada" })).toBe(
			"/home/ada/.local/share/unit-001",
		);
	});

	it("lets UNIT_001_HOME override every platform, ignoring an empty value", () => {
		expect(dataDirectory({ platform: "linux", env: { UNIT_001_HOME: "/srv/agent" }, home: "/home/ada" })).toBe(
			"/srv/agent",
		);
		expect(dataDirectory({ platform: "win32", env: { UNIT_001_HOME: "E:\\agent" }, home: "C:\\Users\\ada" })).toBe(
			"E:\\agent",
		);
		expect(dataDirectory({ platform: "linux", env: { UNIT_001_HOME: "" }, home: "/home/ada" })).toBe(
			"/home/ada/.local/share/unit-001",
		);
	});
});

describe("validateSessionName", () => {
	it.each(["default", "work", "a", "my-session_2", "v1.2", "A".repeat(64)])("accepts %s", (name) => {
		expect(validateSessionName(name)).toBe(name);
	});

	it.each([
		["empty", ""],
		["leading dot", ".hidden"],
		["leading hyphen", "-x"],
		["trailing dot, which Windows drops", "work."],
		["a path separator", "a/b"],
		["a Windows separator", "a\\b"],
		["parent traversal", ".."],
		["a space", "a b"],
		["non-ASCII", "séance"],
		["too long", "a".repeat(65)],
		["a reserved device", "con"],
		["a reserved device with an extension", "NUL.txt"],
		["a numbered reserved device", "com1"],
	])("rejects %s", (_label, name) => {
		expect(() => validateSessionName(name)).toThrow(UsageError);
	});
});

describe("sessionFile", () => {
	it("places the session under sessions/ with the platform's separators", () => {
		expect(sessionFile("/data/unit-001", "work", "linux")).toBe("/data/unit-001/sessions/work.sqlite");
		expect(sessionFile("C:\\data\\unit-001", "work", "win32")).toBe("C:\\data\\unit-001\\sessions\\work.sqlite");
	});

	it("validates the name", () => {
		expect(() => sessionFile("/data", "../escape", "linux")).toThrow(UsageError);
	});
});
