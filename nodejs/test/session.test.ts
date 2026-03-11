/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi, afterEach } from "vitest";
import { CopilotSession } from "../src/session.js";
import type { SessionEvent } from "../src/types.js";

/**
 * Creates a minimal CopilotSession with a mock connection for unit testing.
 */
function createTestSession(idleFallbackDelayMs = 100): CopilotSession {
    const mockConnection = {} as any;
    const session = new CopilotSession("test-session", mockConnection);
    // Use a short grace period for fast tests
    session._idleFallbackDelayMs = idleFallbackDelayMs;
    return session;
}

function makeTurnEndEvent(): SessionEvent {
    return {
        id: "turn-end-1",
        timestamp: new Date().toISOString(),
        parentId: null,
        type: "assistant.turn_end",
        data: { turnId: "turn-1" },
    } as SessionEvent;
}

function makeIdleEvent(): SessionEvent {
    return {
        id: "idle-1",
        timestamp: new Date().toISOString(),
        parentId: null,
        ephemeral: true,
        type: "session.idle",
        data: {},
    } as SessionEvent;
}

function makeAssistantMessageEvent(): SessionEvent {
    return {
        id: "msg-1",
        timestamp: new Date().toISOString(),
        parentId: null,
        type: "assistant.message",
        data: { content: "Hello", role: "assistant" },
    } as SessionEvent;
}

describe("CopilotSession idle fallback", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("synthesizes session.idle when turn_end arrives without idle", async () => {
        vi.useFakeTimers();
        const session = createTestSession(200);
        const events: string[] = [];

        session.on((event) => {
            events.push(event.type);
        });

        // Dispatch turn_end without idle
        session._dispatchEvent(makeTurnEndEvent());
        expect(events).toEqual(["assistant.turn_end"]);

        // Advance time past the grace period
        vi.advanceTimersByTime(200);

        // A synthetic session.idle should have been dispatched
        expect(events).toEqual(["assistant.turn_end", "session.idle"]);
    });

    it("does not synthesize idle when real idle arrives in time", async () => {
        vi.useFakeTimers();
        const session = createTestSession(200);
        const events: string[] = [];

        session.on((event) => {
            events.push(event.type);
        });

        session._dispatchEvent(makeTurnEndEvent());
        expect(events).toEqual(["assistant.turn_end"]);

        // Real idle arrives before grace period expires
        vi.advanceTimersByTime(50);
        session._dispatchEvent(makeIdleEvent());
        expect(events).toEqual(["assistant.turn_end", "session.idle"]);

        // Advance past grace period — no duplicate idle should appear
        vi.advanceTimersByTime(200);
        expect(events).toEqual(["assistant.turn_end", "session.idle"]);
    });

    it("resets fallback timer on subsequent turn_end", async () => {
        vi.useFakeTimers();
        const session = createTestSession(200);
        const events: string[] = [];

        session.on((event) => {
            events.push(event.type);
        });

        session._dispatchEvent(makeTurnEndEvent());
        vi.advanceTimersByTime(100); // Half the grace period

        // Another turn_end arrives — should reset the timer
        session._dispatchEvent(makeTurnEndEvent());
        vi.advanceTimersByTime(100); // 100ms after second turn_end, still within new grace period
        expect(events).toEqual(["assistant.turn_end", "assistant.turn_end"]);

        // Now advance to fire the timer
        vi.advanceTimersByTime(100);
        expect(events).toEqual(["assistant.turn_end", "assistant.turn_end", "session.idle"]);
    });

    it("disconnect cancels pending fallback timer", async () => {
        vi.useFakeTimers();
        const session = createTestSession(200);
        const events: string[] = [];

        session.on((event) => {
            events.push(event.type);
        });

        // Start the fallback timer
        session._dispatchEvent(makeTurnEndEvent());
        expect(events).toEqual(["assistant.turn_end"]);

        // Mock the RPC call so disconnect() doesn't throw
        (session as any).connection = { sendRequest: vi.fn().mockResolvedValue({}) };
        await session.disconnect();

        // Advance past the grace period — no synthetic idle should fire
        vi.advanceTimersByTime(300);
        expect(events).toEqual(["assistant.turn_end"]);
    });

    it("sendAndWait resolves via synthetic idle when CLI omits session.idle", async () => {
        vi.useFakeTimers();
        const session = createTestSession(100);

        // Mock the send method
        const mockSendRequest = vi.fn().mockResolvedValue({ messageId: "msg-1" });
        (session as any).connection = { sendRequest: mockSendRequest };

        const promise = session.sendAndWait({ prompt: "test" }, 10_000);

        // Simulate the CLI sending events but omitting session.idle
        await vi.advanceTimersByTimeAsync(0); // let send() resolve
        session._dispatchEvent(makeAssistantMessageEvent());
        session._dispatchEvent(makeTurnEndEvent());

        // Advance past the idle fallback grace period
        await vi.advanceTimersByTimeAsync(100);

        const result = await promise;
        expect(result).toBeDefined();
        expect(result!.type).toBe("assistant.message");
    });
});
