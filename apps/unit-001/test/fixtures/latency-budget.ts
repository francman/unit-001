// Exercises standalone benchmark exit codes with a deterministic 2 ms measurement.
import { benchmark } from "../../bench/benchmark.ts";

await benchmark("exit-code", Number(process.argv[2]), async () => 2);
