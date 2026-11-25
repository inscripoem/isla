#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Offline tests for the simple M1 speaking-mouth mode.

The tests use only the standard library.  They import the driver by path so no
packaging convention is required, build the real ``events`` table in an
in-memory SQLite database, and drive the pure state machine with fixtures.
No WASAPI, VTube Studio or token file is touched.
"""

from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "src" / "performance" / "lipsync" / "speaking_mouth.py"

_SPEC = importlib.util.spec_from_file_location("isla_speaking_mouth", MODULE_PATH)
assert _SPEC is not None and _SPEC.loader is not None
mouth = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = mouth
_SPEC.loader.exec_module(mouth)

SESSION = "session-1"
TURN = "turn-1"
SEGMENT = "segment-1"
OUTPUT = "output-1"


def output_key(
    session_id=SESSION,
    epoch=1,
    turn_id=TURN,
    segment_id=SEGMENT,
    output_id=OUTPUT,
):
    return mouth.OutputKey(session_id, epoch, turn_id, segment_id, output_id)


class FakeSocket:
    """In-memory WebSocket used to verify the synchronous request protocol."""

    def __init__(self, responder):
        self.responder = responder
        self.sent = []
        self.queue = []

    def send(self, raw):
        self.sent.append(json.loads(raw))

    def recv(self):
        if self.queue:
            return self.queue.pop(0)
        return json.dumps(self.responder(self.sent[-1]))

    def settimeout(self, value):
        del value

    def close(self):
        pass


class FakeWebSocketModule:
    def __init__(self, responder):
        self.responder = responder
        self.socket = None
        self.options = None

    def create_connection(self, url, **options):
        del url
        self.options = options
        self.socket = FakeSocket(self.responder)
        return self.socket


def install_fake_websocket(module):
    previous = sys.modules.get("websocket")
    sys.modules["websocket"] = module

    def restore():
        if previous is None:
            sys.modules.pop("websocket", None)
        else:
            sys.modules["websocket"] = previous

    return restore


def normal_vts_response(request):
    message_type = request["messageType"]
    base = {
        "apiName": mouth.VTS_API_NAME,
        "apiVersion": mouth.VTS_API_VERSION,
        "requestID": request["requestID"],
    }
    if message_type == "AuthenticationRequest":
        return dict(
            base,
            messageType="AuthenticationResponse",
            data={"authenticated": True},
        )
    if message_type == "CurrentModelRequest":
        return dict(
            base,
            messageType="CurrentModelResponse",
            data={"modelLoaded": True, "modelID": "model-1"},
        )
    if message_type == "InputParameterListRequest":
        return dict(
            base,
            messageType="InputParameterListResponse",
            data={
                "defaultParameters": [{"name": "MouthOpen"}],
                "customParameters": [{"name": "IslaMouthOpen"}],
            },
        )
    if message_type == "InjectParameterDataRequest":
        return dict(
            base,
            messageType="InjectParameterDataResponse",
            data={},
        )
    raise AssertionError("unexpected VTS request: " + message_type)


class Fixture:
    """One in-memory event database, tail and mouth state."""

    def __init__(self):
        self.connection = sqlite3.connect(":memory:")
        self.connection.execute(
            """
            CREATE TABLE events (
              session_id TEXT NOT NULL,
              event_id TEXT NOT NULL,
              seq INTEGER NOT NULL,
              timestamp_ms REAL NOT NULL,
              epoch INTEGER NOT NULL,
              turn_id TEXT,
              segment_id TEXT,
              output_id TEXT,
              type TEXT NOT NULL,
              source_module TEXT NOT NULL,
              versions TEXT,
              payload TEXT NOT NULL,
              PRIMARY KEY (session_id, event_id),
              UNIQUE (session_id, seq)
            )
            """
        )
        self.connection.commit()
        self.tail = mouth.EventTail(self.connection)
        self.state = mouth.MouthState()
        self._sequence = 0

    def append(
        self,
        event_type,
        payload,
        session_id=SESSION,
        epoch=1,
        turn_id=TURN,
        segment_id=SEGMENT,
        output_id=OUTPUT,
    ):
        self._sequence += 1
        self.connection.execute(
            """
            INSERT INTO events
              (session_id, event_id, seq, timestamp_ms, epoch, turn_id,
               segment_id, output_id, type, source_module, versions, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                "event-{}".format(self._sequence),
                self._sequence,
                float(self._sequence),
                epoch,
                turn_id,
                segment_id,
                output_id,
                event_type,
                "M5",
                None,
                json.dumps(payload, separators=(",", ":")),
            ),
        )
        self.connection.commit()

    def receipt(
        self,
        stage,
        reconciliation="record",
        session_id=SESSION,
        epoch=1,
        turn_id=TURN,
        segment_id=SEGMENT,
        output_id=OUTPUT,
        source="m1-player",
        modality="audio",
    ):
        receipt = {
            "receiptId": "receipt-{}".format(self._sequence + 1),
            "outputId": output_id,
            "sessionId": session_id,
            "epoch": epoch,
            "turnId": turn_id,
            "segmentId": segment_id,
            "modality": modality,
            "stage": stage,
            "localTimeMs": 1000 + self._sequence,
            "chunkIds": None,
            "reasonCode": None,
            "source": source,
        }
        self.append(
            "output.receipt",
            {"stage": stage, "reconciliation": reconciliation, "receipt": receipt},
            session_id=session_id,
            epoch=epoch,
            turn_id=turn_id,
            segment_id=segment_id,
            output_id=output_id,
        )

    def delivery_committed(
        self,
        output_id=OUTPUT,
        session_id=SESSION,
        epoch=1,
        turn_id=TURN,
        segment_id=SEGMENT,
        classification="fully-delivered",
    ):
        self.append(
            "delivery.committed",
            {"classification": classification},
            session_id=session_id,
            epoch=epoch,
            turn_id=turn_id,
            segment_id=segment_id,
            output_id=output_id,
        )

    def drive(self):
        transitions = []
        for event in self.tail.poll():
            transition = self.state.apply_event(event)
            if transition is not None:
                transitions.append(transition)
        return transitions

    def close(self):
        self.connection.close()


