"""Tests for the session.idle fallback mechanism."""

import asyncio
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from copilot.generated.session_events import Data, SessionEvent, SessionEventType
from copilot.session import CopilotSession


def _make_turn_end_event() -> SessionEvent:
    return SessionEvent(
        data=Data(),
        id=uuid4(),
        timestamp=datetime.now(timezone.utc),
        type=SessionEventType.ASSISTANT_TURN_END,
        parent_id=None,
    )


def _make_idle_event() -> SessionEvent:
    return SessionEvent(
        data=Data(),
        id=uuid4(),
        timestamp=datetime.now(timezone.utc),
        type=SessionEventType.SESSION_IDLE,
        ephemeral=True,
        parent_id=None,
    )


def _make_assistant_message_event() -> SessionEvent:
    return SessionEvent(
        data=Data(),
        id=uuid4(),
        timestamp=datetime.now(timezone.utc),
        type=SessionEventType.ASSISTANT_MESSAGE,
        parent_id=None,
    )


def _create_test_session(fallback_delay: float = 0.1) -> CopilotSession:
    session = CopilotSession(session_id="test-session", client=None)
    session._idle_fallback_delay = fallback_delay
    return session


@pytest.mark.asyncio
async def test_synthesizes_session_idle_when_turn_end_arrives_without_idle():
    session = _create_test_session(fallback_delay=0.1)
    events: list[str] = []

    session.on(lambda event: events.append(event.type.value))

    session._dispatch_event(_make_turn_end_event())
    assert events == ["assistant.turn_end"]

    # Wait for the fallback timer to fire
    await asyncio.sleep(0.2)

    assert len(events) == 2
    assert events[1] == "session.idle"


@pytest.mark.asyncio
async def test_does_not_synthesize_idle_when_real_idle_arrives_in_time():
    session = _create_test_session(fallback_delay=0.2)
    events: list[str] = []

    session.on(lambda event: events.append(event.type.value))

    session._dispatch_event(_make_turn_end_event())
    assert events == ["assistant.turn_end"]

    # Real idle arrives before grace period
    await asyncio.sleep(0.05)
    session._dispatch_event(_make_idle_event())
    assert events == ["assistant.turn_end", "session.idle"]

    # Wait past the grace period — no duplicate idle
    await asyncio.sleep(0.3)
    assert len(events) == 2


@pytest.mark.asyncio
async def test_disconnect_cancels_pending_fallback_timer():
    session = _create_test_session(fallback_delay=0.1)
    events: list[str] = []

    session.on(lambda event: events.append(event.type.value))

    session._dispatch_event(_make_turn_end_event())
    assert events == ["assistant.turn_end"]

    # Cancel the timer (simulating the disconnect cleanup path)
    session._cancel_idle_fallback_timer()

    # Wait past the grace period — no synthetic idle should fire
    await asyncio.sleep(0.2)

    assert len(events) == 1
    assert events[0] == "assistant.turn_end"


@pytest.mark.asyncio
async def test_resets_fallback_timer_on_subsequent_turn_end():
    session = _create_test_session(fallback_delay=0.15)
    events: list[str] = []

    session.on(lambda event: events.append(event.type.value))

    session._dispatch_event(_make_turn_end_event())
    await asyncio.sleep(0.1)  # within grace period

    # Second turn_end resets the timer
    session._dispatch_event(_make_turn_end_event())
    await asyncio.sleep(0.1)  # 100ms after second turn_end, still within new grace

    assert events == ["assistant.turn_end", "assistant.turn_end"]

    # Wait for the timer to fire
    await asyncio.sleep(0.1)
    assert len(events) == 3
    assert events[2] == "session.idle"
