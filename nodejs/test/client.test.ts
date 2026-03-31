/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { approveAll, CopilotClient, type ModelInfo } from "../src/index.js";

// This file is for unit tests. Where relevant, prefer to add e2e tests in e2e/*.test.ts instead

describe("CopilotClient", () => {
    it("throws when createSession is called without onPermissionRequest", async () => {
        const client = new CopilotClient();
        await client.start();
        onTestFinished(() => client.forceStop());

        await expect((client as any).createSession({})).rejects.toThrow(
            /onPermissionRequest.*is required/
        );
    });

    it("throws when resumeSession is called without onPermissionRequest", async () => {
        const client = new CopilotClient();
        await client.start();
        onTestFinished(() => client.forceStop());

        const session = await client.createSession({ onPermissionRequest: approveAll });
        await expect((client as any).resumeSession(session.sessionId, {})).rejects.toThrow(
            /onPermissionRequest.*is required/
        );
    });

    it("does not respond to v3 permission requests when handler returns no-result", async () => {
        const client = new CopilotClient();
        await client.start();
        onTestFinished(() => client.forceStop());

        const session = await client.createSession({
            onPermissionRequest: () => ({ kind: "no-result" }),
        });
        const spy = vi.spyOn(session.rpc.permissions, "handlePendingPermissionRequest");

        await (session as any)._executePermissionAndRespond("request-1", { kind: "write" });

        expect(spy).not.toHaveBeenCalled();
    });

    it("throws when a v2 permission handler returns no-result", async () => {
        const client = new CopilotClient();
        await client.start();
        onTestFinished(() => client.forceStop());

        const session = await client.createSession({
            onPermissionRequest: () => ({ kind: "no-result" }),
        });

        await expect(
            (client as any).handlePermissionRequestV2({
                sessionId: session.sessionId,
                permissionRequest: { kind: "write" },
            })
        ).rejects.toThrow(/protocol v2 server/);
    });

    it("forwards clientName in session.create request", async () => {
        const client = new CopilotClient();
        await client.start();
        onTestFinished(() => client.forceStop());

        const spy = vi.spyOn((client as any).connection!, "sendRequest");
        await client.createSession({ clientName: "my-app", onPermissionRequest: approveAll });

        expect(spy).toHaveBeenCalledWith(
            "session.create",
            expect.objectContaining({ clientName: "my-app" })
        );
    });

    it("forwards clientName in session.resume request", async () => {
        const client = new CopilotClient();
        await client.start();
        onTestFinished(() => client.forceStop());

        const session = await client.createSession({ onPermissionRequest: approveAll });
        // Mock sendRequest to capture the call without hitting the runtime
        const spy = vi
            .spyOn((client as any).connection!, "sendRequest")
            .mockImplementation(async (method: string, params: any) => {
                if (method === "session.resume") return { sessionId: params.sessionId };
                throw new Error(`Unexpected method: ${method}`);
            });
        await client.resumeSession(session.sessionId, {
            clientName: "my-app",
            onPermissionRequest: approveAll,
        });

        expect(spy).toHaveBeenCalledWith(
            "session.resume",
            expect.objectContaining({ clientName: "my-app", sessionId: session.sessionId })
        );
        spy.mockRestore();
    });

    it("sends session.model.switchTo RPC with correct params", async () => {
        const client = new CopilotClient();
        await client.start();
        onTestFinished(() => client.forceStop());

        const session = await client.createSession({ onPermissionRequest: approveAll });

        // Mock sendRequest to capture the call without hitting the runtime
        const spy = vi
            .spyOn((client as any).connection!, "sendRequest")
            .mockImplementation(async (method: string, _params: any) => {
                if (method === "session.model.switchTo") return {};
                // Fall through for other methods (shouldn't be called)
                throw new Error(`Unexpected method: ${method}`);
            });

        await session.setModel("gpt-4.1");

        expect(spy).toHaveBeenCalledWith("session.model.switchTo", {
            sessionId: session.sessionId,
            modelId: "gpt-4.1",
        });

        spy.mockRestore();
    });

    it("sends reasoningEffort with session.model.switchTo when provided", async () => {
        const client = new CopilotClient();
        await client.start();
        onTestFinished(() => client.forceStop());

        const session = await client.createSession({ onPermissionRequest: approveAll });

        const spy = vi
            .spyOn((client as any).connection!, "sendRequest")
            .mockImplementation(async (method: string, _params: any) => {
                if (method === "session.model.switchTo") return {};
                throw new Error(`Unexpected method: ${method}`);
            });

        await session.setModel("claude-sonnet-4.6", { reasoningEffort: "high" });

        expect(spy).toHaveBeenCalledWith("session.model.switchTo", {
            sessionId: session.sessionId,
            modelId: "claude-sonnet-4.6",
            reasoningEffort: "high",
        });

        spy.mockRestore();
    });

    describe("URL parsing", () => {
        it("should parse port-only URL format", () => {
            const client = new CopilotClient({
                cliUrl: "8080",
                logLevel: "error",
            });

            // Verify internal state
            expect((client as any).actualPort).toBe(8080);
            expect((client as any).actualHost).toBe("localhost");
            expect((client as any).isExternalServer).toBe(true);
        });

        it("should parse host:port URL format", () => {
            const client = new CopilotClient({
                cliUrl: "127.0.0.1:9000",
                logLevel: "error",
            });

            expect((client as any).actualPort).toBe(9000);
            expect((client as any).actualHost).toBe("127.0.0.1");
            expect((client as any).isExternalServer).toBe(true);
        });

        it("should parse http://host:port URL format", () => {
            const client = new CopilotClient({
                cliUrl: "http://localhost:7000",
                logLevel: "error",
            });

            expect((client as any).actualPort).toBe(7000);
            expect((client as any).actualHost).toBe("localhost");
            expect((client as any).isExternalServer).toBe(true);
        });

        it("should parse https://host:port URL format", () => {
            const client = new CopilotClient({
                cliUrl: "https://example.com:443",
                logLevel: "error",
            });

            expect((client as any).actualPort).toBe(443);
            expect((client as any).actualHost).toBe("example.com");
            expect((client as any).isExternalServer).toBe(true);
        });

        it("should throw error for invalid URL format", () => {
            expect(() => {
                new CopilotClient({
                    cliUrl: "invalid-url",
                    logLevel: "error",
                });
            }).toThrow(/Invalid cliUrl format/);
        });

        it("should throw error for invalid port - too high", () => {
            expect(() => {
                new CopilotClient({
                    cliUrl: "localhost:99999",
                    logLevel: "error",
                });
            }).toThrow(/Invalid port in cliUrl/);
        });

        it("should throw error for invalid port - zero", () => {
            expect(() => {
                new CopilotClient({
                    cliUrl: "localhost:0",
                    logLevel: "error",
                });
            }).toThrow(/Invalid port in cliUrl/);
        });

        it("should throw error for invalid port - negative", () => {
            expect(() => {
                new CopilotClient({
                    cliUrl: "localhost:-1",
                    logLevel: "error",
                });
            }).toThrow(/Invalid port in cliUrl/);
        });

        it("should throw error when cliUrl is used with useStdio", () => {
            expect(() => {
                new CopilotClient({
                    cliUrl: "localhost:8080",
                    useStdio: true,
                    logLevel: "error",
                });
            }).toThrow(/cliUrl is mutually exclusive/);
        });

        it("should throw error when cliUrl is used with cliPath", () => {
            expect(() => {
                new CopilotClient({
                    cliUrl: "localhost:8080",
                    cliPath: "/path/to/cli",
                    logLevel: "error",
                });
            }).toThrow(/cliUrl is mutually exclusive/);
        });

        it("should set useStdio to false when cliUrl is provided", () => {
            const client = new CopilotClient({
                cliUrl: "8080",
                logLevel: "error",
            });

            expect(client["options"].useStdio).toBe(false);
        });

        it("should mark client as using external server", () => {
            const client = new CopilotClient({
                cliUrl: "localhost:8080",
                logLevel: "error",
            });

            expect((client as any).isExternalServer).toBe(true);
        });

        it("should not resolve cliPath when cliUrl is provided", () => {
            const client = new CopilotClient({
                cliUrl: "localhost:8080",
                logLevel: "error",
            });

            expect(client["options"].cliPath).toBeUndefined();
        });
    });

    describe("Auth options", () => {
        it("should accept githubToken option", () => {
            const client = new CopilotClient({
                githubToken: "gho_test_token",
                logLevel: "error",
            });

            expect((client as any).options.githubToken).toBe("gho_test_token");
        });

        it("should default useLoggedInUser to true when no githubToken", () => {
            const client = new CopilotClient({
                logLevel: "error",
            });

            expect((client as any).options.useLoggedInUser).toBe(true);
        });

        it("should default useLoggedInUser to false when githubToken is provided", () => {
            const client = new CopilotClient({
                githubToken: "gho_test_token",
                logLevel: "error",
            });

            expect((client as any).options.useLoggedInUser).toBe(false);
        });

        it("should allow explicit useLoggedInUser: true with githubToken", () => {
            const client = new CopilotClient({
                githubToken: "gho_test_token",
                useLoggedInUser: true,
                logLevel: "error",
            });

            expect((client as any).options.useLoggedInUser).toBe(true);
        });

        it("should allow explicit useLoggedInUser: false without githubToken", () => {
            const client = new CopilotClient({
                useLoggedInUser: false,
                logLevel: "error",
            });

            expect((client as any).options.useLoggedInUser).toBe(false);
        });

        it("should throw error when githubToken is used with cliUrl", () => {
            expect(() => {
                new CopilotClient({
                    cliUrl: "localhost:8080",
                    githubToken: "gho_test_token",
                    logLevel: "error",
                });
            }).toThrow(/githubToken and useLoggedInUser cannot be used with cliUrl/);
        });

        it("should throw error when useLoggedInUser is used with cliUrl", () => {
            expect(() => {
                new CopilotClient({
                    cliUrl: "localhost:8080",
                    useLoggedInUser: false,
                    logLevel: "error",
                });
            }).toThrow(/githubToken and useLoggedInUser cannot be used with cliUrl/);
        });
    });

    describe("overridesBuiltInTool in tool definitions", () => {
        it("sends overridesBuiltInTool in tool definition on session.create", async () => {
            const client = new CopilotClient();
            await client.start();
            onTestFinished(() => client.forceStop());

            const spy = vi.spyOn((client as any).connection!, "sendRequest");
            await client.createSession({
                onPermissionRequest: approveAll,
                tools: [
                    {
                        name: "grep",
                        description: "custom grep",
                        handler: async () => "ok",
                        overridesBuiltInTool: true,
                    },
                ],
            });

            const payload = spy.mock.calls.find((c) => c[0] === "session.create")![1] as any;
            expect(payload.tools).toEqual([
                expect.objectContaining({ name: "grep", overridesBuiltInTool: true }),
            ]);
        });

        it("sends overridesBuiltInTool in tool definition on session.resume", async () => {
            const client = new CopilotClient();
            await client.start();
            onTestFinished(() => client.forceStop());

            const session = await client.createSession({ onPermissionRequest: approveAll });
            // Mock sendRequest to capture the call without hitting the runtime
            const spy = vi
                .spyOn((client as any).connection!, "sendRequest")
                .mockImplementation(async (method: string, params: any) => {
                    if (method === "session.resume") return { sessionId: params.sessionId };
                    throw new Error(`Unexpected method: ${method}`);
                });
            await client.resumeSession(session.sessionId, {
                onPermissionRequest: approveAll,
                tools: [
                    {
                        name: "grep",
                        description: "custom grep",
                        handler: async () => "ok",
                        overridesBuiltInTool: true,
                    },
                ],
            });

            const payload = spy.mock.calls.find((c) => c[0] === "session.resume")![1] as any;
            expect(payload.tools).toEqual([
                expect.objectContaining({ name: "grep", overridesBuiltInTool: true }),
            ]);
            spy.mockRestore();
        });
    });

    describe("agent parameter in session creation", () => {
        it("forwards agent in session.create request", async () => {
            const client = new CopilotClient();
            await client.start();
            onTestFinished(() => client.forceStop());

            const spy = vi.spyOn((client as any).connection!, "sendRequest");
            await client.createSession({
                onPermissionRequest: approveAll,
                customAgents: [
                    {
                        name: "test-agent",
                        prompt: "You are a test agent.",
                    },
                ],
                agent: "test-agent",
            });

            const payload = spy.mock.calls.find((c) => c[0] === "session.create")![1] as any;
            expect(payload.agent).toBe("test-agent");
            expect(payload.customAgents).toEqual([expect.objectContaining({ name: "test-agent" })]);
        });

        it("forwards agent in session.resume request", async () => {
            const client = new CopilotClient();
            await client.start();
            onTestFinished(() => client.forceStop());

            const session = await client.createSession({ onPermissionRequest: approveAll });
            const spy = vi
                .spyOn((client as any).connection!, "sendRequest")
                .mockImplementation(async (method: string, params: any) => {
                    if (method === "session.resume") return { sessionId: params.sessionId };
                    throw new Error(`Unexpected method: ${method}`);
                });
            await client.resumeSession(session.sessionId, {
                onPermissionRequest: approveAll,
                customAgents: [
                    {
                        name: "test-agent",
                        prompt: "You are a test agent.",
                    },
                ],
                agent: "test-agent",
            });

            const payload = spy.mock.calls.find((c) => c[0] === "session.resume")![1] as any;
            expect(payload.agent).toBe("test-agent");
            spy.mockRestore();
        });
    });

    describe("onListModels", () => {
        it("calls onListModels handler instead of RPC when provided", async () => {
            const customModels: ModelInfo[] = [
                {
                    id: "my-custom-model",
                    name: "My Custom Model",
                    capabilities: {
                        supports: { vision: false, reasoningEffort: false },
                        limits: { max_context_window_tokens: 128000 },
                    },
                },
            ];

            const handler = vi.fn().mockReturnValue(customModels);
            const client = new CopilotClient({ onListModels: handler });
            await client.start();
            onTestFinished(() => client.forceStop());

            const models = await client.listModels();
            expect(handler).toHaveBeenCalledTimes(1);
            expect(models).toEqual(customModels);
        });

        it("caches onListModels results on subsequent calls", async () => {
            const customModels: ModelInfo[] = [
                {
                    id: "cached-model",
                    name: "Cached Model",
                    capabilities: {
                        supports: { vision: false, reasoningEffort: false },
                        limits: { max_context_window_tokens: 128000 },
                    },
                },
            ];

            const handler = vi.fn().mockReturnValue(customModels);
            const client = new CopilotClient({ onListModels: handler });
            await client.start();
            onTestFinished(() => client.forceStop());

            await client.listModels();
            await client.listModels();
            expect(handler).toHaveBeenCalledTimes(1); // Only called once due to caching
        });

        it("supports async onListModels handler", async () => {
            const customModels: ModelInfo[] = [
                {
                    id: "async-model",
                    name: "Async Model",
                    capabilities: {
                        supports: { vision: false, reasoningEffort: false },
                        limits: { max_context_window_tokens: 128000 },
                    },
                },
            ];

            const handler = vi.fn().mockResolvedValue(customModels);
            const client = new CopilotClient({ onListModels: handler });
            await client.start();
            onTestFinished(() => client.forceStop());

            const models = await client.listModels();
            expect(models).toEqual(customModels);
        });

        it("does not require client.start when onListModels is provided", async () => {
            const customModels: ModelInfo[] = [
                {
                    id: "no-start-model",
                    name: "No Start Model",
                    capabilities: {
                        supports: { vision: false, reasoningEffort: false },
                        limits: { max_context_window_tokens: 128000 },
                    },
                },
            ];

            const handler = vi.fn().mockReturnValue(customModels);
            const client = new CopilotClient({ onListModels: handler });

            const models = await client.listModels();
            expect(handler).toHaveBeenCalledTimes(1);
            expect(models).toEqual(customModels);
        });
    });

    describe("unexpected disconnection", () => {
        it("transitions to disconnected when child process is killed", async () => {
            const client = new CopilotClient();
            await client.start();
            onTestFinished(() => client.forceStop());

            expect(client.getState()).toBe("connected");

            // Kill the child process to simulate unexpected termination
            const proc = (client as any).cliProcess as import("node:child_process").ChildProcess;
            proc.kill();

            // Wait for the connection.onClose handler to fire
            await vi.waitFor(() => {
                expect(client.getState()).toBe("disconnected");
            });
        });
    });

    describe("onGetTraceContext", () => {
        it("includes trace context from callback in session.create request", async () => {
            const traceContext = {
                traceparent: "00-abcdef1234567890abcdef1234567890-1234567890abcdef-01",
                tracestate: "vendor=opaque",
            };
            const provider = vi.fn().mockReturnValue(traceContext);
            const client = new CopilotClient({ onGetTraceContext: provider });
            await client.start();
            onTestFinished(() => client.forceStop());

            const spy = vi.spyOn((client as any).connection!, "sendRequest");
            await client.createSession({ onPermissionRequest: approveAll });

            expect(provider).toHaveBeenCalled();
            expect(spy).toHaveBeenCalledWith(
                "session.create",
                expect.objectContaining({
                    traceparent: "00-abcdef1234567890abcdef1234567890-1234567890abcdef-01",
                    tracestate: "vendor=opaque",
                })
            );
        });

        it("includes trace context from callback in session.resume request", async () => {
            const traceContext = {
                traceparent: "00-abcdef1234567890abcdef1234567890-1234567890abcdef-01",
            };
            const provider = vi.fn().mockReturnValue(traceContext);
            const client = new CopilotClient({ onGetTraceContext: provider });
            await client.start();
            onTestFinished(() => client.forceStop());

            const session = await client.createSession({ onPermissionRequest: approveAll });
            const spy = vi
                .spyOn((client as any).connection!, "sendRequest")
                .mockImplementation(async (method: string, params: any) => {
                    if (method === "session.resume") return { sessionId: params.sessionId };
                    throw new Error(`Unexpected method: ${method}`);
                });
            await client.resumeSession(session.sessionId, { onPermissionRequest: approveAll });

            expect(spy).toHaveBeenCalledWith(
                "session.resume",
                expect.objectContaining({
                    traceparent: "00-abcdef1234567890abcdef1234567890-1234567890abcdef-01",
                })
            );
        });

        it("includes trace context from callback in session.send request", async () => {
            const traceContext = {
                traceparent: "00-fedcba0987654321fedcba0987654321-abcdef1234567890-01",
            };
            const provider = vi.fn().mockReturnValue(traceContext);
            const client = new CopilotClient({ onGetTraceContext: provider });
            await client.start();
            onTestFinished(() => client.forceStop());

            const session = await client.createSession({ onPermissionRequest: approveAll });
            const spy = vi
                .spyOn((client as any).connection!, "sendRequest")
                .mockImplementation(async (method: string) => {
                    if (method === "session.send") return { responseId: "r1" };
                    throw new Error(`Unexpected method: ${method}`);
                });
            await session.send({ prompt: "hello" });

            expect(spy).toHaveBeenCalledWith(
                "session.send",
                expect.objectContaining({
                    traceparent: "00-fedcba0987654321fedcba0987654321-abcdef1234567890-01",
                })
            );
        });

        it("does not include trace context when no callback is provided", async () => {
            const client = new CopilotClient();
            await client.start();
            onTestFinished(() => client.forceStop());

            const spy = vi.spyOn((client as any).connection!, "sendRequest");
            await client.createSession({ onPermissionRequest: approveAll });

            const [, params] = spy.mock.calls.find(([method]) => method === "session.create")!;
            expect(params.traceparent).toBeUndefined();
            expect(params.tracestate).toBeUndefined();
        });
    });

    describe("commands", () => {
        it("forwards commands in session.create RPC", async () => {
            const client = new CopilotClient();
            await client.start();
            onTestFinished(() => client.forceStop());

            const spy = vi.spyOn((client as any).connection!, "sendRequest");
            await client.createSession({
                onPermissionRequest: approveAll,
                commands: [
                    { name: "deploy", description: "Deploy the app", handler: async () => {} },
                    { name: "rollback", handler: async () => {} },
                ],
            });

            const payload = spy.mock.calls.find((c) => c[0] === "session.create")![1] as any;
            expect(payload.commands).toEqual([
                { name: "deploy", description: "Deploy the app" },
                { name: "rollback", description: undefined },
            ]);
        });

        it("forwards commands in session.resume RPC", async () => {
            const client = new CopilotClient();
            await client.start();
            onTestFinished(() => client.forceStop());

            const session = await client.createSession({ onPermissionRequest: approveAll });
            const spy = vi
                .spyOn((client as any).connection!, "sendRequest")
                .mockImplementation(async (method: string, params: any) => {
                    if (method === "session.resume") return { sessionId: params.sessionId };
                    throw new Error(`Unexpected method: ${method}`);
                });
            await client.resumeSession(session.sessionId, {
                onPermissionRequest: approveAll,
                commands: [{ name: "deploy", description: "Deploy", handler: async () => {} }],
            });

            const payload = spy.mock.calls.find((c) => c[0] === "session.resume")![1] as any;
            expect(payload.commands).toEqual([{ name: "deploy", description: "Deploy" }]);
            spy.mockRestore();
        });

        it("routes command.execute event to the correct handler", async () => {
            const client = new CopilotClient();
            await client.start();
            onTestFinished(() => client.forceStop());

            const handler = vi.fn();
            const session = await client.createSession({
                onPermissionRequest: approveAll,
                commands: [{ name: "deploy", handler }],
            });

            // Mock the RPC response so handlePendingCommand doesn't fail
            const rpcSpy = vi
                .spyOn((client as any).connection!, "sendRequest")
                .mockImplementation(async (method: string) => {
                    if (method === "session.commands.handlePendingCommand")
                        return { success: true };
                    throw new Error(`Unexpected method: ${method}`);
                });

            // Simulate a command.execute event
            (session as any)._dispatchEvent({
                id: "evt-1",
                timestamp: new Date().toISOString(),
                parentId: null,
                ephemeral: true,
                type: "command.execute",
                data: {
                    requestId: "req-1",
                    command: "/deploy production",
                    commandName: "deploy",
                    args: "production",
                },
            });

            // Wait for the async handler to complete
            await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
            expect(handler).toHaveBeenCalledWith(
                expect.objectContaining({
                    sessionId: session.sessionId,
                    command: "/deploy production",
                    commandName: "deploy",
                    args: "production",
                })
            );

            // Verify handlePendingCommand was called with the requestId
            expect(rpcSpy).toHaveBeenCalledWith(
                "session.commands.handlePendingCommand",
                expect.objectContaining({ requestId: "req-1" })
            );
            rpcSpy.mockRestore();
        });

        it("sends error when command handler throws", async () => {
            const client = new CopilotClient();
            await client.start();
            onTestFinished(() => client.forceStop());

            const session = await client.createSession({
                onPermissionRequest: approveAll,
                commands: [
                    {
                        name: "fail",
                        handler: () => {
                            throw new Error("deploy failed");
                        },
                    },
                ],
            });

            const rpcSpy = vi
                .spyOn((client as any).connection!, "sendRequest")
                .mockImplementation(async (method: string) => {
                    if (method === "session.commands.handlePendingCommand")
                        return { success: true };
                    throw new Error(`Unexpected method: ${method}`);
                });

            (session as any)._dispatchEvent({
                id: "evt-2",
                timestamp: new Date().toISOString(),
                parentId: null,
                ephemeral: true,
                type: "command.execute",
                data: {
                    requestId: "req-2",
                    command: "/fail",
                    commandName: "fail",
                    args: "",
                },
            });

            await vi.waitFor(() =>
                expect(rpcSpy).toHaveBeenCalledWith(
                    "session.commands.handlePendingCommand",
                    expect.objectContaining({ requestId: "req-2", error: "deploy failed" })
                )
            );
            rpcSpy.mockRestore();
        });

        it("sends error for unknown command", async () => {
            const client = new CopilotClient();
            await client.start();
            onTestFinished(() => client.forceStop());

            const session = await client.createSession({
                onPermissionRequest: approveAll,
                commands: [{ name: "deploy", handler: async () => {} }],
            });

            const rpcSpy = vi
                .spyOn((client as any).connection!, "sendRequest")
                .mockImplementation(async (method: string) => {
                    if (method === "session.commands.handlePendingCommand")
                        return { success: true };
                    throw new Error(`Unexpected method: ${method}`);
                });

            (session as any)._dispatchEvent({
                id: "evt-3",
                timestamp: new Date().toISOString(),
                parentId: null,
                ephemeral: true,
                type: "command.execute",
                data: {
                    requestId: "req-3",
                    command: "/unknown",
                    commandName: "unknown",
                    args: "",
                },
            });

            await vi.waitFor(() =>
                expect(rpcSpy).toHaveBeenCalledWith(
                    "session.commands.handlePendingCommand",
                    expect.objectContaining({
                        requestId: "req-3",
                        error: expect.stringContaining("Unknown command"),
                    })
                )
            );
            rpcSpy.mockRestore();
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // env option -- merge semantics (consistent with .NET and Python SDKs)
    //
    // SDK behavior (client.ts constructor):
    //   const effectiveEnv = options.env ? { ...process.env, ...options.env } : process.env;
    //
    //   - options.env is undefined  → effectiveEnv is process.env (by reference)
    //   - options.env is a dict     → effectiveEnv is process.env MERGED WITH options.env
    //                                 (user keys override, all inherited vars stay)
    //
    // This matches .NET (Environment merge-override) and Python (dict(os.environ) + update).
    //
    // Context for Issue #441:
    //   The .NET SDK had a bug where startInfo.Environment.Clear() wiped PATH and all other
    //   inherited vars when the user provided even ONE custom env key.  After fixing that,
    //   we aligned Node.js and Python to the same merge semantics so that providing a
    //   partial dict (e.g. { COPILOT_API_URL: "..." }) works correctly in all SDKs.
    // ─────────────────────────────────────────────────────────────────────────
    describe("env option", () => {
        it("uses process.env by reference when env is not specified", async () => {
            // When env is omitted, effectiveEnv = process.env (falsy branch of ternary).
            // The CLI subprocess inherits everything from the parent process.
            const client = new CopilotClient({ logLevel: "error" });
            await client.start();
            onTestFinished(() => client.forceStop());

            // Internal options.env should be the same process.env reference
            expect((client as any).options.env).toBe(process.env);
        });

        it("merges provided env keys into process.env (does not replace entirely)", async () => {
            // When an explicit env dict is provided, the SDK creates a merged object:
            //   { ...process.env, ...options.env }
            // This means PATH, HOME, and all other inherited variables are preserved
            // while the user's keys override or add to them.
            //
            // The test harness pattern (sdkTestContext.ts) spreads process.env anyway:
            //   { ...process.env, COPILOT_API_URL: proxyUrl, ... }
            // Under merge semantics this becomes:
            //   { ...process.env, ...{ ...process.env, COPILOT_API_URL: proxyUrl } }
            //   = { ...process.env, COPILOT_API_URL: proxyUrl }   ← same result, backward-compatible.
            const customEnv = { MY_CUSTOM_SDK_VAR: "hello" } as Record<string, string>;
            const client = new CopilotClient({ env: customEnv, logLevel: "error" });

            // The stored env is the MERGED result, not the original customEnv object
            const storedEnv = (client as any).options.env as Record<string, string | undefined>;
            expect(storedEnv).not.toBe(customEnv); // it's a new merged object
            expect(storedEnv["MY_CUSTOM_SDK_VAR"]).toBe("hello"); // user key is present
            expect(storedEnv["PATH"]).toBe(process.env["PATH"]); // inherited key is preserved
        });

        it("starts and pings successfully when env is undefined (inherits process.env)", async () => {
            // Regression guard: omitting env must not break the client.
            const client = new CopilotClient({ logLevel: "error" });
            await client.start();
            onTestFinished(() => client.forceStop());

            const pong = await client.ping("env-undefined");
            expect(pong.message).toBe("pong: env-undefined");
        });

        it("starts and pings successfully when env is a partial dict with one custom key", async () => {
            // Core merge-semantics test: providing just { MY_VAR: "value" } keeps PATH
            // and all other inherited vars, so the CLI subprocess starts normally.
            // Before the Issue #441 fix, this pattern would have crashed the CLI in .NET.
            // After aligning all SDKs, it works correctly everywhere.
            const client = new CopilotClient({
                env: { SDK_ENV_TEST_CUSTOM: "test_value" },
                logLevel: "error",
            });
            await client.start();
            onTestFinished(() => client.forceStop());

            const pong = await client.ping("env-partial-dict");
            expect(pong.message).toBe("pong: env-partial-dict");
        });

        it("starts and pings successfully when env is a full copy of process.env plus a custom key", async () => {
            // The test-harness spread pattern still works under merge semantics.
            // { ...process.env, MY_KEY: "val" } merged with process.env = same dict.
            const client = new CopilotClient({
                env: {
                    ...process.env,
                    SDK_ENV_TEST_CUSTOM: "test_value",
                } as Record<string, string | undefined>,
                logLevel: "error",
            });
            await client.start();
            onTestFinished(() => client.forceStop());

            const pong = await client.ping("env-spread-plus-custom");
            expect(pong.message).toBe("pong: env-spread-plus-custom");
        });

        it("NODE_DEBUG is stripped from merged env before spawning the CLI subprocess", async () => {
            // The SDK always removes NODE_DEBUG from the effective env before spawn so it
            // cannot corrupt the JSON-RPC message stream (CLI stdout).
            const client = new CopilotClient({
                env: { NODE_DEBUG: "http,net" } as Record<string, string | undefined>,
                logLevel: "error",
            });
            await client.start();
            onTestFinished(() => client.forceStop());

            // The merged env stored in options.env contains NODE_DEBUG (from our override)
            const storedEnv = (client as any).options.env as Record<string, string | undefined>;
            expect(storedEnv["NODE_DEBUG"]).toBe("http,net");

            // But the CLI starts fine because startCLIServer removes NODE_DEBUG before spawn
            const pong = await client.ping("node-debug-stripped");
            expect(pong.message).toBe("pong: node-debug-stripped");
        });
    });

    describe("ui elicitation", () => {
        it("reads capabilities from session.create response", async () => {
            const client = new CopilotClient();
            await client.start();
            onTestFinished(() => client.forceStop());

            // Intercept session.create to inject capabilities
            const origSendRequest = (client as any).connection!.sendRequest.bind(
                (client as any).connection
            );
            vi.spyOn((client as any).connection!, "sendRequest").mockImplementation(
                async (method: string, params: any) => {
                    if (method === "session.create") {
                        const result = await origSendRequest(method, params);
                        return {
                            ...result,
                            capabilities: { ui: { elicitation: true } },
                        };
                    }
                    return origSendRequest(method, params);
                }
            );

            const session = await client.createSession({ onPermissionRequest: approveAll });
            expect(session.capabilities).toEqual({ ui: { elicitation: true } });
        });

        it("defaults capabilities when not injected", async () => {
            const client = new CopilotClient();
            await client.start();
            onTestFinished(() => client.forceStop());

            const session = await client.createSession({ onPermissionRequest: approveAll });
            // CLI returns actual capabilities (elicitation false in headless mode)
            expect(session.capabilities.ui?.elicitation).toBe(false);
        });

        it("elicitation throws when capability is missing", async () => {
            const client = new CopilotClient();
            await client.start();
            onTestFinished(() => client.forceStop());

            const session = await client.createSession({ onPermissionRequest: approveAll });

            await expect(
                session.ui.elicitation({
                    message: "Enter name",
                    requestedSchema: {
                        type: "object",
                        properties: { name: { type: "string", minLength: 1 } },
                        required: ["name"],
                    },
                })
            ).rejects.toThrow(/not supported/);
        });
    });
});
