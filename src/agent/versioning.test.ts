// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  computeModelHash,
  extractModelInfo,
  stampModel,
  verifyModelHash,
  compareGraphVersions,
} from "./versioning.ts";

const SAMPLE_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_test" targetNamespace="http://graph-agent/bpmn">
  <bpmn:process id="test_process" isExecutable="true">
    <bpmn:startEvent id="start" />
  </bpmn:process>
</bpmn:definitions>`;

describe("BPMN Model Versioning and Self-Hashing", () => {
  it("stamps a model with exporter, version, and valid hash", () => {
    const stamped = stampModel(SAMPLE_BPMN, "0.1.0");

    expect(stamped).toContain('exporter="graph-agent"');
    expect(stamped).toContain('exporterVersion="0.1.0"');
    expect(stamped).toMatch(/<!--\s*ga:modelHash:[a-f0-9]{64}\s*-->/);

    const info = extractModelInfo(stamped);
    expect(info.version).toBe("0.1.0");
    expect(info.isStamped).toBe(true);
    expect(info.isModified).toBe(false);
    expect(verifyModelHash(stamped)).toBe(true);
  });

  it("stamping is idempotent and does not accumulate multiple hash tags", () => {
    const stamped1 = stampModel(SAMPLE_BPMN, "0.1.0");
    const stamped2 = stampModel(stamped1, "0.1.0");

    expect(stamped2).toBe(stamped1);
    const matches = stamped2.match(/<!--\s*ga:modelHash:[a-f0-9]{64}\s*-->/g);
    expect(matches?.length).toBe(1);
  });

  it("updates exporterVersion when stamped with a new version", () => {
    const stampedV1 = stampModel(SAMPLE_BPMN, "0.1.0");
    const stampedV2 = stampModel(stampedV1, "0.2.0");

    expect(stampedV2).toContain('exporterVersion="0.2.0"');
    const info = extractModelInfo(stampedV2);
    expect(info.version).toBe("0.2.0");
    expect(info.isModified).toBe(false);
    expect(verifyModelHash(stampedV2)).toBe(true);
  });

  it("detects manual modifications on a stamped model", () => {
    const stamped = stampModel(SAMPLE_BPMN, "0.1.0");
    // Modify an element inside the model
    const modified = stamped.replace('id="start"', 'id="custom_start"');

    const info = extractModelInfo(modified);
    expect(info.isStamped).toBe(true);
    expect(info.isModified).toBe(true);
    expect(verifyModelHash(modified)).toBe(false);
  });

  it("handles unstamped models as modified / custom", () => {
    const info = extractModelInfo(SAMPLE_BPMN);
    expect(info.isStamped).toBe(false);
    expect(info.isModified).toBe(true);
    expect(verifyModelHash(SAMPLE_BPMN)).toBe(false);
  });

  describe("compareGraphVersions", () => {
    const bundledV2 = stampModel(SAMPLE_BPMN, "0.2.0");
    const bundledV1 = stampModel(SAMPLE_BPMN, "0.1.0");

    it("identifies identical copies", () => {
      const check = compareGraphVersions(bundledV2, bundledV2, "test");
      expect(check.decision).toBe("identical");
    });

    it("identifies unmodified older library copies as can_auto_upgrade", () => {
      const check = compareGraphVersions(bundledV1, bundledV2, "test");
      expect(check.decision).toBe("can_auto_upgrade");
      expect(check.libraryVersion).toBe("0.1.0");
      expect(check.bundledVersion).toBe("0.2.0");
    });

    it("identifies manually modified library copies as modified_conflict", () => {
      const modifiedV1 = bundledV1.replace('id="start"', 'id="my_start"');
      const check = compareGraphVersions(modifiedV1, bundledV2, "test");
      expect(check.decision).toBe("modified_conflict");
    });

    it("identifies unstamped custom library copies as custom_conflict", () => {
      const check = compareGraphVersions(SAMPLE_BPMN, bundledV2, "test");
      expect(check.decision).toBe("custom_conflict");
    });
  });
});
