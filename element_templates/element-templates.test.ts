// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateZeebe, getZeebeSchemaPackage, getZeebeSchemaVersion } from "@bpmn-io/element-templates-validator";
import { createHarnesses, HARNESS_IO, type HarnessDeps } from "../src/agent/harnesses.ts";
import { HARNESS_RESULT_BASE_FIELDS } from "../src/agent/harness.ts";

const DIR = import.meta.dirname;
const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));

interface TemplateBinding {
  type: string;
  property?: string;
  name?: string;
  source?: string;
  key?: string;
}

interface Template {
  $schema?: string;
  id: string;
  name: string;
  appliesTo: string[];
  properties: Array<{ value?: string; binding: TemplateBinding }>;
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

/**
 * Closes the class of bug issue #49 found: a template can bind a job type
 * that exists, an input name the harness never reads, or an output source
 * the harness never publishes, and nothing catches it because the harness
 * itself is only exercised through hand-written graphs that happen to use
 * the right names. Check every template's bindings against `HARNESS_IO`,
 * the harnesses' own declared contract, instead.
 */
describe("harness I/O contract (issue #49)", () => {
  function stubDeps(): HarnessDeps {
    return {
      pi: {} as HarnessDeps["pi"],
      tools: {} as HarnessDeps["tools"],
      store: {} as HarnessDeps["store"],
      getGraph: () => "",
      setGraph: () => {},
      takeSteering: () => [],
      takeFollowUp: () => [],
    };
  }

  it("HARNESS_IO covers exactly the registered job types -- so this test cannot drift from the registry", () => {
    const registered = Object.keys(createHarnesses(stubDeps())).sort();
    expect(Object.keys(HARNESS_IO).sort()).toEqual(registered);
  });

  function jobTypeOf(template: Template): string | undefined {
    return template.properties.find((p) => p.binding.type === "zeebe:taskDefinition" && p.binding.property === "type")
      ?.value;
  }

  describe.each(files)("%s", (file) => {
    for (const template of templatesIn(file)) {
      const jobType = jobTypeOf(template);

      it(`${template.id} names a job type a harness actually handles`, () => {
        expect(jobType, `${template.id} declares no zeebe:taskDefinition type`).toBeDefined();
        expect(jobType && jobType in HARNESS_IO, `${template.id} names unregistered job type '${jobType}'`).toBe(
          true,
        );
      });

      it(`${template.id}'s zeebe:input bindings are names '${jobType}' actually reads`, () => {
        const contract = jobType ? HARNESS_IO[jobType] : undefined;
        const allowed = new Set(contract?.inputs ?? []);
        for (const p of template.properties) {
          if (p.binding.type !== "zeebe:input") continue;
          expect(
            p.binding.name !== undefined && allowed.has(p.binding.name),
            `${template.id} maps input '${p.binding.name}', which '${jobType}' never reads`,
          ).toBe(true);
        }
      });

      it(`${template.id}'s zeebe:taskHeader bindings are keys '${jobType}' actually reads`, () => {
        const contract = jobType ? HARNESS_IO[jobType] : undefined;
        const allowed = new Set(contract?.headers ?? []);
        for (const p of template.properties) {
          if (p.binding.type !== "zeebe:taskHeader") continue;
          expect(
            p.binding.key !== undefined && allowed.has(p.binding.key),
            `${template.id} sets header '${p.binding.key}', which '${jobType}' never reads`,
          ).toBe(true);
        }
      });

      it(`${template.id}'s zeebe:output bindings are fields '${jobType}' actually publishes`, () => {
        const contract = jobType ? HARNESS_IO[jobType] : undefined;
        const allowed = new Set([...HARNESS_RESULT_BASE_FIELDS, ...(contract?.outputs ?? [])]);
        for (const p of template.properties) {
          if (p.binding.type !== "zeebe:output") continue;
          const field = p.binding.source?.replace(/^=/, "");
          expect(
            field !== undefined && allowed.has(field),
            `${template.id} reads output '${field}', which '${jobType}' never publishes`,
          ).toBe(true);
        }
      });
    }
  });
});
