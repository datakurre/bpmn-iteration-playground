import io

import pytest
from defusedxml.common import EntitiesForbidden

from graph_agent.xml_utils import safe_fromstring_xml, safe_parse_xml


def test_safe_xml_parsing_normal() -> None:
    xml_data = b"""<?xml version="1.0" encoding="UTF-8"?>
    <root>
        <child name="test">Hello World</child>
    </root>"""
    tree = safe_parse_xml(io.BytesIO(xml_data))
    root = tree.getroot()
    assert root.tag == "root"
    child = root.find("child")
    assert child is not None
    assert child.text == "Hello World"


def test_safe_xml_blocks_xxe_external_entity() -> None:
    xxe_xml = b"""<?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE root [
        <!ENTITY xxe SYSTEM "file:///etc/passwd">
    ]>
    <root>
        <data>&xxe;</data>
    </root>"""
    with pytest.raises(EntitiesForbidden):
        safe_parse_xml(io.BytesIO(xxe_xml))


def test_safe_fromstring_blocks_xxe() -> None:
    xxe_xml = """<?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE root [
        <!ENTITY xxe SYSTEM "file:///etc/hosts">
    ]>
    <root>&xxe;</root>"""
    with pytest.raises(EntitiesForbidden):
        safe_fromstring_xml(xxe_xml)


def test_safe_xml_blocks_internal_entity_declaration() -> None:
    # Not an external-entity read: a plain internal entity declaration, the kind
    # entity-expansion ("billion laughs") attacks rely on. The old hand-rolled
    # EntityDeclHandler was meant to catch this but was never actually installed
    # (ET.XMLParser()'s C-accelerated implementation has no .parser attribute to
    # hook); defusedxml rejects it outright regardless of internal/external.
    bomb_xml = b"""<?xml version="1.0"?>
    <!DOCTYPE root [
        <!ENTITY foo "bar">
    ]>
    <root>&foo;</root>"""
    with pytest.raises(EntitiesForbidden):
        safe_parse_xml(io.BytesIO(bomb_xml))