class ModuleBoundaryTests(unittest.TestCase):
    def test_import_does_not_load_windows_or_websocket_packages(self):
        for name in ("pycaw", "comtypes", "psutil", "websocket"):
            self.assertNotIn(name, sys.modules)

    def test_read_only_uri_uses_mode_ro_without_immutable(self):
        uri = mouth.read_only_uri("events.sqlite")
        self.assertTrue(uri.startswith("file:"))
        self.assertIn("mode=ro", uri)
        self.assertNotIn("immutable", uri)

    def test_url_validation_accepts_only_loopback_websockets(self):
        mouth._validate_url("ws://127.0.0.1:8001")
        mouth._validate_url("ws://localhost:8001/")
        mouth._validate_url("ws://[::1]:8001")
        for value in (
            "ws://10.0.0.5:8001",
            "wss://127.0.0.1:8001",
            "ws://127.0.0.1:8001/other",
            "ws://user:pass@127.0.0.1:8001",
            "ws://127.0.0.1:8001?query=1",
            "ws://[::1:8001",
        ):
            with self.assertRaises(mouth.UserError):
                mouth._validate_url(value)


class VtsProtocolTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeWebSocketModule(normal_vts_response)
        self.addCleanup(install_fake_websocket(self.fake))
        self.client = mouth.VtsClient("ws://127.0.0.1:8001")
        self.client.connect()

    def test_authentication_model_input_and_injection_use_the_product_identity(self):
        self.client.authenticate("dummy-token")
        self.assertEqual(self.client.current_model(), (True, "model-1"))
        self.assertTrue(self.client.input_exists("MouthOpen"))
        self.assertTrue(self.client.input_exists("IslaMouthOpen"))
        self.assertFalse(self.client.input_exists("NotThere"))
        self.client.inject("MouthOpen", 0.35)

        self.assertEqual(self.fake.options["enable_multithread"], False)
        self.assertEqual(self.fake.options["http_no_proxy"], ["127.0.0.1"])

        authentication = self.fake.socket.sent[0]
        self.assertEqual(authentication["messageType"], "AuthenticationRequest")
        self.assertEqual(authentication["data"]["pluginName"], "Isla Runtime")
        self.assertEqual(authentication["data"]["pluginDeveloper"], "CS5351 Isla")
        self.assertEqual(authentication["data"]["authenticationToken"], "dummy-token")

        injection = self.fake.socket.sent[-1]
        self.assertEqual(injection["messageType"], "InjectParameterDataRequest")
        self.assertEqual(
            injection["data"],
            {"mode": "set", "parameterValues": [{"id": "MouthOpen", "value": 0.35}]},
        )
        self.assertNotIn("faceFound", injection["data"])

    def test_unrelated_frames_are_skipped_by_request_id(self):
        self.fake.socket.queue.append(
            json.dumps(
                {
                    "apiName": mouth.VTS_API_NAME,
                    "apiVersion": mouth.VTS_API_VERSION,
                    "requestID": "another-request",
                    "messageType": "ModelLoadedEvent",
                    "data": {},
                }
            )
        )
        self.fake.socket.queue.append("this is not json")
        self.assertEqual(self.client.current_model(), (True, "model-1"))

    def test_api_error_is_bounded_and_never_repeats_raw_protocol_data(self):
        def reject(request):
            return {
                "apiName": mouth.VTS_API_NAME,
                "apiVersion": mouth.VTS_API_VERSION,
                "requestID": request["requestID"],
                "messageType": "APIError",
                "data": {"errorID": 50, "message": "token dummy-token rejected"},
            }

        fake = FakeWebSocketModule(reject)
        self.addCleanup(install_fake_websocket(fake))
        client = mouth.VtsClient("ws://127.0.0.1:8001")
        client.connect()
        with self.assertRaises(mouth.VtsError) as caught:
            client.authenticate("dummy-token")
        self.assertNotIn("dummy-token", str(caught.exception))
        self.assertNotIn("token dummy-token rejected", str(caught.exception))
        self.assertFalse(client.usable)


