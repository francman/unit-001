// Sampling and budget enforcement shared by unit-001's standalone latency benchmarks.
import { arch, cpus, platform } from "node:os";

export interface LatencyStats {
	readonly medianMs: number;
	readonly p95Ms: number;
	readonly madMs: number;
	readonly madNoise: number;
}

const WARMUP = 5;
const SAMPLES = 25;

/** Measures one case and fails the process when its untrimmed p95 exceeds the fixed budget. */
export async function benchmark(name: string, budgetMs: number, sample: () => Promise<number>): Promise<void> {
	for (let index = 0; index < WARMUP; index++) await sample();
	const samples: number[] = [];
	for (let index = 0; index < SAMPLES; index++) samples.push(await sample());
	const stats = summarize(samples);
	const passed = stats.p95Ms <= budgetMs;
	console.log(JSON.stringify({ name, budgetMs, ...stats, samples, passed }));
	if (!passed) process.exitCode = 1;
}

/** Reports runtime and host details needed to compare benchmark runs. */
export function reportEnvironment(): void {
	console.log(
		JSON.stringify({
			node: process.version,
			host: `${platform()}-${arch()}`,
			cpu: cpus()[0]?.model,
			warmup: WARMUP,
			samples: SAMPLES,
		}),
	);
}

/** Calculates the median, nearest-rank p95, and median absolute deviation without removing outliers. */
export function summarize(samples: readonly number[]): LatencyStats {
	const sorted = [...samples].sort((left, right) => left - right);
	const medianMs = median(sorted);
	const deviations = sorted.map((value) => Math.abs(value - medianMs)).sort((left, right) => left - right);
	const madMs = median(deviations);
	return {
		medianMs,
		p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
		madMs,
		madNoise: medianMs === 0 ? 0 : (1.4826 * madMs) / medianMs,
	};
}

function median(sorted: readonly number[]): number {
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
