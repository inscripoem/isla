#!/usr/bin/env python3
"""Prepare an independent VTube Studio copy for simple speaking-mouth control.

The copy is a byte-preserving duplicate of the supplied stock model directory
except for two things:

* the root VTube Studio settings file, which gets a new model identity, new
  hotkey identities and three dedicated mouth inputs; and
* motion files that contain mouth curves, from which only those curves and the
  corresponding Cubism motion counters are removed.

This does not rebuild Cubism keyforms, art meshes or texture data.  It is a
portable deployment preparation tool, not a model-authoring tool.

Model files are copied from the supplied source only.  References and
filesystem links are not followed outside that source, and an existing
destination is reused only when its own manifest, profile and motion data all
validate against that source.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import os
import re
import shutil
import stat
import sys
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

MANIFEST_NAME = "isla-speaking-model.json"
SCHEMA_VERSION = 1
GENERATOR = "isla-speaking-model"
SPEAKING_NAME = "Hiyori - Isla Speaking"

INPUT_OPEN = "IslaMouthOpen"
INPUT_FORM = "IslaMouthForm"
INPUT_X = "IslaMouthX"

INPUTS = {"open": INPUT_OPEN, "form": INPUT_FORM, "x": INPUT_X}

# animation key, required motion basename (case-insensitive comparison)
ANIMATION_TARGETS = (
    ("animation-1", "hiyori_m03.motion3.json"),
    ("animation-2", "hiyori_m06.motion3.json"),
    ("animation-3", "hiyori_m10.motion3.json"),
)

# Live2D output parameter -> (input key, lower, upper)
MOUTH_PARAMETERS = {
    "ParamMouthOpenY": ("open", 0.0, 1.0),
    "ParamMouthForm": ("form", -1.0, 1.0),
    "ParamMouthX": ("x", -1.0, 1.0),
}

MOUTH_CURVE_IDS = frozenset(("ParamMouthOpenY", "ParamMouthForm", "ParamMouthX"))
UUID4_HEX = re.compile(r"[0-9a-f]{32}")
WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:")
COUNT_KEYS = ("CurveCount", "TotalSegmentCount", "TotalPointCount")
MOC3_SIGNATURE = b"MOC3"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MIN_ASSET_BYTES = 8


class ToolError(Exception):
    """A clear, user-facing preparation failure."""


@dataclass
class MotionInfo:
    rel: str
    data: Dict[str, Any]
    expected: Optional[Dict[str, Any]] = None

    @property
    def changed(self) -> bool:
        return self.expected is not None


@dataclass
class SourceInfo:
    profile_rel: str
    profile: Dict[str, Any]
    files: Dict[str, Path]
    dirs: List[str]
    motions: List[MotionInfo]
    hotkeys: List[Dict[str, Any]]
    semantic_hotkeys: Dict[str, int]
    source_model_id: str
    mouth_row_indices: Dict[str, int]
    mouth_output_ranges: Dict[str, Tuple[float, float]]
    model3_rel: str
    moc_rel: str
    texture_rels: List[str]

    @property
    def required_assets(self) -> Dict[str, str]:
        assets = {self.model3_rel: "model3", self.moc_rel: "moc3"}
        for rel in self.texture_rels:
            assets[rel] = "texture"
        return assets


def fail(message: str) -> None:
    raise ToolError(message)


def is_link_like(path: Path) -> bool:
    """Return True for symlinks, junctions and other reparse-point entries."""
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(info.st_mode):
        return True
    attributes = getattr(info, "st_file_attributes", 0)
    flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    return bool(flag and attributes & flag)


def relative_posix(path: Path, root: Path) -> str:
    return "/".join(path.relative_to(root).parts)


def from_relative(root: Path, rel: str) -> Path:
    return root.joinpath(*rel.split("/"))


def path_identity(path: Path) -> str:
    return os.path.normcase(os.path.abspath(os.fspath(path)))


def scan_tree(root: Path, label: str) -> Tuple[Dict[str, Path], List[str]]:
    """List regular files and directories without following links."""
    if is_link_like(root):
        fail("%s must not be a filesystem link" % label)
    if not root.is_dir():
        fail("%s must be an existing directory" % label)

    files: Dict[str, Path] = {}
    dirs: List[str] = []

    def raise_walk_error(exc: OSError) -> None:
        raise exc

    walker = os.walk(
        os.fspath(root), topdown=True, onerror=raise_walk_error, followlinks=False
    )
    for dirpath, dirnames, filenames in walker:
        base = Path(dirpath)
        dirnames.sort()
        filenames.sort()
        for dirname in list(dirnames):
            path = base / dirname
            if is_link_like(path):
                fail("%s contains a filesystem link: %s" % (label, relative_posix(path, root)))
            dirs.append(relative_posix(path, root))
        for filename in filenames:
            path = base / filename
            if is_link_like(path):
                fail("%s contains a filesystem link: %s" % (label, relative_posix(path, root)))
            if not path.is_file():
                fail("%s contains a non-regular file: %s" % (label, relative_posix(path, root)))
            files[relative_posix(path, root)] = path
    return files, dirs


def read_json(path: Path, label: str) -> Tuple[Dict[str, Any], bytes]:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        fail("%s could not be read: %s" % (label, exc))
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        fail("%s is not UTF-8 (a UTF-8 BOM is supported)" % label)
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        fail("%s is not valid JSON: %s" % (label, exc))
    if not isinstance(data, dict):
        fail("%s must contain a JSON object" % label)
    return data, raw


def write_json(path: Path, data: Dict[str, Any]) -> None:
    try:
        text = json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    except (TypeError, ValueError) as exc:
        fail("could not serialize %s: %s" % (path.name, exc))
    try:
        with open(path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
    except OSError as exc:
        fail("could not write %s: %s" % (path.name, exc))


def require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        fail("%s must be a non-empty string" % label)
    return value


def require_object(value: Any, label: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        fail("%s must be a JSON object" % label)
    return value


def require_list(value: Any, label: str) -> List[Any]:
    if not isinstance(value, list):
        fail("%s must be a JSON array" % label)
    return value


def require_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        fail("%s must be a finite number" % label)
    number = float(value)
    if not math.isfinite(number):
        fail("%s must be a finite number" % label)
    return number


def safe_reference(value: Any, label: str) -> str:
    """Normalize a model reference and reject paths that can leave the root."""
    if not isinstance(value, str) or not value.strip():
        fail("%s must be a non-empty relative path" % label)
    text = value.replace("\\", "/")
    if text.startswith("/") or text.startswith("//") or WINDOWS_DRIVE.match(text):
        fail("%s must stay inside the model directory" % label)
    parts: List[str] = []
    for part in text.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            fail("%s must not contain '..'" % label)
        parts.append(part)
    if not parts:
        fail("%s must name a file" % label)
    return "/".join(parts)


def require_source_file(files: Dict[str, Path], rel: str, label: str) -> Path:
    path = files.get(rel)
    if path is None:
        fail("%s references a missing file: %s" % (label, rel))
    return path


def validate_asset_file(path: Path, kind: str, label: str) -> None:
    """Reject empty or obviously mistyped required binary assets."""
    try:
        size = path.stat().st_size
        with open(path, "rb") as handle:
            head = handle.read(MIN_ASSET_BYTES)
    except OSError as exc:
        fail("%s could not be read: %s" % (label, exc))
    if size < MIN_ASSET_BYTES:
        fail("%s is empty or truncated" % label)
    if kind == "moc3" and head[:4] != MOC3_SIGNATURE:
        fail("%s does not start with the MOC3 signature" % label)
    if kind == "texture" and head != PNG_SIGNATURE:
        fail("%s does not start with the PNG signature" % label)


def require_uuid4(value: Any, label: str) -> str:
    if not isinstance(value, str) or UUID4_HEX.fullmatch(value) is None:
        fail("%s must be a lowercase 32-character UUID4 hex string" % label)
    parsed = uuid.UUID(hex=value)
    if parsed.version != 4 or parsed.variant != uuid.RFC_4122:
        fail("%s must be a UUID4 hex string" % label)
    return value


def find_root_profile_name(root: Path) -> str:
    try:
        entries = list(os.scandir(root))
    except OSError as exc:
        fail("could not list model directory: %s" % exc)
    candidates = [entry for entry in entries if entry.name.lower().endswith(".vtube.json")]
    if len(candidates) != 1:
        fail("expected exactly one root *.vtube.json, found %d" % len(candidates))
    entry = candidates[0]
    if not entry.is_file(follow_symlinks=False):
        fail("the root *.vtube.json must be a regular file")
    if is_link_like(root / entry.name):
        fail("the root *.vtube.json must not be a filesystem link")
    return entry.name


def check_reserved_root_name(root: Path) -> None:
    try:
        entries = list(os.scandir(root))
    except OSError as exc:
        fail("could not list model directory: %s" % exc)
    for entry in entries:
        if entry.name.casefold() == MANIFEST_NAME.casefold():
            fail("source already contains the reserved file name %s" % MANIFEST_NAME)


def is_mouth_curve(curve: Dict[str, Any]) -> bool:
    target = curve.get("Target")
    ident = curve.get("Id")
    if target == "Parameter" and ident in MOUTH_CURVE_IDS:
        return True
    return target == "Model" and ident == "LipSync"


def measure_curves(curves: List[Any], label: str) -> Dict[str, int]:
    """Validate packed Cubism curves and return their declared counters."""
    total_points = 0
    total_segments = 0

    for index, raw_curve in enumerate(curves):
        curve_label = "%s curve %d" % (label, index + 1)
        curve = require_object(raw_curve, curve_label)
        require_text(curve.get("Target"), curve_label + " Target")
        require_text(curve.get("Id"), curve_label + " Id")
        segments = require_list(curve.get("Segments"), curve_label + " Segments")
        if len(segments) < 2:
            fail("%s must start with an x/y point" % curve_label)

        require_number(segments[0], curve_label + " initial x")
        require_number(segments[1], curve_label + " initial y")
        total_points += 1

        cursor = 2
        while cursor < len(segments):
            kind = segments[cursor]
            if type(kind) is not int:
                fail("%s has a non-integer segment type" % curve_label)
            if kind == 1:
                if cursor + 7 > len(segments):
                    fail("%s has a truncated bezier segment" % curve_label)
                for offset in range(cursor + 1, cursor + 7):
                    require_number(segments[offset], "%s bezier value" % curve_label)
                cursor += 7
                total_points += 3
            elif kind in (0, 2, 3):
                if cursor + 3 > len(segments):
                    fail("%s has a truncated segment" % curve_label)
                require_number(segments[cursor + 1], "%s segment x" % curve_label)
                require_number(segments[cursor + 2], "%s segment y" % curve_label)
                cursor += 3
                total_points += 1
            else:
                fail("%s has an unknown segment type %r" % (curve_label, kind))
            total_segments += 1

        if cursor != len(segments):
            fail("%s has trailing or incomplete segment data" % curve_label)

    return {
        "CurveCount": len(curves),
        "TotalSegmentCount": total_segments,
        "TotalPointCount": total_points,
    }


def validate_motion(data: Dict[str, Any], label: str) -> Dict[str, int]:
    curves = require_list(data.get("Curves"), label + " Curves")
    counts = measure_curves(curves, label)
    meta = require_object(data.get("Meta"), label + " Meta")
    for key in COUNT_KEYS:
        declared = meta.get(key)
        if type(declared) is not int:
            fail("%s Meta.%s must be an integer" % (label, key))
        if declared != counts[key]:
            fail(
                "%s Meta.%s declares %d but the packed curves contain %d"
                % (label, key, declared, counts[key])
            )
    return counts


def load_motions(files: Dict[str, Path]) -> List[MotionInfo]:
    motions: List[MotionInfo] = []
    for rel in sorted(files, key=lambda value: value.casefold()):
        if not rel.casefold().endswith(".motion3.json"):
            continue
        data, _ = read_json(files[rel], "source motion %s" % rel)
        validate_motion(data, "source motion %s" % rel)
        motions.append(MotionInfo(rel=rel, data=data))
    return motions


def load_hotkeys(profile: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw_hotkeys = require_list(profile.get("Hotkeys"), "source Hotkeys")
    hotkeys: List[Dict[str, Any]] = []
    for index, raw_hotkey in enumerate(raw_hotkeys):
        hotkey = require_object(raw_hotkey, "source hotkey %d" % (index + 1))
        require_text(hotkey.get("HotkeyID"), "source hotkey %d HotkeyID" % (index + 1))
        action = hotkey.get("Action")
        if action is not None and not isinstance(action, str):
            fail("source hotkey %d Action must be a string" % (index + 1))
        file_value = hotkey.get("File")
        if file_value is not None and not isinstance(file_value, str):
            fail("source hotkey %d File must be a string" % (index + 1))
        if file_value:
            safe_reference(file_value, "source hotkey %d File" % (index + 1))
        if action == "TriggerAnimation" and not file_value:
            fail("source TriggerAnimation hotkey %d has no File" % (index + 1))
        hotkeys.append(hotkey)
    return hotkeys


def resolve_semantic_hotkeys(
    hotkeys: List[Dict[str, Any]], label: str
) -> Dict[str, int]:
    """Find exactly one TriggerAnimation hotkey for each required motion."""
    required = {basename.casefold(): key for key, basename in ANIMATION_TARGETS}
    matches: Dict[str, List[int]] = {key: [] for key, _ in ANIMATION_TARGETS}

    for index, hotkey in enumerate(hotkeys):
        if hotkey.get("Action") != "TriggerAnimation":
            continue
        file_value = hotkey.get("File")
        file_ref = safe_reference(file_value, "%s hotkey %d File" % (label, index + 1))
        basename = PurePosixPath(file_ref).name.casefold()
        key = required.get(basename)
        if key is not None:
            matches[key].append(index)

    result: Dict[str, int] = {}
    for key, _ in ANIMATION_TARGETS:
        found = matches[key]
        if len(found) != 1:
            fail(
                "%s must contain exactly one TriggerAnimation hotkey for %s, found %d"
                % (label, dict(ANIMATION_TARGETS)[key], len(found))
            )
        result[key] = found[0]
    return result


def load_parameter_mappings(profile: Dict[str, Any]) -> Tuple[Dict[str, int], Dict[str, Tuple[float, float]]]:
    rows = require_list(profile.get("ParameterSettings"), "source ParameterSettings")
    for index, raw_row in enumerate(rows):
        require_object(raw_row, "source ParameterSettings row %d" % (index + 1))

    indices: Dict[str, int] = {}
    output_ranges: Dict[str, Tuple[float, float]] = {}
    for param in MOUTH_PARAMETERS:
        matches = [
            index
            for index, row in enumerate(rows)
            if row.get("OutputLive2D") == param
        ]
        if len(matches) != 1:
            fail(
                "source ParameterSettings must contain exactly one %s row, found %d"
                % (param, len(matches))
            )
        index = matches[0]
        row = rows[index]
        lower = require_number(row.get("OutputRangeLower"), "source %s OutputRangeLower" % param)
        upper = require_number(row.get("OutputRangeUpper"), "source %s OutputRangeUpper" % param)
        if lower > upper:
            fail("source %s output range is reversed" % param)
        indices[param] = index
        output_ranges[param] = (lower, upper)

    selected = set(indices.values())
    reserved_inputs = set(INPUTS.values())
    for index, row in enumerate(rows):
        if index in selected:
            continue
        if row.get("Input") in reserved_inputs:
            fail("source ParameterSettings row %d already uses a reserved Isla input" % (index + 1))

    return indices, output_ranges


def load_source(source: Path) -> SourceInfo:
    files, dirs = scan_tree(source, "source")
    check_reserved_root_name(source)
    profile_rel = find_root_profile_name(source)
    profile, _ = read_json(from_relative(source, profile_rel), "source profile %s" % profile_rel)
    source_model_id = require_text(profile.get("ModelID"), "source ModelID")

    references = require_object(profile.get("FileReferences"), "source FileReferences")
    model3_rel = safe_reference(references.get("Model"), "source FileReferences.Model")
    if not model3_rel.casefold().endswith(".model3.json"):
        fail("source FileReferences.Model must name a .model3.json file")
    require_source_file(files, model3_rel, "source FileReferences.Model")

    model3, _ = read_json(from_relative(source, model3_rel), "source model3 %s" % model3_rel)
    model3_refs = require_object(model3.get("FileReferences"), "source model3 FileReferences")
    moc_rel = safe_reference(model3_refs.get("Moc"), "source model3 FileReferences.Moc")
    if not moc_rel.casefold().endswith(".moc3"):
        fail("source model3 FileReferences.Moc must name a .moc3 file")
    moc_path = require_source_file(files, moc_rel, "source model3 FileReferences.Moc")
    validate_asset_file(moc_path, "moc3", "source moc3 %s" % moc_rel)

    textures = require_list(model3_refs.get("Textures"), "source model3 FileReferences.Textures")
    if not textures:
        fail("source model3 FileReferences.Textures must not be empty")
    texture_rels: List[str] = []
    for index, texture in enumerate(textures):
        texture_rel = safe_reference(
            texture, "source model3 FileReferences.Textures[%d]" % index
        )
        texture_path = require_source_file(
            files, texture_rel, "source model3 FileReferences.Textures[%d]" % index
        )
        validate_asset_file(
            texture_path, "texture", "source texture %s" % texture_rel
        )
        texture_rels.append(texture_rel)

    hotkeys = load_hotkeys(profile)
    motions = load_motions(files)

    motions_by_basename: Dict[str, List[str]] = {}
    for motion in motions:
        basename = PurePosixPath(motion.rel).name.casefold()
        motions_by_basename.setdefault(basename, []).append(motion.rel)
    for _, basename in ANIMATION_TARGETS:
        found = motions_by_basename.get(basename.casefold(), [])
        if len(found) != 1:
            fail(
                "expected exactly one motion file named %s, found %d"
                % (basename, len(found))
            )

    semantic_hotkeys = resolve_semantic_hotkeys(hotkeys, "source profile")
    mouth_row_indices, mouth_output_ranges = load_parameter_mappings(profile)

    return SourceInfo(
        profile_rel=profile_rel,
        profile=profile,
        files=files,
        dirs=dirs,
        motions=motions,
        hotkeys=hotkeys,
        semantic_hotkeys=semantic_hotkeys,
        source_model_id=source_model_id,
        mouth_row_indices=mouth_row_indices,
        mouth_output_ranges=mouth_output_ranges,
        model3_rel=model3_rel,
        moc_rel=moc_rel,
        texture_rels=texture_rels,
    )


def plan_motions(source: SourceInfo) -> None:
    for motion in source.motions:
        curves = motion.data["Curves"]
        kept = [curve for curve in curves if not is_mouth_curve(curve)]
        if len(kept) == len(curves):
            motion.expected = None
            continue
        counts = measure_curves(kept, "source motion %s kept curves" % motion.rel)
        expected = copy.deepcopy(motion.data)
        expected["Curves"] = copy.deepcopy(kept)
        expected["Meta"].update(counts)
        motion.expected = expected


def generate_ids(source: SourceInfo) -> Tuple[str, List[str]]:
    source_ids = {source.source_model_id}
    source_ids.update(hotkey["HotkeyID"] for hotkey in source.hotkeys)
    used: Set[str] = set()

    def next_id() -> str:
        while True:
            candidate = uuid.uuid4().hex
            if candidate not in used and candidate not in source_ids:
                used.add(candidate)
                return candidate

    model_id = next_id()
    hotkey_ids = [next_id() for _ in source.hotkeys]
    return model_id, hotkey_ids


def transform_profile(source: SourceInfo, model_id: str, hotkey_ids: Sequence[str]) -> Dict[str, Any]:
    if len(hotkey_ids) != len(source.hotkeys):
        fail("internal hotkey identity count mismatch")
    result = copy.deepcopy(source.profile)
    result["Name"] = SPEAKING_NAME
    result["ModelID"] = model_id
    hotkeys = result["Hotkeys"]
    for hotkey, hotkey_id in zip(hotkeys, hotkey_ids):
        hotkey["HotkeyID"] = hotkey_id
    rows = result["ParameterSettings"]
    for param, index in source.mouth_row_indices.items():
        row = rows[index]
        input_key, lower, upper = MOUTH_PARAMETERS[param]
        row["Input"] = INPUTS[input_key]
        row["InputRangeLower"] = lower
        row["InputRangeUpper"] = upper
        row["Smoothing"] = 0
    return result


def build_manifest(source: SourceInfo, model_id: str, hotkey_ids: Sequence[str]) -> Dict[str, Any]:
    hotkey_map = {
        key: hotkey_ids[source.semantic_hotkeys[key]] for key, _ in ANIMATION_TARGETS
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generator": GENERATOR,
        "modelId": model_id,
        "name": SPEAKING_NAME,
        "input": INPUT_OPEN,
        "inputs": dict(INPUTS),
        "hotkeyMap": hotkey_map,
        "profile": source.profile_rel,
        "sourceModelId": source.source_model_id,
    }


def normalize_manifest(raw: Dict[str, Any], source: SourceInfo) -> Dict[str, Any]:
    required_keys = {
        "schemaVersion",
        "generator",
        "modelId",
        "name",
        "input",
        "inputs",
        "hotkeyMap",
        "profile",
        "sourceModelId",
    }
    if set(raw) != required_keys:
        fail("manifest must contain exactly the documented public keys")
    if type(raw.get("schemaVersion")) is not int or raw["schemaVersion"] != SCHEMA_VERSION:
        fail("manifest schemaVersion must be %d" % SCHEMA_VERSION)
    if raw.get("generator") != GENERATOR:
        fail("manifest generator must be %s" % GENERATOR)
    model_id = require_uuid4(raw.get("modelId"), "manifest modelId")
    if raw.get("name") != SPEAKING_NAME:
        fail("manifest name must be %s" % SPEAKING_NAME)
    if raw.get("input") != INPUT_OPEN:
        fail("manifest input must be %s" % INPUT_OPEN)
    if raw.get("inputs") != INPUTS:
        fail("manifest inputs must contain exactly open, form and x")
    source_model_id = require_text(raw.get("sourceModelId"), "manifest sourceModelId")
    if source_model_id != source.source_model_id:
        fail("destination was prepared from a different source model")

    hotkeys = raw.get("hotkeyMap")
    if not isinstance(hotkeys, dict):
        fail("manifest hotkeyMap must be an object")
    expected_keys = {key for key, _ in ANIMATION_TARGETS}
    if set(hotkeys) != expected_keys:
        fail("manifest hotkeyMap must contain exactly animation-1, animation-2 and animation-3")
    mapped_ids = [require_uuid4(hotkeys[key], "manifest hotkeyMap.%s" % key) for key, _ in ANIMATION_TARGETS]

    profile_rel = raw.get("profile")
    if (
        not isinstance(profile_rel, str)
        or not profile_rel
        or "/" in profile_rel
        or "\\" in profile_rel
        or profile_rel in (".", "..")
    ):
        fail("manifest profile must be a relative VTS settings filename")
    if profile_rel != source.profile_rel:
        fail("manifest profile does not match the source profile filename")

    source_ids = {source.source_model_id}
    source_ids.update(hotkey["HotkeyID"] for hotkey in source.hotkeys)
    all_ids = [model_id] + mapped_ids
    if len(set(all_ids)) != len(all_ids):
        fail("manifest identities must be distinct")
    for value in all_ids:
        if value in source_ids:
            fail("manifest identities must not reuse a source identity")

    return {
        "schemaVersion": SCHEMA_VERSION,
        "generator": GENERATOR,
        "modelId": model_id,
        "name": SPEAKING_NAME,
        "input": INPUT_OPEN,
        "inputs": dict(INPUTS),
        "hotkeyMap": {key: hotkeys[key] for key, _ in ANIMATION_TARGETS},
        "profile": profile_rel,
        "sourceModelId": source_model_id,
    }


def load_manifest(dest: Path, source: SourceInfo) -> Dict[str, Any]:
    if is_link_like(dest):
        fail("destination must not be a filesystem link")
    if not dest.is_dir():
        fail("destination exists but is not a directory")
    manifest_path = dest / MANIFEST_NAME
    if is_link_like(manifest_path):
        fail("destination manifest must not be a filesystem link")
    if not manifest_path.is_file():
        fail("destination is not a prepared speaking model (missing %s)" % MANIFEST_NAME)
    raw, _ = read_json(manifest_path, "destination manifest")
    return normalize_manifest(raw, source)


def files_equal(left: Path, right: Path) -> bool:
    try:
        if left.stat().st_size != right.stat().st_size:
            return False
        with open(left, "rb") as left_handle, open(right, "rb") as right_handle:
            while True:
                left_chunk = left_handle.read(1024 * 1024)
                right_chunk = right_handle.read(1024 * 1024)
                if left_chunk != right_chunk:
                    return False
                if not left_chunk:
                    return True
    except OSError as exc:
        fail("could not compare copied files: %s" % exc)


def validate_destination_parameters(
    profile: Dict[str, Any], source: SourceInfo, label: str
) -> None:
    rows = require_list(profile.get("ParameterSettings"), label + " ParameterSettings")
    for index, raw_row in enumerate(rows):
        require_object(raw_row, "%s ParameterSettings row %d" % (label, index + 1))

    selected: Dict[str, Dict[str, Any]] = {}
    for param, (input_key, lower, upper) in MOUTH_PARAMETERS.items():
        matches = [row for row in rows if row.get("OutputLive2D") == param]
        if len(matches) != 1:
            fail(
                "%s ParameterSettings must contain exactly one %s row, found %d"
                % (label, param, len(matches))
            )
        row = matches[0]
        if row.get("Input") != INPUTS[input_key]:
            fail("%s %s Input must be %s" % (label, param, INPUTS[input_key]))
        actual_lower = require_number(row.get("InputRangeLower"), "%s %s InputRangeLower" % (label, param))
        actual_upper = require_number(row.get("InputRangeUpper"), "%s %s InputRangeUpper" % (label, param))
        if actual_lower != lower or actual_upper != upper:
            fail("%s %s input range must be %s..%s" % (label, param, lower, upper))
        if row.get("Smoothing") != 0:
            fail("%s %s Smoothing must be 0" % (label, param))
        out_lower = require_number(row.get("OutputRangeLower"), "%s %s OutputRangeLower" % (label, param))
        out_upper = require_number(row.get("OutputRangeUpper"), "%s %s OutputRangeUpper" % (label, param))
        source_range = source.mouth_output_ranges[param]
        if (out_lower, out_upper) != source_range:
            fail("%s %s output range does not match the source" % (label, param))
        selected[param] = row

    selected_objects = {id(row) for row in selected.values()}
    reserved_inputs = set(INPUTS.values())
    for index, row in enumerate(rows):
        if id(row) not in selected_objects and row.get("Input") in reserved_inputs:
            fail("%s ParameterSettings row %d uses a reserved Isla input" % (label, index + 1))


def validate_hotkey_identities(
    profile: Dict[str, Any], manifest: Dict[str, Any], source: SourceInfo, label: str
) -> None:
    hotkeys = require_list(profile.get("Hotkeys"), label + " Hotkeys")
    for index, raw_hotkey in enumerate(hotkeys):
        hotkey = require_object(raw_hotkey, "%s hotkey %d" % (label, index + 1))
        require_uuid4(hotkey.get("HotkeyID"), "%s hotkey %d HotkeyID" % (label, index + 1))
        action = hotkey.get("Action")
        if action is not None and not isinstance(action, str):
            fail("%s hotkey %d Action must be a string" % (label, index + 1))
        file_value = hotkey.get("File")
        if file_value is not None and not isinstance(file_value, str):
            fail("%s hotkey %d File must be a string" % (label, index + 1))
        if file_value:
            safe_reference(file_value, "%s hotkey %d File" % (label, index + 1))
        if action == "TriggerAnimation" and not file_value:
            fail("%s TriggerAnimation hotkey %d has no File" % (label, index + 1))

    source_ids = {source.source_model_id}
    source_ids.update(hotkey["HotkeyID"] for hotkey in source.hotkeys)
    used = {manifest["modelId"]}
    for index, hotkey in enumerate(hotkeys):
        hotkey_id = hotkey["HotkeyID"]
        if hotkey_id in used:
            fail("%s hotkey %d reuses another generated identity" % (label, index + 1))
        if hotkey_id in source_ids:
            fail("%s hotkey %d reuses a source identity" % (label, index + 1))
        used.add(hotkey_id)

    semantic = resolve_semantic_hotkeys(hotkeys, label)
    for key, _ in ANIMATION_TARGETS:
        hotkey_id = hotkeys[semantic[key]]["HotkeyID"]
        if hotkey_id != manifest["hotkeyMap"][key]:
            fail("%s semantic hotkey %s does not match the manifest" % (label, key))


def validate_destination_motion_files(
    files: Dict[str, Path], source: SourceInfo, label: str
) -> None:
    for motion in source.motions:
        dest_path = files.get(motion.rel)
        if dest_path is None:
            fail("%s is missing copied motion %s" % (label, motion.rel))
        if motion.changed:
            data, _ = read_json(dest_path, "%s motion %s" % (label, motion.rel))
            if data != motion.expected:
                fail("%s motion %s does not match the prepared curve set" % (label, motion.rel))
        else:
            source_path = source.files[motion.rel]
            if not files_equal(source_path, dest_path):
                fail("%s motion %s changed although it had no mouth curves" % (label, motion.rel))


def validate_extra_motion_files(files: Dict[str, Path], source: SourceInfo, label: str) -> None:
    source_motions = {motion.rel for motion in source.motions}
    for rel in sorted(files, key=lambda value: value.casefold()):
        if rel in source_motions or not rel.casefold().endswith(".motion3.json"):
            continue
        data, _ = read_json(files[rel], "%s extra motion %s" % (label, rel))
        validate_motion(data, "%s extra motion %s" % (label, rel))
        if any(is_mouth_curve(curve) for curve in data["Curves"]):
            fail("%s extra motion %s still contains mouth curves" % (label, rel))


def validate_required_assets(files: Dict[str, Path], source: SourceInfo, label: str) -> None:
    """Check the model files the prepared profile actually deploys."""
    for rel, kind in source.required_assets.items():
        dest_path = files.get(rel)
        if dest_path is None:
            fail("%s is missing required asset %s" % (label, rel))
        if kind in ("moc3", "texture"):
            validate_asset_file(dest_path, kind, "%s required asset %s" % (label, rel))
        source_path = source.files.get(rel)
        if source_path is None:
            fail("source is missing required asset %s" % rel)
        if not files_equal(source_path, dest_path):
            fail("%s required asset %s does not match the source bytes" % (label, rel))
    validate_destination_motion_files(files, source, label)
    validate_extra_motion_files(files, source, label)


def validate_existing_destination(
    dest: Path, source: SourceInfo, manifest: Dict[str, Any]
) -> None:
    """Validate ownership without rejecting host-managed settings or sidecars."""
    if is_link_like(dest):
        fail("destination must not be a filesystem link")
    if not dest.is_dir():
        fail("destination must be a directory")
    files, _ = scan_tree(dest, "destination")
    profile_rel = find_root_profile_name(dest)
    if profile_rel != manifest["profile"]:
        fail("destination root profile does not match the manifest")
    profile, _ = read_json(from_relative(dest, profile_rel), "destination profile")

    if profile.get("Name") != SPEAKING_NAME:
        fail("destination profile Name must be %s" % SPEAKING_NAME)
    if profile.get("ModelID") != manifest["modelId"]:
        fail("destination profile ModelID does not match the manifest")

    dest_refs = require_object(profile.get("FileReferences"), "destination FileReferences")
    dest_model = safe_reference(dest_refs.get("Model"), "destination FileReferences.Model")
    source_refs = require_object(source.profile.get("FileReferences"), "source FileReferences")
    source_model = safe_reference(source_refs.get("Model"), "source FileReferences.Model")
    if dest_model != source_model:
        fail("destination profile uses a different deployed model3 file")

    validate_hotkey_identities(profile, manifest, source, "destination profile")
    validate_destination_parameters(profile, source, "destination profile")
    validate_required_assets(files, source, "destination")


def validate_staged_copy(
    stage: Path,
    source: SourceInfo,
    manifest: Dict[str, Any],
    expected_profile: Dict[str, Any],
) -> None:
    """Strict first-creation check: only the intended files may differ."""
    if is_link_like(stage):
        fail("staging path must not be a filesystem link")
    files, staged_dirs = scan_tree(stage, "staging")
    for rel in source.dirs:
        if rel not in staged_dirs:
            fail("staging is missing copied directory %s" % rel)
    profile_rel = find_root_profile_name(stage)
    if profile_rel != manifest["profile"]:
        fail("staged root profile does not match the manifest")
    profile, _ = read_json(from_relative(stage, profile_rel), "staged profile")
    if profile != expected_profile:
        fail("staged profile does not match the expected prepared profile")

    changed_motions = {motion.rel for motion in source.motions if motion.changed}
    for rel, source_path in source.files.items():
        if rel == source.profile_rel or rel in changed_motions:
            continue
        staged_path = files.get(rel)
        if staged_path is None:
            fail("staging is missing copied file %s" % rel)
        if not files_equal(source_path, staged_path):
            fail("staged file %s does not match the source bytes" % rel)
    validate_destination_motion_files(files, source, "staging")
    validate_extra_motion_files(files, source, "staging")


def copy_source_tree(source: SourceInfo, stage: Path) -> None:
    for rel in source.dirs:
        try:
            from_relative(stage, rel).mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            fail("could not create staging directory %s: %s" % (rel, exc))
    for rel, source_path in source.files.items():
        dest_path = from_relative(stage, rel)
        try:
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source_path, dest_path)
        except OSError as exc:
            fail("could not copy %s: %s" % (rel, exc))


def publish_staging(stage: Path, dest: Path) -> None:
    """Publish with an exclusive destination reservation, never overwriting."""
    try:
        os.mkdir(dest)
    except FileExistsError:
        fail("destination appeared while preparing; it was left untouched")
    except OSError as exc:
        fail("could not create destination exclusively: %s" % exc)

    moved: List[str] = []
    try:
        for name in sorted(os.listdir(stage)):
            target = dest / name
            if os.path.lexists(target):
                fail("destination contains an unexpected concurrent entry: %s" % name)
            os.rename(stage / name, target)
            moved.append(name)
    except BaseException:
        for name in reversed(moved):
            try:
                os.rename(dest / name, stage / name)
            except OSError:
                pass
        try:
            os.rmdir(dest)
        except OSError:
            pass
        raise

    try:
        os.rmdir(stage)
    except OSError:
        shutil.rmtree(stage, ignore_errors=True)


def resolve_source(value: str) -> Path:
    raw = Path(value)
    if not os.path.lexists(raw):
        fail("source does not exist: %s" % value)
    absolute = Path(os.path.abspath(os.fspath(raw)))
    if is_link_like(absolute):
        fail("source must not be a filesystem link")
    real = Path(os.path.realpath(os.fspath(absolute)))
    if is_link_like(real):
        fail("source must not resolve to a filesystem link")
    if not real.is_dir():
        fail("source must be an existing directory")
    return real


def resolve_destination(value: str) -> Path:
    raw = Path(value)
    absolute = Path(os.path.abspath(os.fspath(raw)))
    if os.path.lexists(absolute) and is_link_like(absolute):
        fail("destination must not be a filesystem link")
    real = Path(os.path.realpath(os.fspath(absolute)))
    if real.name in ("", ".", ".."):
        fail("destination must name a directory")
    return real


def validate_path_relationship(source: Path, dest: Path) -> None:
    if path_identity(source.parent) != path_identity(dest.parent):
        fail("destination must be an independent sibling of the source directory")
    if path_identity(source) == path_identity(dest):
        fail("destination must be different from the source directory")

    source_text = path_identity(source)
    dest_text = path_identity(dest)
    try:
        common = os.path.commonpath([source_text, dest_text])
    except ValueError:
        fail("source and destination must be on the same filesystem path")
    common = os.path.normcase(common)
    if common in (source_text, dest_text):
        fail("source and destination must not be nested")


def prepare(source_value: str, dest_value: str) -> Dict[str, Any]:
    source_path = resolve_source(source_value)
    dest_path = resolve_destination(dest_value)
    validate_path_relationship(source_path, dest_path)

    source = load_source(source_path)
    plan_motions(source)
    if os.path.lexists(dest_path):
        manifest = load_manifest(dest_path, source)
        validate_existing_destination(dest_path, source, manifest)
        return manifest

    model_id, hotkey_ids = generate_ids(source)
    manifest = build_manifest(source, model_id, hotkey_ids)
    expected_profile = transform_profile(source, model_id, hotkey_ids)

    stage: Optional[Path] = None
    try:
        try:
            stage = Path(
                tempfile.mkdtemp(prefix=".isla-speaking-staging-", dir=os.fspath(dest_path.parent))
            )
        except OSError as exc:
            fail("could not create a sibling staging directory: %s" % exc)

        copy_source_tree(source, stage)
        write_json(from_relative(stage, source.profile_rel), expected_profile)
        for motion in source.motions:
            if motion.expected is not None:
                write_json(from_relative(stage, motion.rel), motion.expected)
        write_json(stage / MANIFEST_NAME, manifest)

        staged_manifest, _ = read_json(stage / MANIFEST_NAME, "staged manifest")
        if normalize_manifest(staged_manifest, source) != manifest:
            fail("staged manifest did not validate")
        validate_staged_copy(stage, source, manifest, expected_profile)

        publish_staging(stage, dest_path)
        stage = None
    finally:
        if stage is not None:
            try:
                shutil.rmtree(stage, ignore_errors=True)
            except OSError:
                pass

    return manifest


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Prepare an independent VTube Studio copy of a stock Hiyori model "
            "with dedicated Isla speaking-mouth inputs."
        )
    )
    parser.add_argument(
        "--source",
        required=True,
        help="existing stock Hiyori VTube Studio model directory",
    )
    parser.add_argument(
        "--dest",
        required=True,
        help="new or previously prepared sibling directory",
    )
    args = parser.parse_args(argv)

    try:
        manifest = prepare(args.source, args.dest)
    except ToolError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1
    except OSError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1

    print(json.dumps(manifest, ensure_ascii=True, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
