/**
 * Tool-use stress test for session.idle with the real CLI.
 * 
 * Tool use exercises processQueuedItems more thoroughly since the CLI
 * must coordinate tool calls, LLM re-invocations, and background tasks.
 *
 * Usage (from the nodejs/ directory):
 *   npx tsx test/reproduce-missing-idle/tooluse-stress-test.ts
 */

import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { CopilotClient, approveAll } from "../../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HARNESS_SERVER_PATH = resolve(__dirname, "../../../test/harness/server.ts");

// Use the EXISTING snapshot that tests custom tool use
const CUSTOM_TOOL_SNAPSHOT = resolve(__dirname, "../../../test/snapshots/session/should_create_session_with_custom_tool.yaml");
const MULTI_TURN_TOOL_SNAPSHOT = resolve(__dirname, "../../../test/snapshots/multi_turn/should_use_tool_results_from_previous_turns.yaml");
const STATEFUL_CONV_SNAPSHOT = resolve(__dirname, "../../../test/snapshots/session/should_have_stateful_conversation.yaml");

interface ProxyHandle {
    url: string;
    proc: ChildProcess;
}

async function startProxy(): Promise<ProxyHandle> {
    const proc = spawn("npx", ["tsx", HARNESS_SERVER_PATH], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
        cwd: resolve(__dirname, "../.."),
    });

    proc.stderr!.on("data", () => {});

    const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Proxy start timeout")), 15000);
        proc.stdout!.once("data", (chunk: Buffer) => {
            clearTimeout(timer);
            const match = chunk.toString().match(/Listening: (http:\/\/[^\s]+)/);
            if (match) resolve(match[1]);
            else reject(new Error(`Unexpected: ${chunk}`));
        });
        proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    });

    return { url, proc };
}

