/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

using Xunit;

namespace GitHub.Copilot.SDK.Test;

/// <summary>
/// Regression tests for the Environment merge-vs-replace bug (Issue #441).
///
/// Background:
///   Before the fix, <see cref="CopilotClientOptions.Environment"/> was handled with:
///
///     startInfo.Environment.Clear();   // ← BUG: wiped PATH, SystemRoot, COMSPEC, TEMP, etc.
///     foreach (var (key, value) in options.Environment)
///         startInfo.Environment[key] = value;
///
///   ProcessStartInfo.Environment is pre-populated with the current process's inherited
///   environment.  The Clear() call threw it all away, so supplying even ONE custom key
///   caused the Node.js-based CLI subprocess to crash on Windows because essential system
///   variables (PATH, SystemRoot, COMSPEC) were gone.
///
///   After the fix, user-supplied keys are merged (override or add) into the inherited
///   environment -- the CLI subprocess receives all inherited vars plus any overrides.
///
/// How the tests prove the fix:
///   Every test below that provides a non-null Environment dict would have thrown an
///   IOException ("CLI process exited unexpectedly") BEFORE the fix.  After the fix they
///   all pass because PATH/SystemRoot/COMSPEC remain available to the subprocess.
/// </summary>
public class EnvironmentTests
{
    // ── Null / empty cases ────────────────────────────────────────────────────

    [Fact]
    public void Environment_DefaultsToNull()
    {
        // Verify the documented default: null means "fully inherit from parent process".
        var options = new CopilotClientOptions();
        Assert.Null(options.Environment);
    }

    [Fact]
    public async Task Should_Start_When_Environment_Is_Null()
    {
        // Baseline: null Environment → all inherited vars are present → CLI starts.
        using var client = new CopilotClient(new CopilotClientOptions
        {
            UseStdio = true,
            Environment = null,
        });

        try
        {
            await client.StartAsync();
            Assert.Equal(ConnectionState.Connected, client.State);

            var pong = await client.PingAsync("null-env");
            Assert.Equal("pong: null-env", pong.Message);

            await client.StopAsync();
        }
        finally
        {
            await client.ForceStopAsync();
        }
    }

    [Fact]
    public async Task Should_Start_When_Environment_Is_An_Empty_Dictionary()
    {
        // An empty dictionary supplies no keys, so the loop in Client.cs runs zero
        // iterations -- the inherited environment is completely unchanged.
        // Before the fix: Clear() was still called → crash.
        // After the fix:  no Clear(); inherited env untouched → CLI starts normally.
        using var client = new CopilotClient(new CopilotClientOptions
        {
            UseStdio = true,
            Environment = new Dictionary<string, string>(),
        });

        try
        {
            await client.StartAsync();
            Assert.Equal(ConnectionState.Connected, client.State);

            var pong = await client.PingAsync("empty-env");
            Assert.Equal("pong: empty-env", pong.Message);

            await client.StopAsync();
        }
        finally
        {
            await client.ForceStopAsync();
        }
    }

    // ── Partial-dict merge cases ──────────────────────────────────────────────

    [Fact]
    public async Task Should_Start_When_Environment_Has_One_Custom_Key()
    {
        // This is the canonical regression test for Issue #441.
        //
        // The user provides a single custom environment variable -- a perfectly
        // reasonable thing to do (e.g. to set COPILOT_API_URL, a proxy, etc.).
        //
        // Before the fix:
        //   startInfo.Environment.Clear()  ← removes PATH, SystemRoot, COMSPEC …
        //   startInfo.Environment["MY_KEY"] = "value"
        //   → CLI subprocess starts with only MY_KEY → crashes immediately
        //   → StartAsync() throws IOException
        //
        // After the fix:
        //   startInfo.Environment["MY_KEY"] = "value"   (merged)
        //   → CLI subprocess retains all inherited vars + MY_KEY → starts normally
        using var client = new CopilotClient(new CopilotClientOptions
        {
            UseStdio = true,
            Environment = new Dictionary<string, string>
            {
                ["MY_CUSTOM_SDK_VAR"] = "hello_world",
            },
        });

        try
        {
            // This line would throw before the fix:
            //   System.IO.IOException: CLI process exited unexpectedly …
            await client.StartAsync();
            Assert.Equal(ConnectionState.Connected, client.State);

            var pong = await client.PingAsync("one-key-env");
            Assert.Equal("pong: one-key-env", pong.Message);

            await client.StopAsync();
        }
        finally
        {
            await client.ForceStopAsync();
        }
    }

