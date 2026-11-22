// Tells a parked purpose loop apart from active work for maintenance drain; scheduling and rollback use other rules.
import type { HarnessInspection, TaskInspection } from "@earendil-works/pi-durable";
import type { LoopState } from "./purpose-loop.ts";

/**
 * Whether every live task that belongs to continuous operation is the current loop sleeping for its persisted next
 * observation (or a maintenance re-sleep) with no run active: such a loop is drained for backup and update. A live
 * task in any run conversation (a generation is owned by its conversation, not by the loop), a running run, a
 * reserved attempt or a pending tool intent keeps it busy. Historical acknowledged uncertainty does not.
 */
export function loopParkedForMaintenance(inspection: HarnessInspection, loop: LoopState | undefined): boolean {
	const live = inspection.tasks.filter((task) => isLoopTask(task, loop));
	if (live.length === 0) return true;
	if (!loop || live.length !== 1) return false;
	const [task] = live;
	const activity = loop.operation.activity;
	return (
		task.record.id === loop.operation.loop &&
		task.state.kind === "sleeping" &&
		activity?.kind === "waiting" &&
		activity.reason !== "retry" &&
		task.state.until === activity.until &&
		loop.runs.every((run) => run.state.status !== "running")
	);
}

/** Whether a task belongs to continuous operation, so the general drain rule can leave it to `loopParkedForMaintenance`. */
export function isLoopTask(task: TaskInspection, loop: LoopState | undefined): boolean {
	return (
		task.record.kind === "unit.mission.loop" ||
		loop?.runs.some((run) => run.conversation === task.record.conversationId) === true
	);
}

/**
 * Whether a release without the loop or review task may open this Session: only with neither live, since such a
 * release leaves the task blocked and its own drain then defers every later update. A maintenance hold ends a parked
 * review task, so a held, drained Session reports none.
 */
export function loopRollbackBlocker(inspection: HarnessInspection): "live-loop" | undefined {
	return inspection.tasks.some(
		(task) => task.record.kind === "unit.mission.loop" || task.record.kind === "unit.mission.review",
	)
		? "live-loop"
		: undefined;
}
