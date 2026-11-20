"""Per-corpus build configuration — loads builder/build/corpora/*.json.

A corpus config captures everything domain-specific about a corpus build:
USLM title / target chapters / citation prefix / act-name map, eCFR
title / chapter / parts / common names / authority map, and the `meta`
object that build_corpus.py emits into corpus.json (see
docs/contracts.md § 8 and docs/corpus-adapter.md).
"""
from __future__ import annotations
import json
from functools import lru_cache
from pathlib import Path
from typing import Any

CORPORA_DIR = Path(__file__).resolve().parent / "corpora"
DEFAULT_CONFIG_PATH = CORPORA_DIR / "securities.json"

_REQUIRED_KEYS = {
    "uslm": ("title", "xml_path", "target_chapters", "cite_prefix", "act_names"),
    "ecfr": ("title", "chapter", "parts", "cite_prefix", "common_names", "authority_map"),
    "meta": ("id", "label", "defaultTitle", "uscCitePrefix", "cfrCitePrefix", "modes"),
}


def validate_config(cfg: dict[str, Any]) -> None:
    """Raise ValueError naming the first missing/invalid piece of a config."""
    if not isinstance(cfg.get("id"), str) or not cfg["id"]:
        raise ValueError("corpus config: missing or empty top-level 'id'")
    for group, keys in _REQUIRED_KEYS.items():
        section = cfg.get(group)
        if not isinstance(section, dict):
            raise ValueError(f"corpus config: missing '{group}' object")
        missing = [k for k in keys if k not in section]
        if missing:
            raise ValueError(f"corpus config: '{group}' missing keys: {missing}")
    meta = cfg["meta"]
    if meta["id"] != cfg["id"]:
        raise ValueError("corpus config: meta.id must equal top-level id")
    modes = meta["modes"]
    if not isinstance(modes, dict) or not {"codified", "original"} <= set(modes):
        raise ValueError("corpus config: meta.modes needs 'codified' and 'original' labels")


def load_config(path: str | Path | None = None) -> dict[str, Any]:
    """Load and validate a corpus config (default: the securities corpus)."""
    cfg = json.loads(Path(path or DEFAULT_CONFIG_PATH).read_text(encoding="utf-8"))
    validate_config(cfg)
    return cfg


@lru_cache(maxsize=1)
def default_config() -> dict[str, Any]:
    """Cached securities default used when callers pass config=None.

    Treat the returned dict as read-only — copy before mutating.
    """
    return load_config(DEFAULT_CONFIG_PATH)