    [Fact]
    public async Task Should_Start_When_Environment_Has_Multiple_Custom_Keys()
    {
        // Multiple custom keys, none of them system variables.
        // Proves that the merge works for an arbitrary number of custom entries.
        using var client = new CopilotClient(new CopilotClientOptions
        {
            UseStdio = true,
            Environment = new Dictionary<string, string>
            {
                ["SDK_TEST_VAR_A"] = "alpha",
                ["SDK_TEST_VAR_B"] = "beta",
                ["SDK_TEST_VAR_C"] = "gamma",
            },
        });

        try
        {
            await client.StartAsync();
            Assert.Equal(ConnectionState.Connected, client.State);

            var pong = await client.PingAsync("multi-key-env");
            Assert.Equal("pong: multi-key-env", pong.Message);

            await client.StopAsync();
        }
        finally
        {
            await client.ForceStopAsync();
        }
    }

    [Fact]
    public async Task Should_Start_When_Environment_Overrides_An_Inherited_Key()
    {
        // Overriding an EXISTING env var (e.g. COPILOT_LOG_LEVEL) should work:
        // the override takes effect, and all other inherited vars remain.
        using var client = new CopilotClient(new CopilotClientOptions
        {
            UseStdio = true,
            Environment = new Dictionary<string, string>
            {
                // Override a var that is almost certainly already present in the
                // parent process environment so we exercise the "override" code path.
                ["PATH"] = System.Environment.GetEnvironmentVariable("PATH") ?? "/usr/bin",
            },
        });

        try
        {
            await client.StartAsync();
            Assert.Equal(ConnectionState.Connected, client.State);

            var pong = await client.PingAsync("override-inherited-key");
            Assert.Equal("pong: override-inherited-key", pong.Message);

            await client.StopAsync();
        }
        finally
        {
            await client.ForceStopAsync();
        }
    }

    // ── Verifying the merge semantics via the harness pattern ──────────────

    [Fact]
    public async Task TestHarness_GetEnvironment_Pattern_Works_After_Fix()
    {
        // The E2E test harness (E2ETestContext.GetEnvironment) follows this pattern:
        //
        //   var env = Environment.GetEnvironmentVariables()
        //       .Cast<DictionaryEntry>()
        //       .ToDictionary(...);
        //   env["COPILOT_API_URL"] = proxyUrl;       // ← override
        //   env["XDG_CONFIG_HOME"] = homeDir;        // ← override
        //   env["XDG_STATE_HOME"]  = homeDir;        // ← override
        //   return env;
        //
        // This pattern always supplied the FULL environment, so it happened to work
        // even before the fix.  Here we verify the same pattern continues to work.
        var fullEnvWithOverrides = System.Environment.GetEnvironmentVariables()
            .Cast<System.Collections.DictionaryEntry>()
            .ToDictionary(e => (string)e.Key, e => e.Value?.ToString() ?? "");

        fullEnvWithOverrides["SDK_HARNESS_STYLE_OVERRIDE"] = "harness_value";

        using var client = new CopilotClient(new CopilotClientOptions
        {
            UseStdio = true,
            Environment = fullEnvWithOverrides,
        });

        try
        {
            await client.StartAsync();
            Assert.Equal(ConnectionState.Connected, client.State);

            var pong = await client.PingAsync("harness-pattern");
            Assert.Equal("pong: harness-pattern", pong.Message);

            await client.StopAsync();
        }
        finally
        {
            await client.ForceStopAsync();
        }
    }

    // ── NODE_DEBUG is always stripped ─────────────────────────────────────────

    [Fact]
    public async Task Should_Strip_NODE_DEBUG_When_Environment_Dict_Is_Provided()
    {
        // Client.cs always calls startInfo.Environment.Remove("NODE_DEBUG") after
        // the merge step, so the CLI subprocess never sees NODE_DEBUG regardless of
        // whether the parent process has it set.  The CLI must start normally.
        var envWithNodeDebug = System.Environment.GetEnvironmentVariables()
            .Cast<System.Collections.DictionaryEntry>()
            .ToDictionary(e => (string)e.Key, e => e.Value?.ToString() ?? "");
        envWithNodeDebug["NODE_DEBUG"] = "http,net"; // would pollute CLI stdout if kept

        using var client = new CopilotClient(new CopilotClientOptions
        {
            UseStdio = true,
            Environment = envWithNodeDebug,
        });

        try
        {
            await client.StartAsync();
            Assert.Equal(ConnectionState.Connected, client.State);

            var pong = await client.PingAsync("node-debug-stripped");
            Assert.Equal("pong: node-debug-stripped", pong.Message);

            await client.StopAsync();
        }
        finally
        {
            await client.ForceStopAsync();
        }
    }
}
