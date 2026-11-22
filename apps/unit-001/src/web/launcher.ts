// Starts a private browser client as the authorized operator, never as the agent owner.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ConfigurationError } from "../errors.ts";
import { matchingApproval, readMissionAuthority } from "../missions/authority.ts";
import {
	agreementInvocation,
	agreementReview,
	browserAgreementArmed,
	lookupIssuedAgreement,
	parseAgreementOutcome,
} from "../missions/browser-agreement.ts";
import { localServiceClient } from "../service-client.ts";
import { createWebGateway, type ManagedWebAgreement } from "./gateway.ts";

/** Serves packaged browser assets until interrupted; restarting provisions a new one-time code. */
export async function runWebWorkspace(
	endpoint: string,
	port: number,
	write: (text: string) => void,
	signal: AbortSignal,
	installationId?: string,
): Promise<number> {
	if (signal.aborted) return 130;
	const client = localServiceClient(endpoint);
	const status = await client.request({ type: "status" }, signal);
	if (status.type !== "status") throw new ConfigurationError("The operator owner is unavailable.");
	const assets = new Map<string, { contentType: string; body: Uint8Array }>();
	for (const [path, contentType] of [
		["/", "text/html; charset=utf-8"],
		["/bootstrap.js", "text/javascript; charset=utf-8"],
		["/style.css", "text/css; charset=utf-8"],
	] as const) {
		const file = path === "/" ? "index.html" : path.slice(1);
		const body = await readFile(new URL(`../../web-dist/${file}`, import.meta.url)).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				throw new ConfigurationError(
					"Browser assets are missing. Build the application workspace or reinstall a complete signed release.",
				);
			},
		);
		assets.set(path, { contentType, body });
	}
	const secret = randomBytes(32).toString("base64url");
	const origin = `http://127.0.0.1:${port}`;
	let managedAgreement: ManagedWebAgreement | undefined;
	let discloseAgreement = false;
	if (installationId !== undefined && client.session === "default" && status.installationId === installationId) {
		const uid = process.getuid?.();
		const authority = () =>
			readMissionAuthority({ kind: "managed", installationId, session: "default" }).catch(() => null);
		const initial = await authority();
		const initialRevision = initial?.revision;
		const generation = initial?.browserAgreement?.generation;
		let armed = uid !== undefined && browserAgreementArmed(initial, uid);
		discloseAgreement = armed;
		// A revoked or replaced generation cannot rearm a paired gateway.
		const isArmed = (current: Awaited<ReturnType<typeof authority>>) => {
			armed =
				armed &&
				uid !== undefined &&
				current?.revision === initialRevision &&
				generation !== undefined &&
				current?.browserAgreement?.generation === generation &&
				browserAgreementArmed(current, uid);
			return armed;
		};
		managedAgreement = {
			async lookup(click, requestSignal) {
				const reply = await client
					.request({ type: "mission", request: { operation: "status" } }, requestSignal)
					.catch(() => null);
				const current = await authority();
				if (requestSignal.aborted) return { status: "unknown" };
				return lookupIssuedAgreement(click, current, uid, reply?.type === "mission" ? reply.result : null);
			},
			async review(view) {
				const current = await authority();
				const enabled = isArmed(current);
				if (current === null) return undefined;
				const active = view.formation.agreement;
				const verifiedApproval =
					active !== null && active.terms.policy.deadlineAt > Date.now()
						? matchingApproval(
								current,
								active.approval.receiptId,
								active.missionId,
								active.revision,
								active.terms,
							)
						: undefined;
				return { armed: enabled, proposal: agreementReview(view.formation.draft, current), verifiedApproval };
			},
			async agree(click, requestSignal, isLive) {
				const reply = await client
					.request({ type: "mission", request: { operation: "status" } }, requestSignal)
					.catch(() => null);
				const current = await authority();
				if (!isLive()) return { status: "unknown" };
				const enabled = isArmed(current);
				const observed = lookupIssuedAgreement(
					click,
					current,
					uid,
					reply?.type === "mission" ? reply.result : null,
				);
				if (observed !== undefined) return observed;
				if (!enabled || current === null) return { status: "refused", code: "not-enabled" };
				if (reply?.type !== "mission") return { status: "refused", code: "unavailable" };
				const review = agreementReview(reply.result.formation.draft, current);
				if (review?.revision !== click.revision || review.digest !== click.digest)
					return { status: "refused", code: "stale-digest" };
				const call = agreementInvocation(installationId, click, click.requestId);
				if (!isLive()) return { status: "unknown" };
				return await new Promise((resolve) => {
					execFile(
						call.file,
						call.args,
						{ env: call.env, shell: false, timeout: 10_000, maxBuffer: 8192, signal: requestSignal },
						(error, stdout) => resolve(parseAgreementOutcome(stdout, error === null ? 0 : null)),
					);
				});
			},
		};
	}
	const gateway = createWebGateway({
		client,
		origin,
		secret,
		assets,
		managed: installationId !== undefined,
		managedAgreement,
	});
	try {
		await new Promise<void>((resolve, reject) => {
			gateway.server.once("error", reject);
			gateway.server.listen(port, "127.0.0.1", () => {
				gateway.server.off("error", reject);
				resolve();
			});
		});
		write(
			`Browser workspace: ${origin}\nOne-time pairing code: ${secret}\nPairing grants this operator's conversation and coding authority.${discloseAgreement ? " It also grants approval of proposed mission revisions." : ""} Keep the code private.\nSession lasts 30 minutes. Restart this command to pair again. Ctrl+C detaches the web workspace; agent work continues.\n`,
		);
		if (!signal.aborted)
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		return 0;
	} finally {
		await gateway.close();
	}
}
