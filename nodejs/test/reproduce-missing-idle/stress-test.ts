/**
 * Aggressive stress test for session.idle with the real CLI.
 *
 * Runs many rapid-fire iterations, rapid sequential messages on the same session,
 * and concurrent sessions to try to trigger session.idle failures.
 *
 * Usage (from the nodejs/ directory):
 *   npx tsx test/reproduce-missing-idle/stress-test.ts
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

const MULTI_TURN_SNAPSHOT = `models:
  - claude-sonnet-4.5
conversations:
  - messages:
      - role: system
        content: \${system}
      - role: user
        content: What is 1+1?
      - role: assistant
        content: 1+1 = 2
      - role: user
        content: Now double that
      - role: assistant
        content: 2 doubled is 4.
      - role: user
        content: And triple the original?
      - role: assistant
        content: 1+1=2, tripled is 6.
      - role: user
        content: What about 10 times the original?
      - role: assistant
        content: 2 times 10 = 20.
      - role: user
        content: And 100 times?
      - role: assistant
        content: 2 times 100 = 200.
`;

interface ProxyHandle {
    url: string;
    proc: ChildProcess;
    tmpDir: string;
    snapshotPath: string;
}

async function startProxy(snapshot: string): Promise<ProxyHandle> {
    const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "stress-")));
    const snapshotDir = join(tmpDir, "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    const snapshotPath = join(snapshotDir, "test.yaml");
    writeFileSync(snapshotPath, snapshot);

    const proc = spawn("npx", ["tsx", HARNESS_SERVER_PATH], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
        cwd: resolve(__dirname, "../.."),
    });

    // Suppress noisy stderr except errors
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

    await fetch(`${url}/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            filePath: snapshotPath,
            workDir: tmpDir,
            testInfo: { file: "stress-test.ts", line: 1 },
        }),
    });

    return { url, proc, tmpDir, snapshotPath };
}

async function stopProxy(proxy: ProxyHandle): Promise<void> {
    try { await fetch(`${proxy.url}/stop?skipWritingCache=true`, { method: "POST" }); } catch {}
    proxy.proc.kill();
    await new Promise(r => setTimeout(r, 300));
    await rm(proxy.tmpDir, { recursive: true, force: true }).catch(() => {});
}

// ============================================================
// Test 1: Rapid single-message iterations (30 iterations)
// ============================================================
async function testRapidIterations(): Promise<{ pass: number; fail: number; fallback: number }> {
    console.log("\n--- Test 1: Rapid single-message iterations (30x) ---");

    const SIMPLE_SNAPSHOT = `models:\n  - claude-sonnet-4.5\nconversations:\n  - messages:\n      - role: system\n        content: \${system}\n      - role: user\n        content: hi\n      - role: assistant\n        content: hello\n`;

    let pass = 0, fail = 0, fallback = 0;

    for (let i = 0; i < 30; i++) {
        const proxy = await startProxy(SIMPLE_SNAPSHOT);
        const homeDir = realpathSync(mkdtempSync(join(tmpdir(), "h-")));
        const workDir = realpathSync(mkdtempSync(join(tmpdir(), "w-")));

        try {
            const client = new CopilotClient({
                cwd: workDir,
                env: { ...process.env, COPILOT_API_URL: proxy.url, XDG_CONFIG_HOME: homeDir, XDG_STATE_HOME: homeDir },
                logLevel: "error",
                githubToken: "fake-token",
            });

            const session = await client.createSession({ onPermissionRequest: approveAll });
            let gotTurnEnd = false;
            let gotIdle = false;
            let turnEndTs = 0;
            let idleTs = 0;

            session.on((event) => {
                if (event.type === "assistant.turn_end") { gotTurnEnd = true; turnEndTs = Date.now(); }
                if (event.type === "session.idle") { gotIdle = true; idleTs = Date.now(); }
            });

            const start = Date.now();
            try {
                await session.sendAndWait({ prompt: "hi" }, 15_000);
                const gap = gotTurnEnd && gotIdle ? idleTs - turnEndTs : -1;
                const elapsed = Date.now() - start;

                if (gap > 3000) {
                    fallback++;
                    process.stdout.write(`F`);
                } else {
                    pass++;
                    process.stdout.write(`.`);
                }
            } catch {
                fail++;
                process.stdout.write(`X`);
            }

            await session.disconnect().catch(() => {});
            await client.stop().catch(() => {});
        } finally {
            await stopProxy(proxy);
            await rm(homeDir, { recursive: true, force: true }).catch(() => {});
            await rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
    }

    console.log(`\n  Results: ${pass} pass, ${fail} fail, ${fallback} fallback`);
    return { pass, fail, fallback };
}

// ============================================================
// Test 2: Multi-turn on single session (5 messages back-to-back)
// ============================================================
async function testMultiTurn(): Promise<{ pass: number; fail: number; fallback: number }> {
    console.log("\n--- Test 2: Multi-turn conversation (5 messages, 3 iterations) ---");

    let pass = 0, fail = 0, fallback = 0;

    for (let iter = 0; iter < 3; iter++) {
        const proxy = await startProxy(MULTI_TURN_SNAPSHOT);
        const homeDir = realpathSync(mkdtempSync(join(tmpdir(), "h-")));
        const workDir = realpathSync(mkdtempSync(join(tmpdir(), "w-")));

        try {
            const client = new CopilotClient({
                cwd: workDir,
                env: { ...process.env, COPILOT_API_URL: proxy.url, XDG_CONFIG_HOME: homeDir, XDG_STATE_HOME: homeDir },
                logLevel: "error",
                githubToken: "fake-token",
            });

            const session = await client.createSession({ onPermissionRequest: approveAll });

            const prompts = [
                "What is 1+1?",
                "Now double that",
                "And triple the original?",
                "What about 10 times the original?",
                "And 100 times?",
            ];

            let iterFailed = false;
            for (const prompt of prompts) {
                let gotTurnEnd = false;
                let gotIdle = false;
                let turnEndTs = 0;
                let idleTs = 0;

                const unsub = session.on((event) => {
                    if (event.type === "assistant.turn_end") { gotTurnEnd = true; turnEndTs = Date.now(); }
                    if (event.type === "session.idle") { gotIdle = true; idleTs = Date.now(); }
                });

                // Reconfigure proxy snapshot for each turn
                await fetch(`${proxy.url}/config`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        filePath: proxy.snapshotPath,
                        workDir,
                        testInfo: { file: "stress-test.ts", line: 1 },
                    }),
                });

                try {
                    await session.sendAndWait({ prompt }, 15_000);
                    const gap = gotTurnEnd && gotIdle ? idleTs - turnEndTs : -1;

                    if (gap > 3000) {
                        fallback++;
                        process.stdout.write(`F`);
                        iterFailed = true;
                    } else {
                        pass++;
                        process.stdout.write(`.`);
                    }
                } catch {
                    fail++;
                    process.stdout.write(`X`);
                    iterFailed = true;
                }
                unsub();
            }

            await session.disconnect().catch(() => {});
            await client.stop().catch(() => {});
        } finally {
            await stopProxy(proxy);
            await rm(homeDir, { recursive: true, force: true }).catch(() => {});
            await rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
        process.stdout.write(` `);
    }

    console.log(`\n  Results: ${pass} pass, ${fail} fail, ${fallback} fallback`);
    return { pass, fail, fallback };
}

// ============================================================
// Test 3: Concurrent sessions (3 at once, 5 iterations)
// ============================================================
async function testConcurrentSessions(): Promise<{ pass: number; fail: number; fallback: number }> {
    console.log("\n--- Test 3: Concurrent sessions (3 at once, 5 iterations) ---");

    const SIMPLE_SNAPSHOT = `models:\n  - claude-sonnet-4.5\nconversations:\n  - messages:\n      - role: system\n        content: \${system}\n      - role: user\n        content: ping\n      - role: assistant\n        content: pong\n`;

    let pass = 0, fail = 0, fallback = 0;

    for (let iter = 0; iter < 5; iter++) {
        // Each concurrent session needs its own proxy (snapshot state is per-proxy)
        const proxies = await Promise.all([startProxy(SIMPLE_SNAPSHOT), startProxy(SIMPLE_SNAPSHOT), startProxy(SIMPLE_SNAPSHOT)]);

        const tasks = proxies.map(async (proxy, idx) => {
            const homeDir = realpathSync(mkdtempSync(join(tmpdir(), `h${idx}-`)));
            const workDir = realpathSync(mkdtempSync(join(tmpdir(), `w${idx}-`)));

            try {
                const client = new CopilotClient({
                    cwd: workDir,
                    env: { ...process.env, COPILOT_API_URL: proxy.url, XDG_CONFIG_HOME: homeDir, XDG_STATE_HOME: homeDir },
                    logLevel: "error",
                    githubToken: "fake-token",
                });

                const session = await client.createSession({ onPermissionRequest: approveAll });
                let gotTurnEnd = false;
                let gotIdle = false;
                let turnEndTs = 0;
                let idleTs = 0;

                session.on((event) => {
                    if (event.type === "assistant.turn_end") { gotTurnEnd = true; turnEndTs = Date.now(); }
                    if (event.type === "session.idle") { gotIdle = true; idleTs = Date.now(); }
                });

                try {
                    await session.sendAndWait({ prompt: "ping" }, 15_000);
                    const gap = gotTurnEnd && gotIdle ? idleTs - turnEndTs : -1;
                    return gap > 3000 ? "fallback" : "pass";
                } catch {
                    return "fail";
                } finally {
                    await session.disconnect().catch(() => {});
                    await client.stop().catch(() => {});
                }
            } finally {
                await stopProxy(proxy);
                await rm(homeDir, { recursive: true, force: true }).catch(() => {});
                await rm(workDir, { recursive: true, force: true }).catch(() => {});
            }
        });

        const results = await Promise.all(tasks);
        for (const r of results) {
            if (r === "pass") { pass++; process.stdout.write(`.`); }
            else if (r === "fallback") { fallback++; process.stdout.write(`F`); }
            else { fail++; process.stdout.write(`X`); }
        }
        process.stdout.write(` `);
    }

    console.log(`\n  Results: ${pass} pass, ${fail} fail, ${fallback} fallback`);
    return { pass, fail, fallback };
}

// ============================================================
// Main
// ============================================================
async function main(): Promise<void> {
    console.log("=== Aggressive session.idle Stress Test (Real CLI) ===");
    console.log(`Node: ${process.version} | PID: ${process.pid}`);

    const results = [];

    results.push(await testRapidIterations());
    results.push(await testMultiTurn());
    results.push(await testConcurrentSessions());

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
