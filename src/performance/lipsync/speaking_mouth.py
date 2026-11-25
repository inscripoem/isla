#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Drive a VTube Studio mouth input from real Chromium speech output.

This is M1's first simple talking-mouth mode.  It follows the append-only
Isla event log read-only, waits for a correlated ``m1-player`` audio receipt,
and maps the peak level of the reporting Chromium process tree's Windows
default render session to a continuous mouth opening.

Safety boundaries
  * Only the named local SQLite event database is read, through URI ``mode=ro``.
  * Only the named local token file is read.  The value is never printed or
    logged.  The existing product identity ``Isla Runtime`` / ``CS5351 Isla``
    is used unchanged.
  * The VTube Studio WebSocket must be loopback.
  * Only the default render endpoint's session peak is observed.  No
    microphone, system mix or audio is captured, and no audio is persisted.
  * No camera, eye, model or hotkey is changed.  One selected input parameter
    is driven.

The Windows-only packages (``pycaw``, ``comtypes``, ``psutil`` and
``websocket-client``) are imported lazily by the hardware classes so the
state/level logic and its unit tests use only the standard library.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import signal
import sqlite3
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple
from urllib.parse import urlparse

PLUGIN_NAME = "Isla Runtime"
PLUGIN_DEVELOPER = "CS5351 Isla"
M1_PLAYER_SOURCE = "m1-player"
AUDIO_MODALITY = "audio"

VTS_API_NAME = "VTubeStudioPublicAPI"
VTS_API_VERSION = "1.0"

DEFAULT_URL = "ws://127.0.0.1:8001"
DEFAULT_INPUT = "MouthOpen"

POLL_SECONDS = 0.030
IDLE_KEEPALIVE_SECONDS = 0.450
MODEL_CHECK_SECONDS = 1.000
BROWSER_CHECK_SECONDS = 0.500
SESSION_REFRESH_SECONDS = 0.250
EMPTY_SESSION_REFRESH_SECONDS = 0.100
TREE_REFRESH_SECONDS = 2.000
SAMPLE_LOG_SECONDS = 0.250

CONNECT_TIMEOUT_SECONDS = 3.0
REQUEST_TIMEOUT_SECONDS = 2.0

MAX_OPEN = 0.8
NOISE_FLOOR = 0.005
COMPRESSION_EXPONENT = 0.6
MAX_EVENTS_PER_POLL = 500

TERMINAL_STAGES = frozenset(("completed", "cancelled", "failed"))
RECEIPT_STAGES = frozenset(("accepted", "started", "completed", "cancelled", "failed", "unknown"))
IGNORED_RECONCILIATIONS = frozenset(("ignore-duplicate", "ignore-regression", "conflict"))
AUTHORITATIVE_UNKNOWN = frozenset(("record", "resolve-unknown"))

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_RUNTIME = 3
EXIT_MODEL = 4

_LOOPBACK_HOSTS = frozenset(("127.0.0.1", "localhost", "::1"))
_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]+$")
_INPUT_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
_MAX_ID_LENGTH = 128


class MouthError(Exception):
    """A safe, actionable failure.  Messages never contain credentials."""

    exit_code = EXIT_RUNTIME
    reason = "error"


class UserError(MouthError):
    exit_code = EXIT_USAGE
    reason = "configuration"


class DatabaseError(MouthError):
    reason = "database"


class HardwareError(MouthError):
    reason = "hardware"


class VtsError(MouthError):
    reason = "vts"


class ModelError(MouthError):
    exit_code = EXIT_MODEL
    reason = "model-changed"


class BrowserGone(MouthError):
    exit_code = EXIT_OK
    reason = "browser-gone"


@dataclass(frozen=True)
class OutputKey:
    """The five receipt fields that identify one audible output."""

    session_id: str
    epoch: int
    turn_id: str
    segment_id: str
    output_id: str

    def as_log_value(self) -> Dict[str, Any]:
        return {
            "sessionId": self.session_id,
            "epoch": self.epoch,
            "turnId": self.turn_id,
            "segmentId": self.segment_id,
            "outputId": self.output_id,
        }


@dataclass(frozen=True)
class EventRow:
    rowid: int
    session_id: str
    epoch: int
    turn_id: Optional[str]
    segment_id: Optional[str]
    output_id: Optional[str]
    type: str
    payload: Dict[str, Any]


@dataclass(frozen=True)
class Receipt:
    key: OutputKey
    stage: str
    reconciliation: Optional[str]


@dataclass(frozen=True)
class MouthTransition:
    """A state change worth logging; at most one event produces one."""

    activated_key: Optional[OutputKey]
    neutralized_key: Optional[OutputKey]
    reason: str


def _is_text(value: Any, limit: int = 512) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= limit
        and value.isprintable()
    )


