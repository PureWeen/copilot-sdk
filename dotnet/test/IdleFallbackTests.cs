/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.Json.Serialization;
using StreamJsonRpc;
using Xunit;

namespace GitHub.Copilot.SDK.Test;

/// <summary>
/// Tests for the session.idle fallback mechanism using a fake JSON-RPC server.
/// No InternalsVisibleTo required — all interaction is through the public API.
/// </summary>
public class IdleFallbackTests : IAsyncLifetime
{
    private TcpListener _listener = null!;
    private int _port;
    private CopilotClient _client = null!;
    private Task _serverTask = null!;
    private CancellationTokenSource _cts = null!;
    private readonly FakeCliServer _fakeServer = new();

    public async Task InitializeAsync()
    {
        _cts = new CancellationTokenSource();

        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start();
        _port = ((IPEndPoint)_listener.LocalEndpoint).Port;

        // Start the fake server in the background (blocks on AcceptTcpClientAsync)
        _serverTask = Task.Run(() => _fakeServer.AcceptAndServeAsync(_listener, _cts.Token));

        // Create and connect the client — triggers the TCP handshake which unblocks the server
        _client = new CopilotClient(new CopilotClientOptions
        {
            CliUrl = $"http://localhost:{_port}",
        });
        await _client.StartAsync();
    }

    public async Task DisposeAsync()
    {
        _cts.Cancel();
        try { await _client.StopAsync(); }
        catch { /* ignore */ }
        _listener.Stop();
        try { await _serverTask; }
        catch (OperationCanceledException) { }
        _cts.Dispose();
    }

    [Fact]
    public async Task SynthesizesSessionIdleWhenTurnEndArrivesWithoutIdle()
    {
        var session = await _client.CreateSessionAsync(new SessionConfig
        {
            OnPermissionRequest = PermissionHandler.ApproveAll,
        });

        var tcs = new TaskCompletionSource<SessionEvent>();
        var events = new List<string>();

        using var subscription = session.On(evt =>
        {
            events.Add(evt.Type);
            if (evt is SessionIdleEvent)
                tcs.TrySetResult(evt);
        });

        // Send turn_end without a following session.idle
        await _fakeServer.SendEventAsync(session.SessionId, "assistant.turn_end",
            """{"turnId":"turn-1"}""");

        // The SDK should synthesize session.idle after ~5s
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        timeout.Token.Register(() => tcs.TrySetCanceled());
        await tcs.Task;

        Assert.Contains("assistant.turn_end", events);
        Assert.Contains("session.idle", events);
    }

    [Fact]
    public async Task DoesNotSynthesizeIdleWhenRealIdleArrives()
    {
        var session = await _client.CreateSessionAsync(new SessionConfig
        {
            OnPermissionRequest = PermissionHandler.ApproveAll,
        });

        var idleCount = 0;
        var tcs = new TaskCompletionSource<bool>();

        using var subscription = session.On(evt =>
        {
            if (evt is SessionIdleEvent)
            {
                Interlocked.Increment(ref idleCount);
                tcs.TrySetResult(true);
            }
        });

        // Send turn_end followed quickly by real idle
        await _fakeServer.SendEventAsync(session.SessionId, "assistant.turn_end",
            """{"turnId":"turn-1"}""");
        await Task.Delay(50);
        await _fakeServer.SendEventAsync(session.SessionId, "session.idle", "{}");

        // Wait for idle to arrive
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        timeout.Token.Register(() => tcs.TrySetCanceled());
        await tcs.Task;

        // Wait past the fallback period to ensure no duplicate fires
        await Task.Delay(TimeSpan.FromSeconds(6));

        Assert.Equal(1, idleCount);
    }

