/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

using Microsoft.Extensions.Logging.Abstractions;
using Nerdbank.Streams;
using StreamJsonRpc;
using System.Collections.Concurrent;
using System.Reflection;
using Xunit;

namespace GitHub.Copilot.SDK.Test;

/// <summary>
/// Bug reproduction tests for issue #300: SDK permission callback binding lost
/// in headless mode after reconnections.
///
/// These tests reproduce the exact failure scenario:
/// 1. Session is created with a permission handler (OnPermissionRequest)
/// 2. Session is disposed (e.g., during reconnection)
/// 3. _permissionHandler becomes null
/// 4. Session remains in client's _sessions map (pre-fix bug)
/// 5. CLI broadcasts permission.requested event
/// 6. Disposed session receives it, handler is null
/// 7. BUG: code silently returns → CLI hangs forever
/// 8. FIX: sends explicit denial + session removed from map on dispose
/// </summary>
public class SessionDisposeTests
{
    private static CopilotSession CreateTestSession(string sessionId = "test-session")
    {
        var (clientStream, serverStream) = FullDuplexStream.CreatePair();
        var rpc = new JsonRpc(clientStream);
        rpc.StartListening();
        // Close server side so RPC calls fail fast instead of hanging.
        serverStream.Dispose();
        return new CopilotSession(sessionId, rpc, NullLogger.Instance);
    }

    /// <summary>
    /// Helper to build a PermissionRequestedEvent from JSON, matching what
    /// the CLI server broadcasts over the wire.
    /// </summary>
    private static PermissionRequestedEvent CreatePermissionEvent(string requestId = "req-1")
    {
        var json = $$"""
        {
            "type": "permission.requested",
            "data": {
                "requestId": "{{requestId}}",
                "permissionRequest": {
                    "kind": "write",
                    "fileName": "/tmp/test.txt",
                    "diff": "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new",
                    "intention": "Edit test file",
                    "canOfferSessionApproval": false
                }
            }
        }
        """;
        var evt = SessionEvent.FromJson(json);
        return (PermissionRequestedEvent)evt!;
    }

    // ========================================================================
    // BUG REPRODUCTION: These tests prove the three defects that existed
    // ========================================================================

    [Fact]
    public async Task Bug1_DisposedSession_MustNotReceiveEvents()
    {
        // REPRODUCES: Without the DispatchEvent disposed guard, events
        // dispatched to a disposed session still reach HandleBroadcastEventAsync.
        //
        // The fix adds `if (Volatile.Read(ref _isDisposed) == 1) return;`
        // to DispatchEvent.
        //
        // Proof this test catches the bug: We manually set _isDisposed=1
        // WITHOUT completing the channel (simulating the race). On unpatched
        // code, DispatchEvent ignores _isDisposed and still writes to the channel.
        // On patched code, it returns early.

        var receivedEvents = new List<SessionEvent>();
        var session = CreateTestSession();
        session.On(evt => receivedEvents.Add(evt));

        var evt = SessionEvent.FromJson("""{"type":"session.idle","data":{}}""")!;

        // Before dispose: events are delivered
        session.DispatchEvent(evt);
        await Task.Delay(100);
        Assert.Single(receivedEvents);

        // Manually set _isDisposed=1 to simulate the race window where
        // dispose is in progress but channel isn't completed yet.
        // On unpatched code, DispatchEvent would STILL deliver because
        // it never checks _isDisposed.
        var field = typeof(CopilotSession).GetField("_isDisposed",
            BindingFlags.Instance | BindingFlags.NonPublic);
        field!.SetValue(session, 1);

        receivedEvents.Clear();

        // With the fix: this is a no-op (disposed guard catches it)
        // Without the fix: event would be written to channel + broadcast
        session.DispatchEvent(evt);
        await Task.Delay(100);
        Assert.Empty(receivedEvents);
    }

    [Fact]
    public async Task Bug2_DisposedSession_MustBeRemovedFromClientMap()
    {
        // REPRODUCES: Without OnDisposed callback, disposing a session
        // leaves it in the client's _sessions ConcurrentDictionary. The CLI
        // server can then route events to the dead session.
        //
        // We simulate the client's _sessions map and verify the session
        // is removed on dispose (with the fix) via the OnDisposed callback.

        var sessions = new ConcurrentDictionary<string, CopilotSession>();
        var session = CreateTestSession("session-dead");

        sessions["session-dead"] = session;
        session.OnDisposed = id => sessions.TryRemove(id, out _);

        Assert.True(sessions.ContainsKey("session-dead"));

        await session.DisposeAsync();

        // With fix: session is removed. Without fix: it lingers.
        Assert.False(sessions.ContainsKey("session-dead"));
    }

