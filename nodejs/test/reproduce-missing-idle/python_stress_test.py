"""
Python SDK stress test for session.idle with the real CLI.

Tests the actual Python SDK path that the SO user was using.
Runs 20 iterations, recording whether session.idle arrives after each sendAndWait.

Usage:
    cd nodejs && npx tsx test/reproduce-missing-idle/start-proxy.ts &
    # get proxy URL
    python test/reproduce-missing-idle/python_stress_test.py <proxy_url>
"""
import asyncio
import os
import sys
import subprocess
import tempfile
import time
import json
import shutil
from pathlib import Path

# Add the python package to the path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "python"))

from copilot import CopilotClient
from copilot.types import Tool, PermissionHandler, PermissionRequestResult, ToolResult

CLI_PATH = os.environ.get("COPILOT_CLI_PATH", "/home/vscode/.vscode-server-insiders/data/User/globalStorage/github.copilot-chat/copilotCli/copilot")

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
HARNESS_SERVER = str(REPO_ROOT / "test" / "harness" / "server.ts")
SNAPSHOT_PATH = str(REPO_ROOT / "test" / "snapshots" / "session" / "sendandwait_blocks_until_session_idle_and_returns_final_assistant_message.yaml")
TOOL_SNAPSHOT_PATH = str(REPO_ROOT / "test" / "snapshots" / "session" / "should_create_session_with_custom_tool.yaml")
NODEJS_DIR = str(REPO_ROOT / "nodejs")


def start_proxy():
    """Start a replay proxy and return (url, process)."""
    proc = subprocess.Popen(
        ["npx", "tsx", HARNESS_SERVER],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        cwd=NODEJS_DIR,
    )
    line = proc.stdout.readline().decode()
    import re
    m = re.search(r"Listening: (http://[^\s]+)", line)
    if not m:
        proc.kill()
        raise RuntimeError(f"Failed to start proxy: {line}")
    return m.group(1), proc


def configure_proxy(url, snapshot_path, work_dir):
    """Configure the proxy with snapshot and workdir."""
    import urllib.request
    data = json.dumps({
        "filePath": snapshot_path,
        "workDir": work_dir,
        "testInfo": {"file": "python_stress_test.py", "line": 1},
    }).encode()
    req = urllib.request.Request(
        f"{url}/config", data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req)


def stop_proxy(url, proc):
    """Stop the proxy gracefully."""
    import urllib.request
    try:
        req = urllib.request.Request(f"{url}/stop?skipWritingCache=true", method="POST")
        urllib.request.urlopen(req)
    except Exception:
        pass
    proc.kill()
    proc.wait()


async def test_single_message(iterations: int) -> tuple[int, int, int]:
    """Test simple sendAndWait with Python SDK."""
    print(f"\n--- Python SDK: Simple message ({iterations} iterations) ---")
    passed = 0
    failed = 0
    fallback = 0

    for i in range(iterations):
        proxy_url, proxy_proc = start_proxy()
        home_dir = tempfile.mkdtemp(prefix="pyh-")
        work_dir = tempfile.mkdtemp(prefix="pyw-")

        try:
            configure_proxy(proxy_url, SNAPSHOT_PATH, work_dir)

            env = {
                **os.environ,
                "COPILOT_API_URL": proxy_url,
                "XDG_CONFIG_HOME": home_dir,
                "XDG_STATE_HOME": home_dir,
            }

            client = CopilotClient({
                "cwd": work_dir,
                "env": env,
                "log_level": "error",
                "github_token": "fake-token",
                "cli_path": CLI_PATH,
            })

            await client.start()

            session = await client.create_session({
                "on_permission_request": PermissionHandler.approve_all,
            })

            got_turn_end = False
            got_idle = False
            turn_end_ts = 0.0
            idle_ts = 0.0
            events = []

            def on_event(event):
                nonlocal got_turn_end, got_idle, turn_end_ts, idle_ts
                events.append(event.type.value if hasattr(event.type, 'value') else str(event.type))
                if event.type.value == "assistant.turn_end":
                    got_turn_end = True
                    turn_end_ts = time.time()
                if event.type.value == "session.idle":
                    got_idle = True
                    idle_ts = time.time()

            session.on(on_event)

            try:
                result = await session.send_and_wait(
                    options={"prompt": "What is 2+2?"},
                    timeout=30_000,
                )

                if not got_idle:
                    failed += 1
                    sys.stdout.write("X")
                    sys.stdout.flush()
                elif got_turn_end and (idle_ts - turn_end_ts) > 3.0:
                    fallback += 1
                    sys.stdout.write("F")
                    sys.stdout.flush()
                else:
                    passed += 1
                    sys.stdout.write(".")
                    sys.stdout.flush()
            except Exception as e:
                failed += 1
                sys.stdout.write(f"X({type(e).__name__})")
                sys.stdout.flush()

            await client.stop()
        except Exception as e:
            failed += 1
            sys.stdout.write(f"E({type(e).__name__}:{e})")
            sys.stdout.flush()
        finally:
            stop_proxy(proxy_url, proxy_proc)
            shutil.rmtree(home_dir, ignore_errors=True)
            shutil.rmtree(work_dir, ignore_errors=True)

    print(f"\n  Results: {passed} pass, {failed} fail, {fallback} fallback")
    return passed, failed, fallback


