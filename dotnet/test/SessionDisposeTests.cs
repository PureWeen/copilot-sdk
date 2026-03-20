/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

using Microsoft.Extensions.Logging.Abstractions;
using StreamJsonRpc;
using System.Reflection;
using Xunit;

namespace GitHub.Copilot.SDK.Test;

/// <summary>
/// Unit tests for session disposal safety behaviors (issue #300).
/// These tests use reflection to access internal members, following the same
/// pattern as <see cref="SerializationTests"/>, because <c>CopilotSession</c>
/// is a sealed internal-constructor class with no public seam for event injection.
/// </summary>
public class SessionDisposeTests
{
    /// <summary>
    /// Creates a minimal CopilotSession backed by a MemoryStream-based JsonRpc
    /// that never does real I/O — same technique used by IdleFallbackTests.
    /// </summary>
    private static CopilotSession CreateTestSession(string sessionId = "test-session")
    {
        var stream = new MemoryStream();
        var handler = new HeaderDelimitedMessageHandler(stream, stream);
        var rpc = new JsonRpc(handler);

        var ctor = typeof(CopilotSession).GetConstructor(
            BindingFlags.Instance | BindingFlags.NonPublic,
            binder: null,
            types: [typeof(string), typeof(JsonRpc), typeof(Microsoft.Extensions.Logging.ILogger), typeof(string)],
            modifiers: null)
            ?? throw new InvalidOperationException("CopilotSession internal constructor not found");

        return (CopilotSession)ctor.Invoke([sessionId, rpc, NullLogger.Instance, null]);
    }

    private static void DispatchEvent(CopilotSession session, SessionEvent evt)
    {
        var method = typeof(CopilotSession).GetMethod("DispatchEvent",
            BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("DispatchEvent not found");
        method.Invoke(session, [evt]);
    }

    private static void SetOnDisposed(CopilotSession session, Action<string>? callback)
    {
        var prop = typeof(CopilotSession).GetProperty("OnDisposed",
            BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("OnDisposed property not found");
        prop.SetValue(session, callback);
    }

    private static SessionIdleEvent MakeIdleEvent() => new()
    {
        Id = Guid.NewGuid(),
        Timestamp = DateTimeOffset.UtcNow,
        ParentId = null,
        Data = new SessionIdleData { BackgroundTasks = null }
    };

    // -------------------------------------------------------------------------
    // Disposed guard
    // -------------------------------------------------------------------------

    [Fact]
    public async Task DispatchEvent_AfterDispose_DoesNotInvokeHandlers()
    {
        var session = CreateTestSession();

        // Use a TCS to reliably wait for the pre-dispose event to be delivered.
        var preTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var received = new List<string>();

        using var _ = session.On(evt =>
        {
            received.Add(evt.Type);
            preTcs.TrySetResult(true);
        });

        // Verify handler fires before dispose
        DispatchEvent(session, MakeIdleEvent());
        await preTcs.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Single(received);

        await session.DisposeAsync();

        // Events dispatched after dispose should be silently dropped
        DispatchEvent(session, MakeIdleEvent());
        await Task.Delay(100); // brief wait — if the guard works nothing arrives

        Assert.Single(received); // still only 1 — the post-dispose event was dropped
    }

    [Fact]
    public async Task DispatchEvent_AfterDispose_IsIdempotent()
    {
        var session = CreateTestSession();
        await session.DisposeAsync();

        // Should not throw even when called multiple times on a disposed session
        var ex = Record.Exception(() =>
        {
            DispatchEvent(session, MakeIdleEvent());
            DispatchEvent(session, MakeIdleEvent());
        });

        Assert.Null(ex);
    }

    // -------------------------------------------------------------------------
    // OnDisposed callback
    // -------------------------------------------------------------------------

    [Fact]
    public async Task DisposeAsync_InvokesOnDisposedCallback_WithSessionId()
    {
        const string sessionId = "my-session-123";
        var session = CreateTestSession(sessionId);

        string? notifiedId = null;
        SetOnDisposed(session, id => notifiedId = id);

        await session.DisposeAsync();

        Assert.Equal(sessionId, notifiedId);
    }

    [Fact]
    public async Task DisposeAsync_OnDisposedCallback_CalledExactlyOnce_OnDoubleDispose()
    {
        var session = CreateTestSession();
        int callCount = 0;
        SetOnDisposed(session, _ => callCount++);

        await session.DisposeAsync();
        await session.DisposeAsync(); // second dispose is a no-op

        Assert.Equal(1, callCount);
    }

    [Fact]
    public async Task DisposeAsync_WithoutOnDisposedCallback_DoesNotThrow()
    {
        var session = CreateTestSession();
        // OnDisposed is null by default — dispose should not throw
        var ex = await Record.ExceptionAsync(() => session.DisposeAsync().AsTask());
        Assert.Null(ex);
    }
}