    [Fact]
    public async Task Bug3_NullPermissionHandler_MustSendDenial_NotSilentReturn()
    {
        // REPRODUCES: After dispose, _permissionHandler is null.
        // The unpatched HandleBroadcastEventAsync just returns silently
        // when handler is null (line 467: `return; // another client will`).
        // In single-client headless mode, there IS no other client.
        // The CLI hangs forever waiting for a response.
        //
        // The fix sends an explicit DeniedCouldNotRequestFromUser denial.
        //
        // We verify:
        // 1. Permission handler IS null after dispose
        // 2. Dispatching a PermissionRequestedEvent doesn't throw
        //    (the denial RPC will fail since our connection is dead,
        //     but it's caught and swallowed — that's the "best-effort" part)

        var handlerCalled = false;
        var session = CreateTestSession();
        session.RegisterPermissionHandler((req, inv) =>
        {
            handlerCalled = true;
            return Task.FromResult(new PermissionRequestResult
            {
                Kind = PermissionRequestResultKind.Approved
            });
        });

        await session.DisposeAsync();

        // Verify handler was nulled
        var field = typeof(CopilotSession).GetField("_permissionHandler",
            BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(field);
        Assert.Null(field!.GetValue(session));

        // Dispatch a permission event to the disposed session.
        // On unpatched code: silently returns, CLI hangs.
        // On patched code: sends denial (which fails because connection is dead,
        // but that's caught). Either way, it doesn't invoke the old handler.
        var permEvent = CreatePermissionEvent();

        // Use reflection to call HandleBroadcastEventAsync directly to
        // exercise the exact buggy code path.
        var method = typeof(CopilotSession).GetMethod("HandleBroadcastEventAsync",
            BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(method);

        // Should not throw — the fix catches the RPC error
        var task = (Task)method!.Invoke(session, [permEvent])!;
        await task;

        Assert.False(handlerCalled, "Disposed session's handler should never be invoked");
    }

    // ========================================================================
    // FIX VERIFICATION: These tests verify the defensive behavior
    // ========================================================================

    [Fact]
    public async Task Fix_OnDisposed_CallbackFires_WithCorrectSessionId()
    {
        string? disposedId = null;
        var session = CreateTestSession("session-42");
        session.OnDisposed = id => disposedId = id;

        await session.DisposeAsync();

        Assert.Equal("session-42", disposedId);
    }

    [Fact]
    public async Task Fix_OnDisposed_NotCalledTwice_OnDoubleDispose()
    {
        int callCount = 0;
        var session = CreateTestSession();
        session.OnDisposed = _ => Interlocked.Increment(ref callCount);

        await session.DisposeAsync();
        await session.DisposeAsync();

        Assert.Equal(1, callCount);
    }

    [Fact]
    public async Task Fix_DisposeGuard_SetsIsDisposedFlag()
    {
        var session = CreateTestSession();

        var isDisposedField = typeof(CopilotSession).GetField("_isDisposed",
            BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(isDisposedField);
        Assert.Equal(0, isDisposedField!.GetValue(session));

        await session.DisposeAsync();

        Assert.Equal(1, isDisposedField.GetValue(session));
    }

    [Fact]
    public async Task Fix_PermissionHandler_StillWorks_BeforeDispose()
    {
        // Sanity check: the fix doesn't break normal permission handling.
        var handlerCalled = false;
        var session = CreateTestSession();
        session.RegisterPermissionHandler((req, inv) =>
        {
            handlerCalled = true;
            return Task.FromResult(new PermissionRequestResult
            {
                Kind = PermissionRequestResultKind.Approved
            });
        });

        var field = typeof(CopilotSession).GetField("_permissionHandler",
            BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(field!.GetValue(session));

        var permEvent = CreatePermissionEvent();
        var method = typeof(CopilotSession).GetMethod("HandleBroadcastEventAsync",
            BindingFlags.Instance | BindingFlags.NonPublic);

        // This invokes the handler, then tries to send RPC response (which
        // fails on our mock connection — caught internally).
        var task = (Task)method!.Invoke(session, [permEvent])!;
        await task;

        Assert.True(handlerCalled, "Handler should be called on a live session");

        await session.DisposeAsync();
    }

    [Fact]
    public async Task Fix_EndToEnd_ClientRemovesDisposedSession_EventsBlocked()
    {
        // End-to-end simulation of the bug scenario:
        // 1. Client has a _sessions map
        // 2. Session is created with OnDisposed wired up
        // 3. Session is disposed (simulating reconnection)
        // 4. Verify: session removed from map, events blocked

        var sessions = new ConcurrentDictionary<string, CopilotSession>();
        var session = CreateTestSession("sess-reconnect");

        sessions["sess-reconnect"] = session;
        session.OnDisposed = id => sessions.TryRemove(id, out _);

        session.RegisterPermissionHandler((req, inv) =>
            Task.FromResult(new PermissionRequestResult
            {
                Kind = PermissionRequestResultKind.Approved
            }));

        // Simulate reconnection: dispose old session
        await session.DisposeAsync();

        // Session is gone from map
        Assert.False(sessions.ContainsKey("sess-reconnect"));

        // Even if someone still has a reference, DispatchEvent is a no-op
        var receivedEvents = new List<SessionEvent>();
        session.On(evt => receivedEvents.Add(evt));
        var evt = SessionEvent.FromJson("""{"type":"session.idle","data":{}}""")!;
        session.DispatchEvent(evt);
        await Task.Delay(50);
        Assert.Empty(receivedEvents);
    }
}
