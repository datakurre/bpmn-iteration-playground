"""Safe XML parsing utilities preventing XXE (XML External Entity) attacks.

Delegates to defusedxml rather than hand-rolling entity-handler hardening on top of
xml.etree.ElementTree.XMLParser: that approach silently did nothing, since the
C-accelerated XMLParser CPython normally returns has no `.parser` attribute to hook
(only the pure-Python fallback class does), so the entity handlers were never installed.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any, Union
import xml.etree.ElementTree as ET

import defusedxml.ElementTree as DefusedET


def safe_parse_xml(source: Union[str, Path, io.BytesIO, io.StringIO]) -> ET.ElementTree[Any]:
    """Parse XML safely with DTDs, entity expansion, and external references forbidden."""
    return DefusedET.parse(source)  # type: ignore[no-any-return]


def safe_fromstring_xml(text: str | bytes) -> ET.Element[Any]:
    """Parse XML string safely with DTDs, entity expansion, and external references forbidden."""
    return DefusedET.fromstring(text)  # type: ignore[no-any-return]
