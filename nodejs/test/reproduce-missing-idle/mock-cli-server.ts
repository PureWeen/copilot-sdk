/**
 * Mock CLI server that reproduces the missing session.idle bug.
 *
 * This script starts a TCP JSON-RPC server that mimics the Copilot CLI protocol
 * but deliberately omits `session.idle` after `assistant.turn_end`, simulating
 * the bug described in github/copilot-sdk#558.
 *
 * Usage (from the nodejs/ directory):
 *   npx tsx test/reproduce-missing-idle/mock-cli-server.ts [--omit-idle]
 *
 * By default it emits session.idle normally (happy path).
 * With --omit-idle it skips session.idle to reproduce the bug.
 */

import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import {
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
    type MessageConnection,
} from "vscode-jsonrpc/node.js";

const omitIdle = process.argv.includes("--omit-idle");

function makeEvent(
    type: string,
    data: Record<string, unknown>,
    opts?: { ephemeral?: boolean; parentId?: string | null },
): Record<string, unknown> {
    return {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        parentId: opts?.parentId ?? null,
        ephemeral: opts?.ephemeral ?? false,
        type,
        data,
    };
}

const server: Server = createServer((socket: Socket) => {
    const reader = new StreamMessageReader(socket);
    const writer = new StreamMessageWriter(socket);
    const connection: MessageConnection = createMessageConnection(reader, writer);

    // Respond to version negotiation — SDK calls ping() for protocol version
    connection.onRequest("ping", (params: Record<string, unknown>) => {
        return {
            message: (params as { message?: string }).message || "pong",
            timestamp: Date.now(),
            protocolVersion: 3,
        };
    });

    // Handle status request
    connection.onRequest("status.get", () => {
        return {
            version: "mock-1.0.0",
            protocolVersion: 3,
            authenticated: true,
        };
    });

    // Handle session creation
    connection.onRequest("session.create", (params: Record<string, unknown>) => {
        const sessionId = randomUUID();
        const model = (params as { model?: string }).model || "mock-model";

        // Send session.start event
        connection.sendNotification("session.event", {
            sessionId,
            event: makeEvent("session.start", { sessionId, selectedModel: model }),
        });

        // Immediately send idle for the initial state
        connection.sendNotification("session.event", {
            sessionId,
            event: makeEvent("session.idle", {}, { ephemeral: true }),
        });

        return { sessionId };
    });

    // Handle sending messages
    connection.onRequest("session.send", (params: Record<string, unknown>) => {
        const sessionId = params.sessionId as string;
        const messageId = randomUUID();

        // Simulate the CLI processing a message asynchronously
        setTimeout(() => {
            // 1. Send assistant.turn_start
            connection.sendNotification("session.event", {
                sessionId,
                event: makeEvent("assistant.turn_start", {}, { ephemeral: true }),
            });

            // 2. Send assistant.message (final)
            setTimeout(() => {
                connection.sendNotification("session.event", {
                    sessionId,
                    event: makeEvent("assistant.message", {
                        content: "The answer is 4.",
                        role: "assistant",
                    }),
                });

                // 3. Send assistant.turn_end
                setTimeout(() => {
                    connection.sendNotification("session.event", {
                        sessionId,
                        event: makeEvent("assistant.turn_end", {}, { ephemeral: true }),
                    });

                    // 4. Optionally send session.idle
                    if (!omitIdle) {
                        setTimeout(() => {
                            connection.sendNotification("session.event", {
                                sessionId,
                                event: makeEvent("session.idle", {}, { ephemeral: true }),
                            });
                            console.error("[mock-cli] Sent session.idle (normal path)");
                        }, 10);
                    } else {
                        console.error(
                            "[mock-cli] OMITTING session.idle (reproducing CLI bug)",
                        );
                    }
                }, 10);
            }, 10);
        }, 50);

        return { messageId };
    });

    // Handle session disconnect
    connection.onRequest("session.disconnect", () => {
        return {};
    });

    // Handle session destroy
    connection.onRequest("session.destroy", () => {
        return {};
    });

    // Handle getMessages
    connection.onRequest("session.getMessages", () => {
        return { messages: [] };
    });

    connection.listen();
    console.error("[mock-cli] Client connected, JSON-RPC active");
});

// Listen on a random port
server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    if (addr && typeof addr !== "string") {
        // Print the URL for the SDK to connect to
        console.log(`http://127.0.0.1:${addr.port}`);
        console.error(
            `[mock-cli] Listening on port ${addr.port} (omitIdle=${omitIdle})`,
        );
    }
});
