"""
Unit tests for send_and_wait backgroundTasks fix (PolyPilot#299).

These tests reproduce the bug — send_and_wait resolving prematurely when
session.idle carries active backgroundTasks — and verify the fix.

No CLI connection is required: we construct a minimal CopilotSession, mock
the send() method, and dispatch synthetic events via _dispatch_event().
"""

import asyncio
import threading
from unittest.mock import AsyncMock, MagicMock

import pytest

from copilot.generated.session_events import BackgroundTasks, BackgroundTasksAgent, Shell
from copilot.session import CopilotSession, SessionEventType


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_session() -> CopilotSession:
    """Create a bare CopilotSession instance without a real CLI connection."""
    session = CopilotSession.__new__(CopilotSession)
    session._event_handlers = set()
    session._event_handlers_lock = threading.Lock()
    session._tool_handlers = {}
    session._tool_handlers_lock = threading.Lock()
    session._permission_handler = None
    session._permission_handler_lock = threading.Lock()
    session._user_input_handler = None
    session._user_input_handler_lock = threading.Lock()
    session._hooks = None
    session._hooks_lock = threading.Lock()
    session._transform_callbacks = None
    session._transform_callbacks_lock = threading.Lock()
    session._rpc = None
    session._destroyed = False
    session.session_id = "test-session-id"
    # Provide a mock client so that send() returns immediately
    mock_client = MagicMock()
    mock_client.request = AsyncMock(return_value={"messageId": "test-msg-id"})
    session._client = mock_client
    return session


def _idle_event(background_tasks=None):
    """Build a synthetic session.idle event."""
    evt = MagicMock()
    evt.type = SessionEventType.SESSION_IDLE
    evt.data = MagicMock()
    evt.data.background_tasks = background_tasks
    return evt


def _background_tasks(agents=None, shells=None):
    """Shorthand to build a BackgroundTasks instance."""
    bt = MagicMock(spec=BackgroundTasks)
    bt.agents = agents or []
    bt.shells = shells or []
    return bt


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestSendAndWaitBackgroundTasks:
    """
    Regression suite for PolyPilot#299:
    send_and_wait must not resolve when session.idle has active background tasks.
    """

    @pytest.mark.asyncio
    async def test_does_not_resolve_with_active_background_agents(self):
        """
        BUG REPRO: before the fix, send_and_wait resolved immediately on any
        session.idle.  After the fix it must wait when agents[] is non-empty.
        """
        session = _make_session()

        resolved = False

        async def run():
            nonlocal resolved
            await session.send_and_wait("trigger background agents", timeout=5)
            resolved = True

        task = asyncio.create_task(run())
        await asyncio.sleep(0.05)  # let send() complete and the wait begin

        # Dispatch session.idle WITH active background agent — must NOT resolve
        active_agent = MagicMock(spec=BackgroundTasksAgent)
        active_agent.agent_id = "bg-1"
        active_agent.agent_type = "worker"
        session._dispatch_event(_idle_event(_background_tasks(agents=[active_agent])))

        await asyncio.sleep(0.1)
        assert not resolved, (
            "BUG #299: send_and_wait resolved prematurely while background agents were active"
        )

        # Dispatch clean idle (no backgroundTasks) — now it SHOULD resolve
        session._dispatch_event(_idle_event(background_tasks=None))

        await asyncio.wait_for(task, timeout=2)
        assert resolved

    @pytest.mark.asyncio
    async def test_does_not_resolve_with_active_background_shells(self):
        """send_and_wait must wait when shells[] is non-empty."""
        session = _make_session()

        resolved = False

        async def run():
            nonlocal resolved
            await session.send_and_wait("trigger shell", timeout=5)
            resolved = True

        task = asyncio.create_task(run())
        await asyncio.sleep(0.05)

        active_shell = MagicMock(spec=Shell)
        active_shell.shell_id = "sh-1"
        session._dispatch_event(_idle_event(_background_tasks(shells=[active_shell])))

        await asyncio.sleep(0.1)
        assert not resolved, (
            "BUG #299: send_and_wait resolved prematurely while background shells were active"
        )

        # Dispatch clean idle — should resolve
        session._dispatch_event(_idle_event(_background_tasks(agents=[], shells=[])))

        await asyncio.wait_for(task, timeout=2)
        assert resolved

    @pytest.mark.asyncio
    async def test_resolves_when_idle_has_no_background_tasks(self):
        """send_and_wait resolves immediately when backgroundTasks is absent."""
        session = _make_session()

        task = asyncio.create_task(
            session.send_and_wait("hello", timeout=5)
        )
        await asyncio.sleep(0.05)

        session._dispatch_event(_idle_event(background_tasks=None))

        await asyncio.wait_for(task, timeout=2)

    @pytest.mark.asyncio
    async def test_resolves_when_background_tasks_arrays_are_empty(self):
        """send_and_wait resolves when both agents[] and shells[] are empty."""
        session = _make_session()

        task = asyncio.create_task(
            session.send_and_wait("hello", timeout=5)
        )
        await asyncio.sleep(0.05)

        session._dispatch_event(_idle_event(_background_tasks(agents=[], shells=[])))

        await asyncio.wait_for(task, timeout=2)