async def test_tool_use(iterations: int) -> tuple[int, int, int]:
    """Test tool use with Python SDK."""
    print(f"\n--- Python SDK: Tool use ({iterations} iterations) ---")
    passed = 0
    failed = 0
    fallback = 0

    for i in range(iterations):
        proxy_url, proxy_proc = start_proxy()
        home_dir = tempfile.mkdtemp(prefix="pyh-")
        work_dir = tempfile.mkdtemp(prefix="pyw-")

        try:
            configure_proxy(proxy_url, TOOL_SNAPSHOT_PATH, work_dir)

            env = {
                **os.environ,
                "COPILOT_API_URL": proxy_url,
                "XDG_CONFIG_HOME": home_dir,
                "XDG_STATE_HOME": home_dir,
            }

            client = CopilotClient({
                "cwd": work_dir,
                "env": env,
                "log_level": "error",
                "github_token": "fake-token",
                "cli_path": CLI_PATH,
            })

            await client.start()

            def get_secret_number(invocation):
                key = invocation.arguments.get("key", "") if isinstance(invocation.arguments, dict) else ""
                return ToolResult(
                    text_result_for_llm="54321" if key == "ALPHA" else "unknown",
                    result_type="success",
                )

            session = await client.create_session({
                "on_permission_request": PermissionHandler.approve_all,
                "tools": [
                    Tool(
                        name="get_secret_number",
                        description="Gets the secret number",
                        handler=get_secret_number,
                        parameters={
                            "type": "object",
                            "properties": {"key": {"type": "string", "description": "Key"}},
                            "required": ["key"],
                        },
                    ),
                ],
            })

            got_idle = False
            turn_end_ts = 0.0
            idle_ts = 0.0

            def on_event(event):
                nonlocal got_idle, turn_end_ts, idle_ts
                val = event.type.value if hasattr(event.type, 'value') else str(event.type)
                if val == "assistant.turn_end":
                    turn_end_ts = time.time()
                if val == "session.idle":
                    got_idle = True
                    idle_ts = time.time()

            session.on(on_event)

            try:
                result = await session.send_and_wait(
                    options={"prompt": "What is the secret number for key ALPHA?"},
                    timeout=30_000,
                )

                if not got_idle:
                    failed += 1
                    sys.stdout.write("X")
                    sys.stdout.flush()
                elif turn_end_ts > 0 and (idle_ts - turn_end_ts) > 3.0:
                    fallback += 1
                    sys.stdout.write("F")
                    sys.stdout.flush()
                else:
                    passed += 1
                    sys.stdout.write(".")
                    sys.stdout.flush()
            except Exception as e:
                failed += 1
                sys.stdout.write(f"X({type(e).__name__})")
                sys.stdout.flush()

            await client.stop()
        except Exception as e:
            failed += 1
            sys.stdout.write(f"E({type(e).__name__})")
            sys.stdout.flush()
        finally:
            stop_proxy(proxy_url, proxy_proc)
            shutil.rmtree(home_dir, ignore_errors=True)
            shutil.rmtree(work_dir, ignore_errors=True)

    print(f"\n  Results: {passed} pass, {failed} fail, {fallback} fallback")
    return passed, failed, fallback