async function configureProxy(proxy: ProxyHandle, snapshotPath: string, workDir: string): Promise<void> {
    await fetch(`${proxy.url}/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            filePath: snapshotPath,
            workDir,
            testInfo: { file: "tooluse-stress-test.ts", line: 1 },
        }),
    });
}

async function stopProxy(proxy: ProxyHandle): Promise<void> {
    try { await fetch(`${proxy.url}/stop?skipWritingCache=true`, { method: "POST" }); } catch {}
    proxy.proc.kill();
    await new Promise(r => setTimeout(r, 300));
}

type Result = { pass: number; fail: number; fallback: number; details: string[] };

function newResult(): Result {
    return { pass: 0, fail: 0, fallback: 0, details: [] };
}

async function runSingleSession(opts: {
    proxy: ProxyHandle;
    snapshotPath: string;
    prompt: string;
    label: string;
    tools?: Array<{
        name: string;
        description: string;
        parameters: object;
        handler: (args: Record<string, string>) => Promise<{ textResultForLlm: string; resultType: "success" }>;
    }>;
    setupWorkDir?: (workDir: string) => void;
}): Promise<"pass" | "fail" | "fallback"> {
    const homeDir = realpathSync(mkdtempSync(join(tmpdir(), "h-")));
    const workDir = realpathSync(mkdtempSync(join(tmpdir(), "w-")));

    if (opts.setupWorkDir) opts.setupWorkDir(workDir);

    try {
        await configureProxy(opts.proxy, opts.snapshotPath, workDir);

        const client = new CopilotClient({
            cwd: workDir,
            env: { ...process.env, COPILOT_API_URL: opts.proxy.url, XDG_CONFIG_HOME: homeDir, XDG_STATE_HOME: homeDir },
            logLevel: "error",
            githubToken: "fake-token",
        });

        const session = await client.createSession({
            onPermissionRequest: approveAll,
            tools: opts.tools,
        });

        const events: string[] = [];
        let gotTurnEnd = false;
        let gotIdle = false;
        let turnEndTs = 0;
        let idleTs = 0;

        session.on((event) => {
            events.push(event.type);
            if (event.type === "assistant.turn_end") { gotTurnEnd = true; turnEndTs = Date.now(); }
            if (event.type === "session.idle") { gotIdle = true; idleTs = Date.now(); }
        });

        const start = Date.now();
        try {
            await session.sendAndWait({ prompt: opts.prompt }, 30_000);
            const gap = gotTurnEnd && gotIdle ? idleTs - turnEndTs : -1;
            const elapsed = Date.now() - start;

            if (!gotIdle) {
                return "fail";
            } else if (gap > 3000) {
                return "fallback";
            }
            return "pass";
        } catch (err) {
            return "fail";
        } finally {
            await session.disconnect().catch(() => {});
            await client.stop().catch(() => {});
        }
    } finally {
        await rm(homeDir, { recursive: true, force: true }).catch(() => {});
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}

// ============================================================
// Test 1: Custom tool use (20 iterations)
// ============================================================
async function testCustomToolUse(): Promise<Result> {
    console.log("\n--- Test 1: Custom tool use (20 iterations) ---");
    const result = newResult();

    const tools = [{
        name: "get_secret_number",
        description: "Gets the secret number",
        parameters: {
            type: "object" as const,
            properties: { key: { type: "string", description: "Key" } },
            required: ["key"],
        },
        handler: async (args: Record<string, string>) => ({
            textResultForLlm: args.key === "ALPHA" ? "54321" : "unknown",
            resultType: "success" as const,
        }),
    }];

    for (let i = 0; i < 20; i++) {
        const proxy = await startProxy();
        try {
            const status = await runSingleSession({
                proxy,
                snapshotPath: CUSTOM_TOOL_SNAPSHOT,
                prompt: "What is the secret number for key ALPHA?",
                label: `tool-use-${i}`,
                tools,
            });

            if (status === "pass") { result.pass++; process.stdout.write("."); }
            else if (status === "fallback") { result.fallback++; process.stdout.write("F"); }
            else { result.fail++; process.stdout.write("X"); }
        } finally {
            await stopProxy(proxy);
        }
    }

    console.log(`\n  Results: ${result.pass} pass, ${result.fail} fail, ${result.fallback} fallback`);
    return result;
}

// ============================================================
// Test 2: Multi-turn with tool use (file read) - 10 iterations
// ============================================================
async function testMultiTurnToolUse(): Promise<Result> {
    console.log("\n--- Test 2: Multi-turn tool use (10 iterations) ---");
    const result = newResult();

    for (let i = 0; i < 10; i++) {
        const proxy = await startProxy();
        const homeDir = realpathSync(mkdtempSync(join(tmpdir(), "h-")));
        const workDir = realpathSync(mkdtempSync(join(tmpdir(), "w-")));

        try {
            // Write the secret file the tool will read
            writeFileSync(join(workDir, "secret.txt"), "The magic number is 42.");

            await configureProxy(proxy, MULTI_TURN_TOOL_SNAPSHOT, workDir);

            const client = new CopilotClient({
                cwd: workDir,
                env: { ...process.env, COPILOT_API_URL: proxy.url, XDG_CONFIG_HOME: homeDir, XDG_STATE_HOME: homeDir },
                logLevel: "error",
                githubToken: "fake-token",
            });

            const session = await client.createSession({ onPermissionRequest: approveAll });

            // First turn: reads a file (triggers tool use)
            let gotIdle = false;
            let turnEndTs = 0;
            let idleTs = 0;

            const unsub = session.on((event) => {
                if (event.type === "assistant.turn_end") { turnEndTs = Date.now(); }
                if (event.type === "session.idle") { gotIdle = true; idleTs = Date.now(); }
            });

            try {
                await session.sendAndWait({
                    prompt: "Read the file 'secret.txt' and tell me what the magic number is.",
                }, 30_000);

                const gap = gotIdle ? idleTs - turnEndTs : -1;
                if (!gotIdle) { result.fail++; process.stdout.write("X"); }
                else if (gap > 3000) { result.fallback++; process.stdout.write("F"); }
                else { result.pass++; process.stdout.write("."); }
            } catch {
                result.fail++; process.stdout.write("X");
            }
            unsub();

            await session.disconnect().catch(() => {});
            await client.stop().catch(() => {});
        } finally {
            await stopProxy(proxy);
            await rm(homeDir, { recursive: true, force: true }).catch(() => {});
            await rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
    }

    console.log(`\n  Results: ${result.pass} pass, ${result.fail} fail, ${result.fallback} fallback`);
    return result;
}

// ============================================================
// Test 3: Stateful conversation (existing snapshot) - 10 iterations
// ============================================================
async function testStatefulConversation(): Promise<Result> {
    console.log("\n--- Test 3: Stateful conversation, single turn (10 iterations) ---");
    const result = newResult();

    for (let i = 0; i < 10; i++) {
        const proxy = await startProxy();
        try {
            const status = await runSingleSession({
                proxy,
                snapshotPath: STATEFUL_CONV_SNAPSHOT,
                prompt: "What is 1+1?",
                label: `stateful-${i}`,
            });

            if (status === "pass") { result.pass++; process.stdout.write("."); }
            else if (status === "fallback") { result.fallback++; process.stdout.write("F"); }
            else { result.fail++; process.stdout.write("X"); }
        } finally {
            await stopProxy(proxy);
        }
    }

    console.log(`\n  Results: ${result.pass} pass, ${result.fail} fail, ${result.fallback} fallback`);
    return result;
}

// ============================================================
// Test 4: Concurrent tool-use sessions (3 at once, 5 iterations)
// ============================================================
async function testConcurrentToolUse(): Promise<Result> {
    console.log("\n--- Test 4: Concurrent tool use (3 at once, 5 iterations) ---");
    const result = newResult();

    const tools = [{
        name: "get_secret_number",
        description: "Gets the secret number",
        parameters: {
            type: "object" as const,
            properties: { key: { type: "string", description: "Key" } },
            required: ["key"],
        },
        handler: async (args: Record<string, string>) => ({
            textResultForLlm: args.key === "ALPHA" ? "54321" : "unknown",
            resultType: "success" as const,
        }),
    }];

    for (let iter = 0; iter < 5; iter++) {
        const proxies = await Promise.all([startProxy(), startProxy(), startProxy()]);

        const tasks = proxies.map(async (proxy) => {
            try {
                return await runSingleSession({
                    proxy,
                    snapshotPath: CUSTOM_TOOL_SNAPSHOT,
                    prompt: "What is the secret number for key ALPHA?",
                    label: `concurrent-tool-${iter}`,
                    tools,
                });
            } finally {
                await stopProxy(proxy);
            }
        });

        const results = await Promise.all(tasks);
        for (const r of results) {
            if (r === "pass") { result.pass++; process.stdout.write("."); }
            else if (r === "fallback") { result.fallback++; process.stdout.write("F"); }
            else { result.fail++; process.stdout.write("X"); }
        }
        process.stdout.write(" ");
    }

    console.log(`\n  Results: ${result.pass} pass, ${result.fail} fail, ${result.fallback} fallback`);
    return result;
}

// ============================================================
// Test 5: Slow tool handler (simulates slow external service)
// ============================================================
async function testSlowToolHandler(): Promise<Result> {
    console.log("\n--- Test 5: Slow tool handler (500ms delay, 10 iterations) ---");
    const result = newResult();

    const tools = [{
        name: "get_secret_number",
        description: "Gets the secret number",
        parameters: {
            type: "object" as const,
            properties: { key: { type: "string", description: "Key" } },
            required: ["key"],
        },
        handler: async (args: Record<string, string>) => {
            // Simulate a slow tool (external API, database call, etc.)
            await new Promise(r => setTimeout(r, 500));
            return {
                textResultForLlm: args.key === "ALPHA" ? "54321" : "unknown",
                resultType: "success" as const,
            };
        },
    }];

    for (let i = 0; i < 10; i++) {
        const proxy = await startProxy();
        try {
            const status = await runSingleSession({
                proxy,
                snapshotPath: CUSTOM_TOOL_SNAPSHOT,
                prompt: "What is the secret number for key ALPHA?",
                label: `slow-tool-${i}`,
                tools,
            });

            if (status === "pass") { result.pass++; process.stdout.write("."); }
            else if (status === "fallback") { result.fallback++; process.stdout.write("F"); }
            else { result.fail++; process.stdout.write("X"); }
        } finally {
            await stopProxy(proxy);
        }
    }

    console.log(`\n  Results: ${result.pass} pass, ${result.fail} fail, ${result.fallback} fallback`);
    return result;
}

// ============================================================
// Main
// ============================================================
async function main(): Promise<void> {
    console.log("=== Tool-Use & Advanced session.idle Stress Test (Real CLI) ===");
    console.log(`Node: ${process.version} | PID: ${process.pid}`);

    const results = [];

    results.push(await testCustomToolUse());
    results.push(await testMultiTurnToolUse());
    results.push(await testStatefulConversation());
    results.push(await testConcurrentToolUse());
    results.push(await testSlowToolHandler());

    const totalPass = results.reduce((s, r) => s + r.pass, 0);
    const totalFail = results.reduce((s, r) => s + r.fail, 0);
    const totalFallback = results.reduce((s, r) => s + r.fallback, 0);
    const total = totalPass + totalFail + totalFallback;

    console.log(`\n${"=".repeat(60)}`);
    console.log(`TOTAL: ${total} tests — ${totalPass} pass, ${totalFail} fail, ${totalFallback} fallback`);
    console.log(`${"=".repeat(60)}`);

    if (totalFail > 0 || totalFallback > 0) {
        console.log("\n⚠️  Session.idle issues detected!");
        process.exit(1);
    } else {
        console.log("\n✅ No session.idle issues detected across all stress tests.");
    }
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(2);
});
