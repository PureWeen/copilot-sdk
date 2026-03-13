"""
Tests for the fix: permission callback binding lost after session disposal.

Root cause: disposed sessions remained in the client's session map with a null
permission handler. In protocol v3 broadcast mode, permission.requested events
routed to disposed sessions were silently dropped (no RPC response), causing
the CLI to time out and deny with "denied-no-approval-rule-and-could-not-request-from-user".

Fix: (1) remove disposed sessions from the map, (2) guard _dispatch_event against
disposed sessions, (3) send an explicit denial when no handler is registered.
"""

import asyncio
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest

from copilot.generated.session_events import Data, SessionEvent, SessionEventType
from copilot.session import CopilotSession


def _make_event(event_type: SessionEventType, **data_kwargs) -> SessionEvent:
    """Helper to construct a SessionEvent for testing."""
    data = Data(**data_kwargs)
    return SessionEvent(
        data=data,
        id=uuid4(),
        timestamp=datetime.now(UTC),
        type=event_type,
    )


class TestSessionDisposal:
    @pytest.mark.asyncio
    async def test_on_disposed_callback_invoked_on_disconnect(self):
        """The _on_disposed callback should be called with the session_id on disconnect."""
        mock_client = MagicMock()
        mock_client.request = AsyncMock(return_value={})
        session = CopilotSession("sess-42", mock_client)
        session._register_permission_handler(lambda req, ctx: {"kind": "approved"})

        removed_ids = []
        session._on_disposed = lambda sid: removed_ids.append(sid)

        await session.disconnect()

        assert removed_ids == ["sess-42"]

    @pytest.mark.asyncio
    async def test_explicit_denial_when_no_permission_handler(self):
        """permission.requested with no handler should send an explicit denial via RPC."""
        mock_client = MagicMock()
        mock_client.request = AsyncMock(return_value={})
        session = CopilotSession("test-session", mock_client)
        # Do NOT register a permission handler

        event = _make_event(
            SessionEventType.PERMISSION_REQUESTED,
            request_id="req-1",
            permission_request={"type": "file_edit", "path": "/tmp/test.txt"},
        )
        session._dispatch_event(event)

        # Give the fire-and-forget asyncio.ensure_future a chance to run
        await asyncio.sleep(0.1)

        # Should have called session.permissions.handlePendingPermissionRequest with denial
        mock_client.request.assert_any_call(
            "session.permissions.handlePendingPermissionRequest",
            {
                "sessionId": "test-session",
                "requestId": "req-1",
                "result": {
                    "kind": "denied-no-approval-rule-and-could-not-request-from-user",
                },
            },
        )
