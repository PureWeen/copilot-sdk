/**
 * Real CLI reproduction test for session.idle behavior.
 *
 * This script uses the ACTUAL Copilot CLI binary (not a mock) connected to
 * a replay proxy, to observe real `processQueuedItems()` behavior and
 * whether `session.idle` is always emitted after `assistant.turn_end`.
 *
 * It runs multiple iterations under various conditions:
 *   1. Normal operation (baseline)
 *   2. Streaming enabled
 *   3. Rapid-fire messages (stress test)
 *   4. Under CPU pressure (simulates CI resource contention)
 *
 * Usage (from the nodejs/ directory):
 *   npx tsx test/reproduce-missing-idle/real-cli-test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CopilotClient, approveAll } from "../../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HARNESS_SERVER_PATH = resolve(__dirname, "../../../test/harness/server.ts");

// Simple snapshot for testing
const SNAPSHOT_YAML = `models:
  - claude-sonnet-4.5
conversations:
  - messages:
      - role: system
        content: \${system}
      - role: user
        content: What is 2+2?
      - role: assistant
        content: 2 + 2 = 4
`;

interface ProxyHandle {
    url: string;
    proc: ChildProcess;
    snapshotPath: string;
    tmpDir: string;
}

async function startProxy(): Promise<ProxyHandle> {
    const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "idle-repro-")));
    const snapshotDir = join(tmpDir, "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    const snapshotPath = join(snapshotDir, "test.yaml");
    writeFileSync(snapshotPath, SNAPSHOT_YAML);

    const proc = spawn("npx", ["tsx", HARNESS_SERVER_PATH], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
        cwd: resolve(__dirname, "../.."),
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
        const msg = chunk.toString().trim();
        if (msg && !msg.includes("ExperimentalWarning")) {
            // Only show important proxy errors
            if (msg.includes("Error") || msg.includes("error")) {
                console.error(`  [proxy] ${msg}`);
            }
        }
    });

    const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Proxy start timeout")), 15000);
        proc.stdout!.once("data", (chunk: Buffer) => {
            clearTimeout(timer);
            const match = chunk.toString().match(/Listening: (http:\/\/[^\s]+)/);
            if (match) {
                resolve(match[1]);
            } else {
                reject(new Error(`Unexpected proxy output: ${chunk.toString()}`));
            }
        });
        proc.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });

    // Configure the proxy with our snapshot
    const configResp = await fetch(`${url}/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            filePath: snapshotPath,
            workDir: tmpDir,
            testInfo: { file: "real-cli-test.ts", line: 1 },
        }),
    });
    if (!configResp.ok) {
        throw new Error(`Failed to configure proxy: ${configResp.status}`);
    }

    return { url, proc, snapshotPath, tmpDir };
}

async function stopProxy(proxy: ProxyHandle): Promise<void> {
    try {
        await fetch(`${proxy.url}/stop?skipWritingCache=true`, { method: "POST" });
    } catch {
        // Ignore errors during shutdown
    }
    proxy.proc.kill();
    await new Promise((r) => setTimeout(r, 500));
    await rm(proxy.tmpDir, { recursive: true, force: true }).catch(() => {});
}

interface TestResult {
    scenario: string;
    iteration: number;
    eventsReceived: string[];
    turnEndTimestamp: number | null;
    idleTimestamp: number | null;
    gapMs: number | null;
    resolvedViaFallback: boolean;
    timedOut: boolean;
    error: string | null;
    totalMs: number;
}

async function runSingleTest(
    scenario: string,
    iteration: number,
    options: {
        streaming?: boolean;
        prompt?: string;
    },
): Promise<TestResult> {
    const result: TestResult = {
        scenario,
        iteration,
        eventsReceived: [],
        turnEndTimestamp: null,
        idleTimestamp: null,
        gapMs: null,
        resolvedViaFallback: false,
        timedOut: false,
        error: null,
        totalMs: 0,
    };

    const proxy = await startProxy();
    const homeDir = realpathSync(mkdtempSync(join(tmpdir(), "copilot-home-")));
    const workDir = realpathSync(mkdtempSync(join(tmpdir(), "copilot-work-")));

    try {
        const client = new CopilotClient({
            cwd: workDir,
            env: {
                ...process.env,
                COPILOT_API_URL: proxy.url,
                XDG_CONFIG_HOME: homeDir,
                XDG_STATE_HOME: homeDir,
            },
            logLevel: "error",
            githubToken: "fake-token-for-repro",
        });

        const sessionConfig: Record<string, unknown> = {
            onPermissionRequest: approveAll,
        };
        if (options.streaming) {
            (sessionConfig as { streaming?: boolean }).streaming = true;
        }

        const session = await client.createSession(
            sessionConfig as Parameters<typeof client.createSession>[0],
        );

        // Subscribe to ALL events and record timestamps
        session.on((event) => {
            const ts = Date.now();
            result.eventsReceived.push(event.type);

            if (event.type === "assistant.turn_end") {
                result.turnEndTimestamp = ts;
            }
            if (event.type === "session.idle") {
                result.idleTimestamp = ts;
            }
        });

        const start = Date.now();
        const prompt = options.prompt || "What is 2+2?";

        try {
            const response = await session.sendAndWait(
                { prompt },
                20_000, // 20s timeout
            );
            result.totalMs = Date.now() - start;

            // Check if this was resolved via fallback timer (> 3s gap is suspicious)
            if (result.turnEndTimestamp && result.idleTimestamp) {
                result.gapMs = result.idleTimestamp - result.turnEndTimestamp;
                result.resolvedViaFallback = result.gapMs > 3000;
            } else if (result.turnEndTimestamp && !result.idleTimestamp) {
                result.resolvedViaFallback = true;
            }
        } catch (error: unknown) {
            result.totalMs = Date.now() - start;
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes("Timeout")) {
                result.timedOut = true;
            }
            result.error = msg;
        }

        await session.disconnect().catch(() => {});
        await client.stop().catch(() => {});
    } finally {
        await stopProxy(proxy);
        await rm(homeDir, { recursive: true, force: true }).catch(() => {});
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }

    return result;
}

function printResult(r: TestResult): void {
    const status = r.timedOut
        ? "TIMEOUT"
        : r.resolvedViaFallback
          ? "FALLBACK"
          : r.error
            ? "ERROR"
            : "OK";
    const symbol = status === "OK" ? "  ✅" : status === "FALLBACK" ? "  ⚠️ " : "  ❌";

    console.log(
        `${symbol} [${r.scenario}] iter=${r.iteration} ${r.totalMs}ms gap=${r.gapMs ?? "N/A"}ms events=[${r.eventsReceived.join(", ")}]`,
    );
    if (r.error) {
        console.log(`     Error: ${r.error}`);
    }
    if (r.resolvedViaFallback) {
        console.log(`     ⚠️  Resolved via idle fallback timer`);
    }
}

async function runScenario(
    name: string,
    iterations: number,
    options: { streaming?: boolean; prompt?: string },
): Promise<TestResult[]> {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`Scenario: ${name} (${iterations} iterations)`);
    console.log(`${"=".repeat(70)}`);

    const results: TestResult[] = [];
    for (let i = 0; i < iterations; i++) {
        // Reconfigure proxy for each iteration (snapshots get consumed)
        const result = await runSingleTest(name, i + 1, options);
        printResult(result);
        results.push(result);
    }
    return results;
}

// Busy loop to generate CPU pressure in a worker
function startCpuPressure(): { stop: () => void } {
    let running = true;
    const workers: ReturnType<typeof setTimeout>[] = [];

    // Spawn tight loops across multiple microtask batches
    for (let i = 0; i < 4; i++) {
        const burn = () => {
            if (!running) return;
            const end = Date.now() + 50;
            while (Date.now() < end) {
                Math.random(); // tight CPU loop
            }
            workers.push(setTimeout(burn, 0));
        };
        workers.push(setTimeout(burn, 0));
    }

    return {
        stop: () => {
            running = false;
            workers.forEach(clearTimeout);
        },
    };
}

async function main(): Promise<void> {
    console.log("=== Real CLI session.idle Reproduction Test ===");
    console.log(`CLI: ${process.env.COPILOT_CLI_PATH || "(SDK default)"}`);
    console.log(`Node: ${process.version}`);
    console.log(`PID: ${process.pid}\n`);

    const allResults: TestResult[] = [];

    // Scenario 1: Normal operation (baseline)
    const baseline = await runScenario("Normal (baseline)", 5, {});
    allResults.push(...baseline);

    // Scenario 2: With streaming enabled
    const streaming = await runScenario("Streaming enabled", 5, { streaming: true });
    allResults.push(...streaming);

    // Scenario 3: Under CPU pressure
    console.log(
        `\n${"=".repeat(70)}\nScenario: Under CPU pressure (5 iterations)\n${"=".repeat(70)}`,
    );
    const cpuPressure = startCpuPressure();
    const pressureResults: TestResult[] = [];
    for (let i = 0; i < 5; i++) {
        const result = await runSingleTest("CPU pressure", i + 1, {});
        printResult(result);
        pressureResults.push(result);
    }
    cpuPressure.stop();
    allResults.push(...pressureResults);

    // Summary
    console.log(`\n${"=".repeat(70)}`);
    console.log("SUMMARY");
    console.log(`${"=".repeat(70)}`);

    const ok = allResults.filter((r) => !r.timedOut && !r.resolvedViaFallback && !r.error);
    const fallbacks = allResults.filter((r) => r.resolvedViaFallback);
    const timeouts = allResults.filter((r) => r.timedOut);
    const errors = allResults.filter((r) => r.error && !r.timedOut);

    console.log(`Total: ${allResults.length}`);
    console.log(`  OK:        ${ok.length}`);
    console.log(`  Fallback:  ${fallbacks.length}`);
    console.log(`  Timeout:   ${timeouts.length}`);
    console.log(`  Error:     ${errors.length}`);

    if (ok.length > 0) {
        const gaps = ok.map((r) => r.gapMs!).filter((g) => g !== null);
        if (gaps.length > 0) {
            console.log(
                `\n  turn_end → session.idle gap: min=${Math.min(...gaps)}ms, max=${Math.max(...gaps)}ms, avg=${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(0)}ms`,
            );
        }
    }

    if (fallbacks.length > 0) {
        console.log("\n  ⚠️  FALLBACK occurrences (session.idle delayed/missing):");
        for (const r of fallbacks) {
            console.log(`    ${r.scenario} iter=${r.iteration}: gap=${r.gapMs}ms total=${r.totalMs}ms`);
        }
    }

    if (timeouts.length > 0) {
        console.log("\n  ❌ TIMEOUT occurrences:");
        for (const r of timeouts) {
            console.log(`    ${r.scenario} iter=${r.iteration}: ${r.error}`);
        }
    }

    // Exit with non-zero if any failures
    if (timeouts.length > 0 || fallbacks.length > 0) {
        console.log("\n⚠️  Some iterations experienced session.idle issues!");
        process.exit(1);
    } else {
        console.log("\n✅ All iterations received session.idle normally.");
    }
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(2);
});
