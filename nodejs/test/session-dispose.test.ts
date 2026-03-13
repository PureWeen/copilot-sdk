/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { CopilotSession } from "../src/session.js";
import type { SessionEvent } from "../src/types.js";

/**
 * Tests for the fix: permission callback binding lost after session disposal.
 *
 * Root cause: disposed sessions remained in the client's session map with a null
 * permission handler. In protocol v3 broadcast mode, permission.requested events
 * routed to disposed sessions were silently dropped (no RPC response), causing
 * the CLI to time out and deny with "denied-no-approval-rule-and-could-not-request-from-user".
 *
 * Fix: (1) remove disposed sessions from the map, (2) guard _dispatchEvent against
 * disposed sessions, (3) send an explicit denial when no handler is registered.
 */

function createMockConnection(): any {
    return {
        sendRequest: vi.fn().mockResolvedValue({}),
        sendNotification: vi.fn(),
        onRequest: vi.fn(),
        onNotification: vi.fn(),
        listen: vi.fn(),
        dispose: vi.fn(),
    };
}

describe("CopilotSession disposal", () => {
    it("sets _isDisposed flag on disconnect and ignores subsequent events", async () => {
        const conn = createMockConnection();
        const session = new CopilotSession("test-session", conn);
        session.registerPermissionHandler(async () => ({ kind: "approved" }));

        const events: SessionEvent[] = [];
        session.on((event) => events.push(event));

        // Disconnect the session
        await session.disconnect();

        // Dispatch an event after disconnect — should be ignored
        session._dispatchEvent({
            type: "assistant.message",
            data: { content: "Hello" },
        } as any);

        expect(events).toHaveLength(0);
    });

    it("invokes _onDisposed callback with sessionId on disconnect", async () => {
        const conn = createMockConnection();
        const session = new CopilotSession("sess-42", conn);
        session.registerPermissionHandler(async () => ({ kind: "approved" }));

        const removedIds: string[] = [];
        session._onDisposed = (id) => removedIds.push(id);

        await session.disconnect();

        expect(removedIds).toEqual(["sess-42"]);
    });

    it("sends explicit denial when permission.requested arrives with no handler", () => {
        const conn = createMockConnection();
        const session = new CopilotSession("test-session", conn);
        // Do NOT register a permission handler

        session._dispatchEvent({
            type: "permission.requested",
            data: {
                requestId: "req-1",
                permissionRequest: { type: "file_edit", path: "/tmp/test.txt" },
            },
        } as any);

        // The session should have called the RPC to send a denial
        // Give microtask a chance to execute the void promise
        return new Promise<void>((resolve) =>
            setTimeout(() => {
                expect(conn.sendRequest).toHaveBeenCalledWith(
                    "session.permissions.handlePendingPermissionRequest",
                    expect.objectContaining({
                        sessionId: "test-session",
                        requestId: "req-1",
                        result: {
                            kind: "denied-no-approval-rule-and-could-not-request-from-user",
                        },
                    })
                );
                resolve();
            }, 50)
        );
    });

    it("does not send denial when permission handler IS registered", () => {
        const conn = createMockConnection();
        const session = new CopilotSession("test-session", conn);
        session.registerPermissionHandler(async () => ({ kind: "approved" }));

        session._dispatchEvent({
            type: "permission.requested",
            data: {
                requestId: "req-2",
                permissionRequest: { type: "file_edit", path: "/tmp/test.txt" },
            },
        } as any);

        // Should call handlePendingPermissionRequest with "approved", not denial
        return new Promise<void>((resolve) =>
            setTimeout(() => {
                expect(conn.sendRequest).toHaveBeenCalledWith(
                    "session.permissions.handlePendingPermissionRequest",
                    expect.objectContaining({
                        result: expect.objectContaining({ kind: "approved" }),
                    })
                );
                resolve();
            }, 50)
        );
    });
});
