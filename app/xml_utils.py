"""Safe XML parsing utilities preventing XXE (XML External Entity) attacks."""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any, Union
import xml.etree.ElementTree as ET


def safe_xml_parser() -> ET.XMLParser:
    """Create an ElementTree XMLParser with entity declarations and external entity resolution disabled."""
    parser = ET.XMLParser()
    if hasattr(parser, "parser"):
        def entity_decl(
            name: str,
            is_parameter_entity: bool,
            value: str | None,
            base: str | None,
            system_id: str | None,
            public_id: str | None,
            notation_name: str | None,
        ) -> None:
            raise ValueError(f"Disallowed XML entity declaration: {name}")

        parser.parser.EntityDeclHandler = entity_decl
        parser.parser.ExternalEntityRefHandler = lambda *args: 0
    return parser


def safe_parse_xml(source: Union[str, Path, io.BytesIO, io.StringIO]) -> ET.ElementTree[Any]:
    """Parse XML safely with external entity resolution disabled."""
    return ET.parse(source, parser=safe_xml_parser())


def safe_fromstring_xml(text: str | bytes) -> ET.Element[Any]:
    """Parse XML string safely with external entity resolution disabled."""
    return ET.fromstring(text, parser=safe_xml_parser())