async def test_streaming(iterations: int) -> tuple[int, int, int]:
    """Test with streaming enabled — this is what the SO user was using."""
    print(f"\n--- Python SDK: Streaming enabled ({iterations} iterations) ---")
    passed = 0
    failed = 0
    fallback = 0

    for i in range(iterations):
        proxy_url, proxy_proc = start_proxy()
        home_dir = tempfile.mkdtemp(prefix="pyh-")
        work_dir = tempfile.mkdtemp(prefix="pyw-")

        try:
            configure_proxy(proxy_url, SNAPSHOT_PATH, work_dir)

            env = {
                **os.environ,
                "COPILOT_API_URL": proxy_url,
                "XDG_CONFIG_HOME": home_dir,
                "XDG_STATE_HOME": home_dir,
            }

            client = CopilotClient({
                "cwd": work_dir,
                "env": env,
                "log_level": "error",
                "github_token": "fake-token",
                "cli_path": CLI_PATH,
            })

            await client.start()

            session = await client.create_session({
                "on_permission_request": PermissionHandler.approve_all,
                "streaming": True,  # This is what the SO user was using!
            })

            got_idle = False
            turn_end_ts = 0.0
            idle_ts = 0.0

            def on_event(event):
                nonlocal got_idle, turn_end_ts, idle_ts
                val = event.type.value if hasattr(event.type, 'value') else str(event.type)
                if val == "assistant.turn_end":
                    turn_end_ts = time.time()
                if val == "session.idle":
                    got_idle = True
                    idle_ts = time.time()

            session.on(on_event)

            try:
                result = await session.send_and_wait(
                    options={"prompt": "What is 2+2?"},
                    timeout=30_000,
                )

                if not got_idle:
                    failed += 1
                    sys.stdout.write("X")
                    sys.stdout.flush()
                elif turn_end_ts > 0 and (idle_ts - turn_end_ts) > 3.0:
                    fallback += 1
                    sys.stdout.write("F")
                    sys.stdout.flush()
                else:
                    passed += 1
                    sys.stdout.write(".")
                    sys.stdout.flush()
            except Exception as e:
                failed += 1
                sys.stdout.write(f"X({type(e).__name__})")
                sys.stdout.flush()

            await client.stop()
        except Exception as e:
            failed += 1
            sys.stdout.write(f"E({type(e).__name__})")
            sys.stdout.flush()
        finally:
            stop_proxy(proxy_url, proxy_proc)
            shutil.rmtree(home_dir, ignore_errors=True)
            shutil.rmtree(work_dir, ignore_errors=True)

    print(f"\n  Results: {passed} pass, {failed} fail, {fallback} fallback")
    return passed, failed, fallback


async def main():
    print("=" * 60)
    print("Python SDK session.idle Stress Test (Real CLI)")
    print(f"Python: {sys.version}")
    print("=" * 60)

    results = []
    results.append(await test_single_message(15))
    results.append(await test_tool_use(10))
    results.append(await test_streaming(10))

    total_pass = sum(r[0] for r in results)
    total_fail = sum(r[1] for r in results)
    total_fallback = sum(r[2] for r in results)
    total = total_pass + total_fail + total_fallback

    print(f"\n{'=' * 60}")
    print(f"TOTAL: {total} tests — {total_pass} pass, {total_fail} fail, {total_fallback} fallback")
    print(f"{'=' * 60}")

    if total_fail > 0 or total_fallback > 0:
        print("\n⚠️  Session.idle issues detected!")
        sys.exit(1)
    else:
        print("\n✅ No session.idle issues detected across all Python SDK stress tests.")


if __name__ == "__main__":
    asyncio.run(main())