    [Fact]
    public async Task DisposeCancelsPendingFallbackTimer()
    {
        var session = await _client.CreateSessionAsync(new SessionConfig
        {
            OnPermissionRequest = PermissionHandler.ApproveAll,
        });

        var events = new List<string>();

        using var subscription = session.On(evt =>
        {
            events.Add(evt.Type);
        });

        // Send turn_end to start the fallback timer
        await _fakeServer.SendEventAsync(session.SessionId, "assistant.turn_end",
            """{"turnId":"turn-1"}""");
        await Task.Delay(100);

        Assert.Contains("assistant.turn_end", events);

        // Dispose the session (should cancel the timer)
        await session.DisposeAsync();

        // Wait past the fallback period — no synthetic idle should arrive
        await Task.Delay(TimeSpan.FromSeconds(6));

        Assert.DoesNotContain("session.idle", events);
    }

    /// <summary>
    /// Minimal fake CLI server that speaks just enough JSON-RPC to handle
    /// ping/session.create/session.destroy and send event notifications.
    /// </summary>
    private sealed class FakeCliServer
    {
        private JsonRpc? _rpc;
        private readonly TaskCompletionSource _ready = new();

        public async Task AcceptAndServeAsync(TcpListener listener, CancellationToken ct)
        {
            using var tcp = await listener.AcceptTcpClientAsync(ct);
            var stream = tcp.GetStream();

            var serverOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web);
            // The test project sets JsonSerializerIsReflectionEnabledByDefault=false (NativeAOT validation).
            // The server formatter must have a source-gen context so StreamJsonRpc can serialize JsonElement params.
            serverOptions.TypeInfoResolverChain.Add(FakeServerJsonContext.Default);

            var formatter = new SystemTextJsonFormatter
            {
                JsonSerializerOptions = serverOptions
            };

            var handler = new HeaderDelimitedMessageHandler(stream, stream, formatter);
            var rpc = new JsonRpc(handler);

            rpc.AddLocalRpcTarget(new RpcTarget(), new JsonRpcTargetOptions());

            rpc.StartListening();
            _rpc = rpc;
            _ready.TrySetResult();

            try { await Task.Delay(Timeout.Infinite, ct); }
            catch (OperationCanceledException) { }
        }

        public async Task SendEventAsync(string sessionId, string eventType, string dataJson = "{}")
        {
            await _ready.Task;

            var json = $$"""
                {
                    "id": "{{Guid.NewGuid()}}",
                    "type": "{{eventType}}",
                    "timestamp": "{{DateTimeOffset.UtcNow:O}}",
                    "ephemeral": {{(eventType == "session.idle" ? "true" : "false")}},
                    "data": {{dataJson}}
                }
                """;
            var element = JsonDocument.Parse(json).RootElement.Clone();

            await _rpc!.NotifyAsync("session.event", sessionId, element);
        }
    }

    /// <summary>
    /// RPC methods the SDK client calls during startup and session management.
    /// The [JsonRpcMethod] attribute maps them to the exact JSON-RPC method names.
    /// </summary>
#pragma warning disable CA1822 // Methods must be instance for AddLocalRpcTarget
    private sealed class RpcTarget
    {
        [JsonRpcMethod("ping")]
        public JsonElement Ping(JsonElement request)
        {
            var response = $$"""{"message":"pong","timestamp":{{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}},"protocolVersion":3}""";
            return JsonDocument.Parse(response).RootElement.Clone();
        }

        [JsonRpcMethod("session.create")]
        public JsonElement SessionCreate(JsonElement request)
        {
            string sessionId = "test-session";
            if (request.TryGetProperty("sessionId", out var sid))
                sessionId = sid.GetString() ?? sessionId;
            return JsonDocument.Parse($$"""{"sessionId":"{{sessionId}}"}""").RootElement.Clone();
        }

        [JsonRpcMethod("session.destroy")]
        public JsonElement SessionDestroy(JsonElement request)
        {
            return JsonDocument.Parse("{}").RootElement.Clone();
        }
    }
#pragma warning restore CA1822
}

/// <summary>
/// Source-generated JSON context for the fake server.
/// Required because the test project disables reflection-based JSON serialization.
/// </summary>
[JsonSerializable(typeof(JsonElement))]
[JsonSerializable(typeof(JsonElement?))]
[JsonSerializable(typeof(string))]
internal partial class FakeServerJsonContext : JsonSerializerContext;