class EventTailTests(unittest.TestCase):
    def test_startup_baseline_skips_history_and_reads_only_new_rows(self):
        fixture = Fixture()
        try:
            fixture.receipt("started", output_id="historical")
            fixture.tail = mouth.EventTail(fixture.connection)

            self.assertEqual(fixture.tail.poll(), [])
            self.assertEqual(fixture.drive(), [])
            self.assertIsNone(fixture.state.active)

            fixture.receipt("started", output_id="live")
            events = fixture.tail.poll()
            self.assertEqual([event.output_id for event in events], ["live"])
            self.assertEqual(events[0].type, "output.receipt")
            self.assertEqual(events[0].payload["receipt"]["outputId"], "live")
        finally:
            fixture.close()

    def test_malformed_payload_is_skipped_without_stalling_the_tail(self):
        fixture = Fixture()
        try:
            fixture.connection.execute(
                """
                INSERT INTO events
                  (session_id, event_id, seq, timestamp_ms, epoch, turn_id,
                   segment_id, output_id, type, source_module, versions, payload)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    SESSION,
                    "bad-json",
                    0,
                    1.0,
                    1,
                    TURN,
                    SEGMENT,
                    OUTPUT,
                    "output.receipt",
                    "M5",
                    None,
                    "{not json",
                ),
            )
            fixture.connection.commit()
            fixture.receipt("started")
            events = fixture.tail.poll()
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].payload["receipt"]["stage"], "started")
        finally:
            fixture.close()


class StateTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()

    def tearDown(self):
        self.fixture.close()

    def test_accepted_never_activates(self):
        self.fixture.receipt("accepted")
        self.assertEqual(self.fixture.drive(), [])
        self.assertIsNone(self.fixture.state.active)

        self.fixture.receipt("started")
        changes = self.fixture.drive()
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0].reason, "output-started")
        self.assertEqual(self.fixture.state.active, output_key())

        self.fixture.receipt("accepted")
        self.assertEqual(self.fixture.drive(), [])
        self.assertEqual(self.fixture.state.active, output_key())

    def test_started_with_ignored_reconciliation_does_not_activate(self):
        self.fixture.receipt("started", reconciliation="ignore-regression")
        self.assertEqual(self.fixture.drive(), [])
        self.assertIsNone(self.fixture.state.active)

        self.fixture.receipt("started", reconciliation="record")
        self.fixture.drive()
        self.assertEqual(self.fixture.state.active, output_key())

    def test_receipts_from_other_source_or_modality_are_ignored(self):
        self.fixture.receipt("started", source="m1-other")
        self.fixture.receipt("started", modality="avatar")
        self.assertEqual(self.fixture.drive(), [])
        self.assertIsNone(self.fixture.state.active)

        self.fixture.receipt("started")
        self.fixture.drive()
        self.assertEqual(self.fixture.state.active, output_key())

    def test_completed_terminal_neutralizes_only_the_named_output(self):
        self.fixture.receipt("started")
        self.fixture.drive()
        self.assertEqual(self.fixture.state.active, output_key())

        self.fixture.receipt("completed", output_id="output-2")
        self.assertEqual(self.fixture.drive(), [])
        self.assertEqual(self.fixture.state.active, output_key())

        self.fixture.receipt("completed")
        changes = self.fixture.drive()
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0].reason, "output-completed")
        self.assertIsNone(self.fixture.state.active)

    def test_duplicate_started_does_not_rearm_retired_output(self):
        self.fixture.receipt("started")
        self.fixture.drive()
        self.fixture.receipt("completed")
        self.fixture.drive()
        self.assertIsNone(self.fixture.state.active)

        self.fixture.receipt("started", reconciliation="ignore-duplicate")
        self.fixture.receipt("started")
        self.assertEqual(self.fixture.drive(), [])
        self.assertIsNone(self.fixture.state.active)

    def test_stale_started_after_newer_epoch_is_ignored(self):
        self.fixture.receipt("started", epoch=2, output_id="output-new")
        self.fixture.drive()
        self.assertEqual(
            self.fixture.state.active, output_key(epoch=2, output_id="output-new")
        )

        self.fixture.receipt("started", epoch=1, output_id="output-old")
        self.assertEqual(self.fixture.drive(), [])
        self.assertEqual(
            self.fixture.state.active, output_key(epoch=2, output_id="output-new")
        )

        self.fixture.receipt("completed", epoch=2, output_id="output-new")
        self.fixture.drive()
        self.assertIsNone(self.fixture.state.active)
        self.fixture.receipt("started", epoch=1, output_id="output-old")
        self.assertEqual(self.fixture.drive(), [])
        self.assertIsNone(self.fixture.state.active)

    def test_stale_terminal_does_not_close_newer_active_output(self):
        self.fixture.receipt("started", epoch=2)
        self.fixture.drive()
        self.assertEqual(self.fixture.state.active, output_key(epoch=2))

        self.fixture.receipt("completed", epoch=1)
        self.assertEqual(self.fixture.drive(), [])
        self.assertEqual(self.fixture.state.active, output_key(epoch=2))

    def test_unknown_ignore_regression_is_ignored_and_authoritative_unknown_closes(self):
        self.fixture.receipt("started")
        self.fixture.drive()
        self.assertEqual(self.fixture.state.active, output_key())

        self.fixture.receipt("unknown", reconciliation="ignore-regression")
        self.assertEqual(self.fixture.drive(), [])
        self.assertEqual(self.fixture.state.active, output_key())

        self.fixture.receipt("unknown", reconciliation="record")
        changes = self.fixture.drive()
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0].reason, "output-unknown")
        self.assertIsNone(self.fixture.state.active)

    def test_session_stopped_neutralizes_and_blocks_late_start(self):
        self.fixture.receipt("started")
        self.fixture.drive()
        self.assertEqual(self.fixture.state.active, output_key())

        self.fixture.append("session.stopped", {"requestId": "stop-1"})
        changes = self.fixture.drive()
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0].reason, "session-stopped")
        self.assertIsNone(self.fixture.state.active)

        self.fixture.receipt("started", output_id="late-output")
        self.assertEqual(self.fixture.drive(), [])
        self.assertIsNone(self.fixture.state.active)

        self.fixture.append("session.resumed", {"requestId": "resume-1"})
        self.assertEqual(self.fixture.drive(), [])
        self.fixture.receipt("started", epoch=2, output_id="late-output")
        self.fixture.drive()
        self.assertEqual(
            self.fixture.state.active, output_key(epoch=2, output_id="late-output")
        )

    def test_session_stopped_row_epoch_fences_unseen_late_start(self):
        # Regression: the tail starts just before session.stopped (epoch=2),
        # so no receipt for the session has ever been observed.  The row's own
        # epoch must still fence the stopped session.
        self.fixture.append(
            "session.stopped", {"requestId": "stop-1"}, epoch=2
        )
        self.assertEqual(self.fixture.drive(), [])
        self.assertIsNone(self.fixture.state.active)

        # A delayed started from the stopped epoch must not open the mouth.
        self.fixture.receipt("started", epoch=1, output_id="late-output")
        self.assertEqual(self.fixture.drive(), [])
        self.assertIsNone(self.fixture.state.active)
        self.assertEqual(mouth.desired_open(self.fixture.state.active, 0.5), 0.0)

        # Resume into epoch 3: the resume row's epoch is now the accepted floor
        # and its started receipt activates.
        self.fixture.append(
            "session.resumed", {"requestId": "resume-1"}, epoch=3
        )
        self.assertEqual(self.fixture.drive(), [])
        self.fixture.receipt("started", epoch=3, output_id="live-output")
        changes = self.fixture.drive()
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0].reason, "output-started")
        live = output_key(epoch=3, output_id="live-output")
        self.assertEqual(self.fixture.state.active, live)

        # An ignored higher-epoch reconciliation row neither advances the
        # accepted floor nor disturbs the current active output.
        self.fixture.receipt(
            "started",
            reconciliation="ignore-regression",
            epoch=9,
            output_id="ignored-output",
        )
        self.assertEqual(self.fixture.drive(), [])
        self.assertEqual(self.fixture.state.active, live)

        # The still-valid frame keeps opening the mouth ...
        self.assertGreater(mouth.desired_open(self.fixture.state.active, 0.5), 0.0)

        # ... and the floor stayed at epoch 3: another started in epoch 3 still
        # replaces the output, which a floor advanced to epoch 9 would reject.
        self.fixture.receipt("started", epoch=3, output_id="next-output")
        changes = self.fixture.drive()
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0].reason, "output-replaced")
        self.assertEqual(changes[0].neutralized_key, live)
        self.assertEqual(
            self.fixture.state.active, output_key(epoch=3, output_id="next-output")
        )

    def test_stale_resume_cannot_release_stop_fence(self):
        # Regression: Stop2 followed by a lagging Resume1 must not release the
        # fence, so a later Start2 cannot reopen the stopped session.
        self.fixture.append(
            "session.stopped", {"requestId": "stop-1"}, epoch=2
        )
        self.assertEqual(self.fixture.drive(), [])

        self.fixture.append(
            "session.resumed", {"requestId": "resume-stale"}, epoch=1
        )
        self.assertEqual(self.fixture.drive(), [])

        self.fixture.receipt("started", epoch=2, output_id="still-stopped")
        self.assertEqual(self.fixture.drive(), [])
        self.assertIsNone(self.fixture.state.active)
        self.assertEqual(mouth.desired_open(self.fixture.state.active, 0.5), 0.0)

        # An accepted Resume2 after Stop2 still allows Start2.
        self.fixture.append(
            "session.resumed", {"requestId": "resume-2"}, epoch=2
        )
        self.assertEqual(self.fixture.drive(), [])

        self.fixture.receipt("started", epoch=2, output_id="still-stopped")
        changes = self.fixture.drive()
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0].reason, "output-started")
        self.assertEqual(
            self.fixture.state.active,
            output_key(epoch=2, output_id="still-stopped"),
        )
        self.assertGreater(mouth.desired_open(self.fixture.state.active, 0.5), 0.0)

    def test_session_stopped_for_another_session_does_not_close_active(self):
        self.fixture.receipt("started")
        self.fixture.drive()

        self.fixture.append(
            "session.stopped", {"requestId": "stop-other"}, session_id="session-2"
        )
        self.assertEqual(self.fixture.drive(), [])
        self.assertEqual(self.fixture.state.active, output_key())

    def test_new_session_started_replaces_active_output(self):
        self.fixture.receipt("started")
        self.fixture.drive()

        self.fixture.receipt("started", session_id="session-2", output_id="output-2")
        changes = self.fixture.drive()
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0].reason, "output-replaced")
        self.assertEqual(changes[0].neutralized_key, output_key())
        self.assertEqual(
            self.fixture.state.active,
            output_key(session_id="session-2", output_id="output-2"),
        )

    def test_delivery_committed_only_closes_the_matching_active_output(self):
        self.fixture.receipt("started", epoch=2)
        self.fixture.drive()
        self.assertEqual(self.fixture.state.active, output_key(epoch=2))

        self.fixture.delivery_committed(output_id="output-2", epoch=2)
        self.assertEqual(self.fixture.drive(), [])
        self.assertEqual(self.fixture.state.active, output_key(epoch=2))

        self.fixture.delivery_committed(epoch=2)
        changes = self.fixture.drive()
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0].reason, "delivery-committed")
        self.assertIsNone(self.fixture.state.active)


class LevelTests(unittest.TestCase):
    def test_multiple_peaks_map_monotonically_into_visible_range(self):
        peaks = [0.0, 0.001, 0.004, 0.01, 0.05, 0.15, 0.35, 0.7, 1.0]
        values = [mouth.map_peak_to_open(peak) for peak in peaks]

        self.assertEqual(values[0], 0.0)
        self.assertEqual(values[1], 0.0)
        self.assertEqual(values[2], 0.0)
        self.assertTrue(all(0.0 <= value <= 0.8 for value in values))
        self.assertTrue(all(left <= right for left, right in zip(values, values[1:])))
        self.assertGreater(values[4], 0.10)
        self.assertGreater(values[6], values[5])
        self.assertAlmostEqual(values[-1], 0.8)

    def test_invalid_and_silent_peaks_are_zero(self):
        for peak in (None, -1.0, float("nan"), float("inf"), 0.0, 0.001):
            self.assertEqual(mouth.map_peak_to_open(peak), 0.0)

    def test_idle_is_closed_and_active_silence_is_closed(self):
        active = output_key()
        self.assertEqual(mouth.desired_open(None, 0.5), 0.0)
        self.assertEqual(mouth.desired_open(active, 0.0), 0.0)
        self.assertEqual(mouth.desired_open(active, 0.001), 0.0)
        self.assertGreater(mouth.desired_open(active, 0.5), 0.0)

    def test_injection_payload_uses_the_selected_input_and_clamps(self):
        self.assertEqual(
            mouth.make_injection_data("MouthOpen", 0.35),
            {"mode": "set", "parameterValues": [{"id": "MouthOpen", "value": 0.35}]},
        )
        self.assertEqual(
            mouth.make_injection_data("IslaMouthOpen", 1.5)["parameterValues"][0]["value"],
            mouth.MAX_OPEN,
        )
        self.assertEqual(
            mouth.make_injection_data("IslaMouthOpen", -1.0)["parameterValues"][0]["value"],
            0.0,
        )


if __name__ == "__main__":
    unittest.main()
