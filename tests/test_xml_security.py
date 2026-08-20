import io
import pytest
from app.xml_utils import safe_parse_xml, safe_fromstring_xml


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
    with pytest.raises(Exception):
        safe_parse_xml(io.BytesIO(xxe_xml))


def test_safe_fromstring_blocks_xxe() -> None:
    xxe_xml = """<?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE root [
        <!ENTITY xxe SYSTEM "file:///etc/hosts">
    ]>
    <root>&xxe;</root>"""
    with pytest.raises(Exception):
        safe_fromstring_xml(xxe_xml)