def _is_epoch(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def read_only_uri(path: str) -> str:
    """Return a SQLite URI that opens exactly ``path`` read-only.

    ``immutable=1`` is deliberately not used: the database is live and may be
    written by the runtime while this process reads newly appended events.
    """

    resolved = Path(os.path.abspath(os.path.expanduser(path)))
    return resolved.as_uri() + "?mode=ro"


class EventTail:
    """Incremental reader of new event rows, starting after the current end."""

    _SELECT = (
        "SELECT rowid, session_id, epoch, turn_id, segment_id, output_id, type, payload "
        "FROM events WHERE rowid > ? ORDER BY rowid LIMIT ?"
    )

    def __init__(self, connection: sqlite3.Connection, owns_connection: bool = False) -> None:
        self._connection = connection
        self._owns_connection = owns_connection
        self._last_rowid = self._max_rowid()

    @classmethod
    def open_read_only(cls, path: str) -> "EventTail":
        try:
            connection = sqlite3.connect(
                read_only_uri(path), uri=True, timeout=1.0
            )
        except sqlite3.Error as exc:
            raise DatabaseError("event database could not be opened read-only") from exc
        try:
            connection.execute("PRAGMA query_only = ON")
            connection.execute("PRAGMA busy_timeout = 1000")
        except sqlite3.Error as exc:
            connection.close()
            raise DatabaseError("event database could not be configured read-only") from exc
        try:
            return cls(connection, owns_connection=True)
        except Exception:
            connection.close()
            raise

    def _max_rowid(self) -> int:
        try:
            row = self._connection.execute("SELECT MAX(rowid) FROM events").fetchone()
        except sqlite3.Error as exc:
            raise DatabaseError("event database has no readable events table") from exc
        if row is None or row[0] is None:
            return 0
        return int(row[0])

    def poll(self) -> List[EventRow]:
        try:
            rows = self._connection.execute(
                self._SELECT, (self._last_rowid, MAX_EVENTS_PER_POLL)
            ).fetchall()
        except sqlite3.Error as exc:
            raise DatabaseError("event database read failed") from exc

        events: List[EventRow] = []
        for row in rows:
            # Advance for every row, including malformed ones, so one bad
            # payload cannot stall the tail forever.
            self._last_rowid = int(row[0])
            session_id, epoch, turn_id, segment_id, output_id = row[1:6]
            event_type = row[6]
            payload = _decode_payload(row[7])
            if (
                payload is None
                or not _is_text(session_id)
                or not _is_epoch(epoch)
                or not isinstance(event_type, str)
            ):
                continue
            events.append(
                EventRow(
                    rowid=int(row[0]),
                    session_id=session_id,
                    epoch=epoch,
                    turn_id=turn_id if _is_text(turn_id) else None,
                    segment_id=segment_id if _is_text(segment_id) else None,
                    output_id=output_id if _is_text(output_id) else None,
                    type=event_type,
                    payload=payload,
                )
            )
        return events

    def close(self) -> None:
        if not self._owns_connection:
            return
        try:
            self._connection.close()
        except sqlite3.Error:
            pass


def _decode_payload(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, str):
        return None
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def parse_output_receipt(event: EventRow) -> Optional[Receipt]:
    """Parse the nested receipt of an ``output.receipt`` event.

    Only M1's audio player receipts are considered.  The nested receipt is
    authoritative for the correlation key; the event row is not sufficient.
    """

    if event.type != "output.receipt":
        return None
    receipt = event.payload.get("receipt")
    if not isinstance(receipt, dict):
        return None
    if receipt.get("source") != M1_PLAYER_SOURCE:
        return None
    if receipt.get("modality") != AUDIO_MODALITY:
        return None

    stage = receipt.get("stage")
    if not isinstance(stage, str) or stage not in RECEIPT_STAGES:
        return None
    session_id = receipt.get("sessionId")
    epoch = receipt.get("epoch")
    turn_id = receipt.get("turnId")
    segment_id = receipt.get("segmentId")
    output_id = receipt.get("outputId")
    if not all(
        _is_text(value)
        for value in (session_id, turn_id, segment_id, output_id)
    ):
        return None
    if not _is_epoch(epoch):
        return None

    reconciliation = event.payload.get("reconciliation")
    if reconciliation is not None and not isinstance(reconciliation, str):
        return None

    return Receipt(
        key=OutputKey(
            session_id=session_id,
            epoch=epoch,
            turn_id=turn_id,
            segment_id=segment_id,
            output_id=output_id,
        ),
        stage=stage,
        reconciliation=reconciliation,
    )


class MouthState:
    """Authoritative mouth state derived only from persisted event evidence.

    Rules, in short:
      * ``started`` activates only when it is not stale and the output was not
        retired by a terminal event.
      * ``accepted`` never activates.  ``unknown`` neutralizes only when it is
        authoritative; ``ignore-regression``/``ignore-duplicate``/``conflict``
        observations change nothing.
      * A terminal receipt neutralizes only the output it names.  A late
        terminal for another output cannot override the active one.
      * ``session.stopped`` neutralizes the active output of that session and
        blocks late starts up to the stop row's own epoch, even when this
        process started reading just before the stop and never saw a receipt.
        ``session.resumed`` clears that block only when its own epoch is at
        least the stored stop fence and the accepted floor for the session,
        and raises the floor to the resume row's epoch; the next valid started
        receipt can activate.
      * A new session or a higher epoch on a started receipt replaces the
        active output.
    """

    def __init__(self) -> None:
        self.active: Optional[OutputKey] = None
        self._retired: Set[OutputKey] = set()
        self._epoch_floor: Dict[str, int] = {}
        self._stopped: Dict[str, int] = {}

    def apply_event(self, event: EventRow) -> Optional[MouthTransition]:
        if event.type == "output.receipt":
            receipt = parse_output_receipt(event)
            if receipt is None:
                return None
            # A reconciled observation the log itself marks as ignored is not
            # accepted evidence: it must not raise the epoch floor or touch the
            # active output.
            if receipt.reconciliation in IGNORED_RECONCILIATIONS:
                return None
            self._note_epoch(receipt.key.session_id, receipt.key.epoch)
            if receipt.stage == "started":
                return self._on_started(receipt.key)
            if receipt.stage in TERMINAL_STAGES:
                return self._on_terminal(receipt.key, receipt.stage)
            if receipt.stage == "unknown":
                if receipt.reconciliation in AUTHORITATIVE_UNKNOWN:
                    return self._on_terminal(receipt.key, "unknown")
            return None

        if event.type == "session.stopped":
            return self._on_session_stopped(event.session_id, event.epoch)
        if event.type == "session.resumed":
            return self._on_session_resumed(event.session_id, event.epoch)
        if event.type == "delivery.committed":
            return self._on_delivery_committed(event)
        return None

    def _note_epoch(self, session_id: str, epoch: int) -> None:
        current = self._epoch_floor.get(session_id)
        if current is None or epoch > current:
            self._epoch_floor[session_id] = epoch

    def _on_started(self, key: OutputKey) -> Optional[MouthTransition]:
        if key in self._retired:
            return None
        if self.active == key:
            return None

        stopped_at = self._stopped.get(key.session_id)
        if stopped_at is not None and key.epoch <= stopped_at:
            return None
        floor = self._epoch_floor.get(key.session_id)
        if floor is not None and key.epoch < floor:
            return None

        previous = self.active
        if previous is not None:
            self._retired.add(previous)
            self.active = None
        if stopped_at is not None and key.epoch > stopped_at:
            self._stopped.pop(key.session_id, None)

        self.active = key
        reason = "output-replaced" if previous is not None else "output-started"
        return MouthTransition(key, previous, reason)

    def _on_terminal(self, key: OutputKey, stage: str) -> Optional[MouthTransition]:
        self._retired.add(key)
        if self.active != key:
            # A late terminal from another output is evidence about that
            # output, not authority to close the active one.
            return None
        self.active = None
        return MouthTransition(None, key, "output-" + stage)

    def _on_session_stopped(
        self, session_id: str, epoch: int
    ) -> Optional[MouthTransition]:
        # The row's own epoch is authoritative even when this process started
        # reading just before the stop and has not observed any receipt for the
        # session yet.  Keep the fence monotonic with the accepted floor and the
        # active output so a lagging row cannot lower it.
        stop_epoch = epoch
        floor = self._epoch_floor.get(session_id)
        if floor is not None:
            stop_epoch = max(stop_epoch, floor)
        active = self.active
        if active is not None and active.session_id == session_id:
            stop_epoch = max(stop_epoch, active.epoch)
        self._stopped[session_id] = max(self._stopped.get(session_id, 0), stop_epoch)
        self._note_epoch(session_id, stop_epoch)

        if active is None or active.session_id != session_id:
            # A stop for another (usually older) session does not close the
            # active output, but it still blocks late starts from its session.
            return None

        self._retired.add(active)
        self.active = None
        return MouthTransition(None, active, "session-stopped")

    def _on_session_resumed(
        self, session_id: str, epoch: int
    ) -> Optional[MouthTransition]:
        # The resume row names the epoch that is now live.  Only a resume at or
        # beyond both the stored stop fence and the accepted floor may release
        # that fence; a lagging resume must not reopen a stopped session.
        stopped_at = self._stopped.get(session_id)
        if stopped_at is not None and epoch < stopped_at:
            return None
        floor = self._epoch_floor.get(session_id)
        if floor is not None and epoch < floor:
            return None
        self._stopped.pop(session_id, None)
        self._note_epoch(session_id, epoch)
        return None

    def _on_delivery_committed(self, event: EventRow) -> Optional[MouthTransition]:
        key = _key_from_event_columns(event)
        if key is not None:
            self._retired.add(key)
        active = self.active
        if active is None or event.output_id != active.output_id:
            return None
        if event.session_id != active.session_id or event.epoch != active.epoch:
            return None
        if event.turn_id is not None and event.turn_id != active.turn_id:
            return None
        if event.segment_id is not None and event.segment_id != active.segment_id:
            return None

        self.active = None
        return MouthTransition(None, active, "delivery-committed")


def _key_from_event_columns(event: EventRow) -> Optional[OutputKey]:
    if not (
        _is_text(event.turn_id)
        and _is_text(event.segment_id)
        and _is_text(event.output_id)
    ):
        return None
    return OutputKey(
        session_id=event.session_id,
        epoch=event.epoch,
        turn_id=event.turn_id,
        segment_id=event.segment_id,
        output_id=event.output_id,
    )


def map_peak_to_open(peak: Optional[float]) -> float:
    """Map a WASAPI session peak to a continuous visible mouth opening.

    A small noise floor suppresses silence, and a mild power curve (0.6)
    compresses loudness so ordinary speech remains clearly visible.  The result
    is always in ``[0, MAX_OPEN]``; silence is exactly zero.
    """

    if peak is None:
        return 0.0
    try:
        value = float(peak)
    except (TypeError, ValueError, OverflowError):
        return 0.0
    if not math.isfinite(value) or value <= NOISE_FLOOR:
        return 0.0
    normalized = min(1.0, (value - NOISE_FLOOR) / (1.0 - NOISE_FLOOR))
    if normalized <= 0.0:
        return 0.0
    return MAX_OPEN * (normalized ** COMPRESSION_EXPONENT)


def desired_open(active: Optional[OutputKey], peak: Optional[float]) -> float:
    """Return the opening to request for this poll."""

    if active is None:
        return 0.0
    return map_peak_to_open(peak)


def make_injection_data(input_name: str, opening: float) -> Dict[str, Any]:
    """Build the documented ``InjectParameterDataRequest`` payload."""

    try:
        numeric = float(opening)
    except (TypeError, ValueError, OverflowError):
        numeric = 0.0
    if not math.isfinite(numeric):
        numeric = 0.0
    value = min(MAX_OPEN, max(0.0, numeric))
    return {
        "mode": "set",
        "parameterValues": [{"id": input_name, "value": value}],
    }


class JsonlLog:
    """Append-only JSONL operator log.  No token or raw protocol is written."""

    def __init__(self, path: str) -> None:
        self._file = open(path, "a", encoding="utf-8", buffering=1)

    def write(self, event: str, **fields: Any) -> None:
        record: Dict[str, Any] = {"ts": int(time.time() * 1000), "event": event}
        record.update(fields)
        self._file.write(
            json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"
        )
        self._file.flush()

    def close(self) -> None:
        try:
            self._file.close()
        except Exception:
            pass


class NullLog:
    def write(self, event: str, **fields: Any) -> None:
        del event, fields

    def close(self) -> None:
        pass


def _load_websocket() -> Any:
    try:
        import websocket  # type: ignore
    except ImportError as exc:
        raise HardwareError(
            "websocket-client is required for VTube Studio output "
            "(install websocket-client)"
        ) from exc
    return websocket


def _load_audio_modules() -> Tuple[Any, Any, Any, Any]:
    try:
        import comtypes  # noqa: F401
        import psutil  # type: ignore
        from pycaw.pycaw import AudioUtilities
    except ImportError as exc:
        raise HardwareError(
            "pycaw, comtypes and psutil are required for Windows audio levels "
            "(install pycaw comtypes psutil)"
        ) from exc
    try:
        from pycaw.pycaw import (
            IAudioMeterInformation,
            IAudioSessionControl2,
            ISimpleAudioVolume,
        )
    except ImportError:
        try:
            from pycaw.api.audioclient import ISimpleAudioVolume
            from pycaw.api.audiopolicy import IAudioSessionControl2
            from pycaw.api.endpointvolume import IAudioMeterInformation
        except ImportError as exc:
            raise HardwareError(
                "the installed pycaw package does not expose the required "
                "Windows audio interfaces"
            ) from exc
    return (
        AudioUtilities,
        IAudioSessionControl2,
        IAudioMeterInformation,
        ISimpleAudioVolume,
    )


def _open_loopback_socket(websocket: Any, url: str, host: str) -> Any:
    """Open ``url`` directly, ignoring any configured HTTP proxy.

    websocket-client consults the standard proxy environment.  A loopback
    connection must not be routed through an unrelated proxy even when the
    operator's machine sets one globally.
    """

    saved = {name: os.environ.get(name) for name in ("no_proxy", "NO_PROXY")}
    os.environ["no_proxy"] = "*"
    os.environ["NO_PROXY"] = "*"
    try:
        return websocket.create_connection(
            url,
            timeout=CONNECT_TIMEOUT_SECONDS,
            enable_multithread=False,
            http_no_proxy=[host],
        )
    finally:
        for name, value in saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


class VtsClient:
    """Persistent, synchronous VTube Studio public-API client."""

    def __init__(self, url: str) -> None:
        self._url = url
        self._socket: Any = None
        self._usable = False

    @property
    def usable(self) -> bool:
        return self._usable and self._socket is not None

    def connect(self) -> None:
        _validate_url(self._url)
        websocket = _load_websocket()
        host = urlparse(self._url).hostname or "127.0.0.1"
        try:
            self._socket = _open_loopback_socket(websocket, self._url, host)
        except Exception as exc:
            raise HardwareError(
                "could not connect to the local VTube Studio WebSocket; "
                "ensure VTube Studio is running and its API is enabled"
            ) from exc
        self._usable = True

    def close(self) -> None:
        self._usable = False
        socket = self._socket
        self._socket = None
        if socket is None:
            return
        try:
            socket.close()
        except Exception:
            pass

    def authenticate(self, token: str) -> None:
        data = self._request(
            "AuthenticationRequest",
            {
                "pluginName": PLUGIN_NAME,
                "pluginDeveloper": PLUGIN_DEVELOPER,
                "authenticationToken": token,
            },
            "AuthenticationResponse",
        )
        if not isinstance(data, dict) or data.get("authenticated") is not True:
            self.close()
            raise VtsError(
                "VTube Studio did not authenticate the existing Isla Runtime "
                "plugin token; confirm the token file and the one-time approval"
            )

    def current_model(self) -> Tuple[bool, str]:
        data = self._request("CurrentModelRequest", {}, "CurrentModelResponse")
        if not isinstance(data, dict):
            raise VtsError("VTube Studio returned an invalid current-model response")
        loaded = data.get("modelLoaded")
        model_id = data.get("modelID")
        if not isinstance(loaded, bool) or not isinstance(model_id, str):
            raise VtsError("VTube Studio returned an invalid current-model response")
        return loaded, model_id

    def input_exists(self, input_name: str) -> bool:
        data = self._request(
            "InputParameterListRequest", {}, "InputParameterListResponse"
        )
        if not isinstance(data, dict):
            raise VtsError("VTube Studio returned an invalid input-parameter response")
        names: Set[str] = set()
        for field in ("defaultParameters", "customParameters"):
            values = data.get(field)
            if values is None:
                continue
            if not isinstance(values, list):
                raise VtsError(
                    "VTube Studio returned an invalid input-parameter response"
                )
            for entry in values:
                if isinstance(entry, dict) and _is_text(entry.get("name")):
                    names.add(entry["name"])
        return input_name in names

    def inject(self, input_name: str, opening: float) -> None:
        self._request(
            "InjectParameterDataRequest",
            make_injection_data(input_name, opening),
            "InjectParameterDataResponse",
        )

    def _request(
        self, message_type: str, data: Dict[str, Any], response_type: str
    ) -> Any:
        if not self.usable:
            raise VtsError("VTube Studio connection is not usable")

        request_id = "isla-mouth-" + uuid.uuid4().hex
        message = {
            "apiName": VTS_API_NAME,
            "apiVersion": VTS_API_VERSION,
            "requestID": request_id,
            "messageType": message_type,
            "data": data,
        }
        try:
            self._socket.send(json.dumps(message, separators=(",", ":")))
            deadline = time.monotonic() + REQUEST_TIMEOUT_SECONDS
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0.0:
                    raise VtsError("VTube Studio did not answer in time")
                self._socket.settimeout(remaining)
                raw = self._socket.recv()
                if raw is None or raw == "" or raw == b"":
                    raise VtsError("VTube Studio closed the connection")
                if isinstance(raw, bytes):
                    try:
                        raw = raw.decode("utf-8")
                    except UnicodeDecodeError:
                        continue
                try:
                    envelope = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                if not isinstance(envelope, dict):
                    continue
                if envelope.get("requestID") != request_id:
                    continue
                if (
                    envelope.get("apiName") != VTS_API_NAME
                    or envelope.get("apiVersion") != VTS_API_VERSION
                ):
                    raise VtsError("VTube Studio returned an invalid protocol envelope")
                if envelope.get("messageType") == "APIError":
                    raise VtsError(
                        "VTube Studio rejected the {} request".format(message_type)
                    )
                if envelope.get("messageType") != response_type:
                    raise VtsError("VTube Studio returned an unexpected response")
                return envelope.get("data")
        except VtsError:
            self.close()
            raise
        except Exception as exc:
            self.close()
            raise VtsError("VTube Studio connection failed") from exc


class BrowserAudioPeak:
    """Peak level of the named browser process tree on the default render sink."""

    def __init__(self, browser_pid: int) -> None:
        (
            self._audio_utilities,
            self._control2,
            self._meter,
            self._volume,
        ) = _load_audio_modules()
        self._browser_pid = int(browser_pid)
        self._descendants: Set[int] = set()
        self._sessions: List[Tuple[Any, Any]] = []
        self._last_tree_refresh = 0.0
        self._last_session_refresh = 0.0

        import psutil  # type: ignore

        self._psutil = psutil
        try:
            self._refresh_tree(force=True)
        except BrowserGone as exc:
            # A wrong or already-exited PID supplied at startup is an
            # actionable configuration error, not a successful natural exit.
            raise UserError(str(exc)) from exc
        self.refresh_sessions(force=True)

    def browser_alive(self) -> bool:
        try:
            return bool(self._psutil.pid_exists(self._browser_pid))
        except Exception:
            return False

    def refresh(self, force: bool = False) -> None:
        self._refresh_tree(force=force)
        self.refresh_sessions(force=force)

    def _refresh_tree(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_tree_refresh < TREE_REFRESH_SECONDS:
            return
        self._last_tree_refresh = now
        try:
            process = self._psutil.Process(self._browser_pid)
            children = process.children(recursive=True)
        except self._psutil.NoSuchProcess as exc:
            raise BrowserGone(
                "browser process {} is gone".format(self._browser_pid)
            ) from exc
        except Exception as exc:
            raise HardwareError("could not read the browser process tree") from exc

        descendants = {self._browser_pid}
        for child in children:
            try:
                descendants.add(int(child.pid))
            except Exception:
                continue
        self._descendants = descendants

    def refresh_sessions(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_session_refresh < SESSION_REFRESH_SECONDS:
            return
        self._last_session_refresh = now

        sessions: List[Tuple[Any, Any]] = []
        try:
            speakers = self._audio_utilities.GetSpeakers()
            manager = speakers.AudioSessionManager
            enumerator = manager.GetSessionEnumerator()
            count = int(enumerator.GetCount())
            for index in range(count):
                try:
                    session = enumerator.GetSession(index)
                    control = session.QueryInterface(self._control2)
                    process_id = int(control.GetProcessId())
                    if process_id not in self._descendants:
                        continue
                    meter = control.QueryInterface(self._meter)
                    volume = control.QueryInterface(self._volume)
                    sessions.append((meter, volume))
                except Exception:
                    # One expired or inaccessible session must not hide the
                    # other sessions of the same browser tree.
                    continue
        except Exception as exc:
            raise HardwareError(
                "could not read the Windows default render session list"
            ) from exc
        self._sessions = sessions

    def read_peak(self) -> float:
        self._refresh_tree()
        if not self._sessions:
            # A newly started output may create its audio session only once
            # playback begins.  Look for it more often than the normal refresh
            # cadence, but do not enumerate at every 30 ms poll.
            if (
                time.monotonic() - self._last_session_refresh
                >= EMPTY_SESSION_REFRESH_SECONDS
            ):
                # Also refresh the tree: a Chromium audio utility may have been
                # spawned since the last process-tree scan.
                self.refresh(force=True)
        else:
            self.refresh_sessions()

        peak = 0.0
        broken = False
        for meter, volume in self._sessions:
            try:
                if int(volume.GetMute()) != 0:
                    continue
                value = float(meter.GetPeakValue())
            except Exception:
                broken = True
                continue
            if math.isfinite(value) and value > peak:
                peak = value
        if broken:
            self.refresh_sessions(force=True)
        return max(0.0, min(1.0, peak))


class _StopFlag:
    def __init__(self) -> None:
        self.requested = False
        self.reason: Optional[str] = None

    def request(self, reason: str) -> None:
        if not self.requested:
            self.requested = True
            self.reason = reason


def _install_signal_handlers(stop: _StopFlag) -> Dict[int, Any]:
    previous: Dict[int, Any] = {}

    def handle(signum: int, frame: Any) -> None:
        del signum, frame
        stop.request("signal")

    for name in ("SIGINT", "SIGTERM"):
        signum = getattr(signal, name, None)
        if signum is None:
            continue
        try:
            previous[signum] = signal.getsignal(signum)
            signal.signal(signum, handle)
        except (ValueError, OSError):
            continue
    return previous


def _restore_signal_handlers(previous: Dict[int, Any]) -> None:
    for signum, handler in previous.items():
        try:
            signal.signal(signum, handler)
        except (ValueError, OSError, TypeError):
            pass


def _read_token(path: str) -> str:
    try:
        if os.path.getsize(path) > 16_384:
            raise UserError("token file is too large")
        with open(path, "r", encoding="utf-8") as handle:
            content = handle.read()
    except (OSError, UnicodeError) as exc:
        raise UserError("token file could not be read") from exc

    token = content.lstrip("\ufeff").strip()
    if (
        not token
        or len(token) > 4096
        or any(character.isspace() for character in token)
    ):
        raise UserError("token file must contain one authentication token")
    return token


def _verify_model(vts: VtsClient, expected_model_id: str) -> None:
    loaded, model_id = vts.current_model()
    if not loaded:
        raise ModelError("VTube Studio has no model loaded")
    if model_id != expected_model_id:
        raise ModelError(
            "active VTube Studio model is {!r}, expected {!r}; "
            "mouth output stopped".format(
                _safe_display(model_id), _safe_display(expected_model_id)
            )
        )


def _safe_display(value: Any, limit: int = 64) -> str:
    if not isinstance(value, str):
        return "<invalid>"
    text = "".join(character for character in value if character.isprintable())
    if not text:
        return "<invalid>"
    return text[:limit]


def _open_log(path: Optional[str]) -> Any:
    if not path:
        return NullLog()
    try:
        return JsonlLog(path)
    except OSError as exc:
        raise UserError("log file could not be opened") from exc


def _stop_reason(stop: _StopFlag) -> str:
    return stop.reason if stop.reason is not None else "stop"


def run(args: argparse.Namespace) -> int:
    log: Any = NullLog()
    tail: Optional[EventTail] = None
    audio: Optional[BrowserAudioPeak] = None
    vts: Optional[VtsClient] = None
    state = MouthState()
    stop = _StopFlag()
    previous_handlers = _install_signal_handlers(stop)
    model_lost = False
    exit_code = EXIT_RUNTIME
    stop_reason = "error"

    try:
        log = _open_log(args.log)
        log.write("startup", modelId=args.model_id, input=args.input)

        tail = EventTail.open_read_only(args.db)
        audio = BrowserAudioPeak(args.browser_pid)
        token = _read_token(args.token_file)

        vts = VtsClient(args.url)
        vts.connect()
        vts.authenticate(token)
        token = ""
        _verify_model(vts, args.model_id)
        if not vts.input_exists(args.input):
            raise UserError(
                "input parameter {!r} is not available in the active VTube "
                "Studio model".format(args.input)
            )
        # The parameter-list response could race a model switch; re-verify
        # before the first write.
        _verify_model(vts, args.model_id)
        vts.inject(args.input, 0.0)
        log.write(
            "ready",
            active=None,
            peak=0.0,
            requestedOpen=0.0,
            reason="ready",
        )

        last_idle_send = time.monotonic()
        last_model_check = last_idle_send
        last_browser_check = last_idle_send
        last_sample_log = 0.0
        next_tick = time.monotonic()

        while not stop.requested:
            now = time.monotonic()

            if args.stop_file and os.path.exists(args.stop_file):
                stop.request("stop-file")
                break
            if now - last_browser_check >= BROWSER_CHECK_SECONDS:
                last_browser_check = now
                if not audio.browser_alive():
                    stop.request("browser-gone")
                    break

            forced_neutral = False
            activated_key: Optional[OutputKey] = None
            activation_reason: Optional[str] = None
            for event in tail.poll():
                transition = state.apply_event(event)
                if transition is None:
                    continue
                if transition.neutralized_key is not None:
                    forced_neutral = True
                    log.write(
                        "change",
                        active=transition.neutralized_key.as_log_value(),
                        peak=0.0,
                        requestedOpen=0.0,
                        reason=transition.reason,
                    )
                if transition.activated_key is not None:
                    activated_key = transition.activated_key
                    activation_reason = transition.reason

            if stop.requested:
                break

            now = time.monotonic()
            if state.active is None:
                # Close immediately before any blocking readback.  A terminal
                # or Stop must never wait for a model check.
                if forced_neutral:
                    vts.inject(args.input, 0.0)
                    last_idle_send = now
                if now - last_model_check >= MODEL_CHECK_SECONDS:
                    _verify_model(vts, args.model_id)
                    last_model_check = now
                if (
                    not forced_neutral
                    and now - last_idle_send >= IDLE_KEEPALIVE_SECONDS
                ):
                    vts.inject(args.input, 0.0)
                    last_idle_send = now
            else:
                if (
                    activated_key is not None
                    or now - last_model_check >= MODEL_CHECK_SECONDS
                ):
                    _verify_model(vts, args.model_id)
                    last_model_check = time.monotonic()
                if activated_key is not None:
                    audio.refresh(force=True)
                peak = audio.read_peak()
                opening = map_peak_to_open(peak)
                vts.inject(args.input, opening)
                if activated_key is not None:
                    log.write(
                        "change",
                        active=state.active.as_log_value(),
                        peak=round(peak, 4),
                        requestedOpen=round(opening, 4),
                        reason=activation_reason or "output-started",
                    )
                elif now - last_sample_log >= SAMPLE_LOG_SECONDS:
                    log.write(
                        "sample",
                        active=state.active.as_log_value(),
                        peak=round(peak, 4),
                        requestedOpen=round(opening, 4),
                        reason="active",
                    )
                    last_sample_log = now

            next_tick += POLL_SECONDS
            delay = next_tick - time.monotonic()
            if delay > 0.0:
                time.sleep(delay)
            else:
                # A slow request has already consumed this poll interval.
                next_tick = time.monotonic()

        stop_reason = _stop_reason(stop)
        exit_code = EXIT_OK
    except BrowserGone:
        stop_reason = "browser-gone"
        exit_code = EXIT_OK
    except ModelError as exc:
        model_lost = True
        stop_reason = "model-changed"
        exit_code = EXIT_MODEL
        _safe_stderr(str(exc))
    except MouthError as exc:
        stop_reason = exc.reason
        exit_code = exc.exit_code
        _safe_stderr(str(exc))
    except Exception:
        stop_reason = "unexpected-error"
        exit_code = EXIT_RUNTIME
        _safe_stderr("unexpected local failure")
    finally:
        # A model change means this process must not write another frame, even
        # a neutral one.  Otherwise make one final best-effort neutral write.
        if vts is not None and vts.usable and not model_lost:
            try:
                vts.inject(args.input, 0.0)
            except Exception:
                if exit_code == EXIT_OK:
                    exit_code = EXIT_RUNTIME
                if not stop_reason.endswith("+neutral-failed"):
                    stop_reason += "+neutral-failed"
                _safe_stderr("final mouth neutral write failed")

        try:
            log.write(
                "stop",
                active=state.active.as_log_value() if state.active is not None else None,
                peak=0.0,
                requestedOpen=0.0,
                reason=stop_reason,
                exitCode=exit_code,
            )
        except Exception:
            pass
        if vts is not None:
            vts.close()
        if tail is not None:
            tail.close()
        log.close()
        _restore_signal_handlers(previous_handlers)

    return exit_code


def _safe_stderr(message: str) -> None:
    try:
        print("speaking_mouth: " + message, file=sys.stderr)
    except Exception:
        pass


def _validate_url(value: str) -> None:
    try:
        parsed = urlparse(value)
        port = parsed.port
        host = parsed.hostname
    except ValueError as exc:
        raise UserError("--url must be a loopback ws:// URL") from exc
    if (
        parsed.scheme != "ws"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
    ):
        raise UserError("--url must be a loopback ws:// URL without credentials")
    if (host or "").lower() not in _LOOPBACK_HOSTS:
        raise UserError("--url must use a loopback host")
    if port is None or not 1 <= port <= 65_535:
        raise UserError("--url must include a valid port")


def _validate_args(args: argparse.Namespace) -> None:
    if args.browser_pid <= 0:
        raise UserError("--browser-pid must be a positive process id")
    _validate_url(args.url)
    if not os.path.isfile(args.db):
        raise UserError("--db must name an existing SQLite event database")
    if not os.path.isfile(args.token_file):
        raise UserError("--token-file must name an existing local token file")
    if args.log:
        log_path = os.path.normcase(os.path.abspath(args.log))
        for label, path in (
            ("event database", args.db),
            ("token file", args.token_file),
        ):
            if log_path == os.path.normcase(os.path.abspath(path)):
                raise UserError("--log must not be the " + label)
    if (
        not isinstance(args.model_id, str)
        or not 0 < len(args.model_id) <= _MAX_ID_LENGTH
        or _MODEL_ID_RE.fullmatch(args.model_id) is None
    ):
        raise UserError("--model-id must be a non-empty model identifier")
    if (
        not isinstance(args.input, str)
        or _INPUT_NAME_RE.fullmatch(args.input) is None
    ):
        raise UserError("--input must be a VTube Studio input parameter name")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Drive one VTube Studio mouth input from the real peak level of a "
            "Chromium process tree's default render session."
        )
    )
    parser.add_argument("--db", required=True, help="Isla SQLite event database")
    parser.add_argument("--browser-pid", required=True, type=int, help="browser root PID")
    parser.add_argument("--token-file", required=True, help="local VTS token file")
    parser.add_argument("--model-id", required=True, help="expected active VTS model ID")
    parser.add_argument("--url", default=DEFAULT_URL, help="loopback VTS WebSocket URL")
    parser.add_argument(
        "--input",
        default=DEFAULT_INPUT,
        help="selected VTS input parameter (default: MouthOpen)",
    )
    parser.add_argument("--log", default=None, help="optional JSONL log path")
    parser.add_argument("--stop-file", default=None, help="optional stop-file path")
    return parser


def main(argv: Optional[Iterable[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    args.db = os.path.expanduser(args.db)
    args.token_file = os.path.expanduser(args.token_file)
    if args.log:
        args.log = os.path.expanduser(args.log)
    if args.stop_file:
        args.stop_file = os.path.expanduser(args.stop_file)

    try:
        _validate_args(args)
    except MouthError as exc:
        _safe_stderr(str(exc))
        return exc.exit_code

    return run(args)


if __name__ == "__main__":
    sys.exit(main())
