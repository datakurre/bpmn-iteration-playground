// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateZeebe, getZeebeSchemaPackage, getZeebeSchemaVersion } from "@bpmn-io/element-templates-validator";

const DIR = import.meta.dirname;
const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));

interface Template {
  $schema?: string;
  id: string;
  name: string;
  appliesTo: string[];
  properties: Array<{ binding: { type: string; property?: string } }>;
}

function templatesIn(file: string): Template[] {
  return JSON.parse(readFileSync(join(DIR, file), "utf8")) as Template[];
}

it("ships element templates", () => {
  expect(files.length).toBeGreaterThan(0);
});

describe.each(files)("%s", (file) => {
  it("validates against the Camunda 8 element-template schema", () => {
    for (const template of templatesIn(file)) {
      const result = validateZeebe(template);
      expect(result.errors ?? [], `${template.id} against schema ${getZeebeSchemaVersion()}`).toEqual([]);
      expect(result.valid, template.id).toBe(true);
    }
  });

  it("declares the zeebe schema the Cloud provider actually accepts", () => {
    // validateZeebe is lenient about $schema; bpmn-js-element-templates is not,
    // and rejects the whole template with "unsupported $schema attribute" --
    // which surfaces only as a console warning, so the editor silently ends up
    // with no templates at all.
    for (const template of templatesIn(file)) {
      expect(template.$schema, template.id).toBe(
        `https://unpkg.com/${getZeebeSchemaPackage()}/resources/schema.json`,
      );
    }
  });

  it("binds a job type, so the harness registry can dispatch it", () => {
    for (const template of templatesIn(file)) {
      const jobType = template.properties.find(
        (p) => p.binding.type === "zeebe:taskDefinition" && p.binding.property === "type",
      );
      expect(jobType, `${template.id} declares no zeebe:taskDefinition type`).toBeDefined();
    }
  });

  it("uses no Camunda 7 bindings", () => {
    const raw = readFileSync(join(DIR, file), "utf8");
    expect(raw).not.toMatch(/"camunda:/);
  });
});
