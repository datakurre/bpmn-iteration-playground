import { describe, it, expect } from "vitest";
import camundaModdleDescriptor from "camunda-bpmn-moddle/resources/camunda.json";
import enhanced from "./camunda-with-icon-moddle";
import type { ModdleTypeDescriptor, ModdlePropertyDescriptor } from "./moddle-types";

const findType = (name: string) => camundaModdleDescriptor.types.find((t: ModdleTypeDescriptor) => t.name === name);
const findEnhancedType = (name: string) => enhanced.types.find((t: ModdleTypeDescriptor) => t.name === name);

describe("camundaWithIconModdle", () => {
  it("adds modelerTemplateIcon to TemplateSupported without mutating the source descriptor", () => {
    const original = findType("TemplateSupported");
    expect(original?.properties.some((p: ModdlePropertyDescriptor) => p.name === "modelerTemplateIcon")).toBe(false);

    const patched = findEnhancedType("TemplateSupported");
    const iconProp = patched?.properties.find((p: ModdlePropertyDescriptor) => p.name === "modelerTemplateIcon");
    expect(iconProp).toEqual({ name: "modelerTemplateIcon", isAttr: true, type: "String" });
  });

  it("preserves the original TemplateSupported properties", () => {
    const patched = findEnhancedType("TemplateSupported");
    const names = patched?.properties.map((p: ModdlePropertyDescriptor) => p.name);
    expect(names).toEqual(expect.arrayContaining(["modelerTemplate", "modelerTemplateVersion", "modelerTemplateIcon"]));
  });
});
