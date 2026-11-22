// Names why the owner refused a mission formation change before committing it, as a fixed code clients can show.

/** Every reason the owner refuses a draft, proposal or agreement without committing anything. */
export const MISSION_REFUSAL_CODES = [
	"stale-revision",
	"stale-digest",
	"incomplete",
	"outside-authority",
	"execution-active",
	"held",
	"managed-requires-gateway",
	"conflicting-request",
	// The managed browser agreement helper's own pre-write refusals.
	"not-enabled",
	"creator-mismatch",
	"stale-authority",
	"already-issued",
	"agreement-limit",
	"unavailable",
] as const;

export type MissionRefusalCode = (typeof MISSION_REFUSAL_CODES)[number];

/** A formation change refused before any commit; the message is for terminals, the code for the browser wire. */
export class MissionRefusal extends Error {
	readonly code: MissionRefusalCode;

	constructor(code: MissionRefusalCode, message: string) {
		super(message);
		this.name = "MissionRefusal";
		this.code = code;
	}
}

const REFUSAL_TEXT: Record<MissionRefusalCode, string> = {
	"stale-revision": "The mission draft changed since you read it; inspect it again.",
	"stale-digest": "The proposal or its authority changed; inspect the exact proposal again.",
	incomplete: "The mission draft is incomplete; mission status lists what is still needed.",
	"outside-authority": "The mission terms exceed the creator's authority or deadline; revise them.",
	"execution-active": "Stop the current mission work before changing its agreement.",
	held: "The service is held for maintenance.",
	"managed-requires-gateway": "On a managed host, agreement needs the creator's armed browser or the administrator command.",
	"conflicting-request": "That request ID already belongs to a different mission change.",
	"not-enabled": "Browser agreement is not enabled for this creator.",
	"creator-mismatch": "Only the creator's own account can agree to the mission.",
	"stale-authority": "Mission authority changed since the review; inspect the proposal again.",
	"already-issued": "This revision has already been agreed or superseded.",
	"agreement-limit": "Browser agreement has reached its receipt limit; agree with the administrator command.",
	unavailable: "Nothing was agreed: the mission owner or authority could not be read in time.",
};

/** One readable sentence for a refusal, for terminals that only receive its code. */
export function describeMissionRefusal(code: MissionRefusalCode): string {
	return REFUSAL_TEXT[code];
}

/** Parses a refusal code crossing the owner wire; anything else is not a refusal. */
export function parseMissionRefusalCode(value: unknown): MissionRefusalCode {
	const code = MISSION_REFUSAL_CODES.find((item) => item === value);
	if (code === undefined) throw new Error("Unknown mission refusal code.");
	return code;
}
