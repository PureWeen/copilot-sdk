/**
 * Reproduction script for missing session.idle CLI bug (github/copilot-sdk#558).
 *
 * This script demonstrates the problem by running two scenarios:
 *
 * 1. HAPPY PATH (session.idle sent normally) — sendAndWait resolves quickly.
 * 2. BUG REPRODUCTION (session.idle omitted) — sendAndWait would hang until timeout
 *    WITHOUT the SDK's idle fallback timer. WITH the fallback, it resolves after
 *    the grace period.
 *
 * Usage (from the repo root):
 *   cd nodejs && npx tsx test/reproduce-missing-idle/reproduce.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CopilotClient, approveAll } from "../../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function startMockServer(omitIdle: boolean): Promise<{ url: string; proc: ChildProcess }> {
    const serverPath = resolve(__dirname, "mock-cli-server.ts");
    const proc = spawn(
        process.execPath,
        [
            "--import",
            "tsx",
            serverPath,
            ...(omitIdle ? ["--omit-idle"] : []),
        ],
        {
            cwd: resolve(__dirname, "../.."),
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, NODE_OPTIONS: "" },
        },
    );

    proc.stderr!.on("data", (chunk: Buffer) => {
        process.stderr.write(`  ${chunk.toString().trim()}\n`);
    });

    const url = await new Promise<string>((resolve, reject) => {
        proc.stdout!.once("data", (chunk: Buffer) => {
            const line = chunk.toString().trim();
            if (line.startsWith("http://")) {
                resolve(line);
            } else {
                reject(new Error(`Unexpected mock server output: ${line}`));
            }
        });
        proc.on("error", reject);
    });

    return { url, proc };
}

async function runScenario(name: string, omitIdle: boolean): Promise<void> {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Scenario: ${name}`);
    console.log(`${"=".repeat(60)}`);

    const { url, proc } = await startMockServer(omitIdle);
    console.log(`Mock CLI server started at ${url}`);

    try {
        const client = new CopilotClient({ cliUrl: url });

        const session = await client.createSession({
            onPermissionRequest: approveAll,
        });
        console.log(`Session created: ${session.sessionId}`);

        // Log all events
        session.on((event) => {
            console.log(`  [event] ${event.type}${event.ephemeral ? " (ephemeral)" : ""}`);
        });

        const timeout = omitIdle ? 15_000 : 5_000;
        console.log(`Calling sendAndWait (timeout=${timeout}ms)...`);
        const start = Date.now();

        try {
            const result = await session.sendAndWait(
                { prompt: "What is 2+2?" },
                timeout,
            );
            const elapsed = Date.now() - start;
            console.log(`\n  ✅ sendAndWait resolved in ${elapsed}ms`);
            if (result?.data) {
                console.log(`  Response: ${(result.data as { content?: string }).content ?? "(no content)"}`);
            }

            if (omitIdle && elapsed > 1000) {
                console.log(
                    `  ⚠️  Resolved via idle fallback timer (${elapsed}ms) — CLI bug was hit`,
                );
            }
        } catch (error: unknown) {
            const elapsed = Date.now() - start;
            const msg = error instanceof Error ? error.message : String(error);
            console.log(`\n  ❌ sendAndWait FAILED after ${elapsed}ms: ${msg}`);
        }

        await session.disconnect();
        await client.stop();
    } finally {
        proc.kill();
        // Give the process a moment to clean up
        await new Promise((r) => setTimeout(r, 500));
    }
}

async function main(): Promise<void> {
    console.log("=== Reproducing missing session.idle CLI bug ===");
    console.log("See: https://github.com/github/copilot-sdk/issues/558\n");

    // Scenario 1: Happy path
    await runScenario("Happy path (session.idle sent normally)", false);

    // Scenario 2: Bug reproduction
    await runScenario("Bug reproduction (session.idle OMITTED by CLI)", true);

    console.log("\n" + "=".repeat(60));
    console.log("SUMMARY:");
    console.log("  When the CLI omits session.idle, sendAndWait hangs until timeout.");
    console.log("  The SDK idle fallback timer (turn_end + grace period) mitigates this.");
    console.log("  Root cause: processQueuedItems() in CLI lacks try-catch/try-finally.");
    console.log("=".repeat(60));
}

main().catch(console.error);
