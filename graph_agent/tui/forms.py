"""FormJS schema parser and validator for native TUI form rendering."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class FormFieldOption:
    label: str
    value: str


@dataclass
class FormField:
    key: str
    label: str
    type: str  # textfield, textarea, number, checkbox, select, radio, text (display)
    default_value: Any = None
    description: str = ""
    text_content: str = ""  # For display 'text' or 'markdown' components
    options: list[FormFieldOption] = field(default_factory=list)
    disabled: bool = False
    required: bool = False


SUPPORTED_NATIVE_TYPES = {
    "textfield",
    "string",
    "textarea",
    "number",
    "checkbox",
    "boolean",
    "select",
    "radio",
    "text",
    "markdown",
    "button",
}


@dataclass
class FormSchema:
    fields: list[FormField]
    is_native_supported: bool = True
    unsupported_types: list[str] = field(default_factory=list)
    raw_schema: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, schema_dict: dict[str, Any]) -> FormSchema:
        """Parse FormJS JSON schema or Camunda formData dict into FormSchema."""
        fields: list[FormField] = []
        unsupported: list[str] = []

        components = schema_dict.get("components")
        if components is None and "fields" in schema_dict:
            components = schema_dict["fields"]

        if not components and isinstance(schema_dict, list):
            components = schema_dict

        if not isinstance(components, list):
            return cls(fields=[], is_native_supported=True, raw_schema=schema_dict)

        for comp in components:
            if not isinstance(comp, dict):
                continue
            ctype = str(comp.get("type", "textfield")).lower()
            key = comp.get("key") or comp.get("id") or ""
            label = comp.get("label") or key or ""
            default_val = comp.get("defaultValue") or comp.get("default")
            text_content = comp.get("text") or comp.get("description") or ""

            if ctype not in SUPPORTED_NATIVE_TYPES:
                unsupported.append(ctype)

            options: list[FormFieldOption] = []
            values = comp.get("values")
            if isinstance(values, list):
                for val in values:
                    if isinstance(val, dict):
                        options.append(
                            FormFieldOption(
                                label=str(val.get("label", val.get("value", ""))),
                                value=str(val.get("value", "")),
                            )
                        )
                    else:
                        options.append(FormFieldOption(label=str(val), value=str(val)))

            fields.append(
                FormField(
                    key=key,
                    label=label,
                    type=ctype,
                    default_value=default_val,
                    description=comp.get("description", ""),
                    text_content=text_content,
                    options=options,
                    disabled=bool(comp.get("disabled", False)),
                    required=bool(comp.get("validate", {}).get("required", False)),
                )
            )

        return cls(
            fields=fields,
            is_native_supported=len(unsupported) == 0,
            unsupported_types=unsupported,
            raw_schema=schema_dict,
        )

    def extract_defaults(self) -> dict[str, Any]:
        """Extract default values dictionary for form submission."""
        data: dict[str, Any] = {}
        for f in self.fields:
            if not f.key or f.type in ("text", "markdown", "button"):
                continue
            if f.default_value is not None:
                data[f.key] = f.default_value
            elif f.type == "checkbox":
                data[f.key] = False
            elif f.type == "number":
                data[f.key] = 0
            else:
                data[f.key] = ""
        return data
