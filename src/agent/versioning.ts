/**
 * BPMN Model versioning, canonical self-hashing, and upgrade integrity.
 *
 * Built-in BPMN workflows are stamped with `exporter="graph-agent"`, an
 * `exporterVersion="<version>"`, and an embedded self-hash comment
 * `<!-- ga:modelHash:<sha256> -->` right before `</bpmn:definitions>`.
 *
 * When checking library files on disk against bundled copies:
 * - A model with a matching self-hash is guaranteed to be untouched by the user,
 *   allowing `graph-agent init` to upgrade it automatically to a newer bundled version.
 * - A model whose self-hash does not match (or has manual edits) is protected from
 *   silent overwrites, triggering a warning and requiring `--refresh` (with automatic backup).
 */
import { createHash } from "node:crypto";

const HASH_COMMENT_REGEX = /\n?[ \t]*<!--\s*ga:modelHash:([a-f0-9]{64})\s*-->/i;

export interface ModelInfo {
  version?: string;
  embeddedHash?: string;
  computedHash: string;
  isStamped: boolean;
  isModified: boolean;
}

export type UpgradeDecision =
  | "identical"
  | "can_auto_upgrade"
  | "modified_conflict"
  | "custom_conflict";

export interface GraphUpgradeCheck {
  id: string;
  decision: UpgradeDecision;
  libraryVersion?: string;
  bundledVersion?: string;
  reason: string;
}

/**
 * Normalizes XML by removing the embedded modelHash comment and standardizing line endings.
 */
export function normalizeForHashing(xml: string): string {
  return xml.replace(HASH_COMMENT_REGEX, "").replace(/\r\n/g, "\n").trim();
}

/**
 * Computes SHA-256 hash of the normalized model XML.
 */
export function computeModelHash(xml: string): string {
  const normalized = normalizeForHashing(xml);
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Extracts version metadata and verifies hash integrity of a BPMN model.
 */
export function extractModelInfo(xml: string): ModelInfo {
  const versionMatch = /<(?:bpmn:)?definitions\b[^>]*\bexporterVersion="([^"]+)"/i.exec(xml);
  const version = versionMatch ? versionMatch[1] : undefined;

  const hashMatch = HASH_COMMENT_REGEX.exec(xml);
  const embeddedHash = hashMatch ? hashMatch[1]?.toLowerCase() : undefined;
  const computedHash = computeModelHash(xml);

  const isStamped = embeddedHash !== undefined;
  const isModified = !isStamped || embeddedHash !== computedHash;

  return {
    version,
    embeddedHash,
    computedHash,
    isStamped,
    isModified,
  };
}

/**
 * Verifies whether the model XML is stamped and unmodified.
 */
export function verifyModelHash(xml: string): boolean {
  const info = extractModelInfo(xml);
  return info.isStamped && !info.isModified;
}

/**
 * Stamps model XML with exporter="graph-agent", exporterVersion="<version>",
 * and embeds the canonical SHA-256 self-hash before `</bpmn:definitions>`.
 */
export function stampModel(xml: string, version: string): string {
  let cleaned = xml.replace(HASH_COMMENT_REGEX, "").replace(/\r\n/g, "\n").trim();

  // Ensure exporter="graph-agent" and exporterVersion="..." on <bpmn:definitions>
  cleaned = cleaned.replace(
    /(<(?:bpmn:)?definitions\b)([^>]*?)(\/?>)/s,
    (_match, prefix, attrs, suffix) => {
      let updatedAttrs = attrs;
      if (/\bexporter="[^"]*"/.test(updatedAttrs)) {
        updatedAttrs = updatedAttrs.replace(/\bexporter="[^"]*"/, 'exporter="graph-agent"');
      } else {
        updatedAttrs += ' exporter="graph-agent"';
      }

      if (/\bexporterVersion="[^"]*"/.test(updatedAttrs)) {
        updatedAttrs = updatedAttrs.replace(/\bexporterVersion="[^"]*"/, `exporterVersion="${version}"`);
      } else {
        updatedAttrs += ` exporterVersion="${version}"`;
      }
      return `${prefix}${updatedAttrs}${suffix}`;
    },
  );

  const hash = computeModelHash(cleaned);
  const hashTag = `  <!-- ga:modelHash:${hash} -->\n`;

  if (cleaned.includes("</bpmn:definitions>")) {
    return cleaned.replace(/([ \t]*<\/bpmn:definitions>)/, `${hashTag}$1`);
  } else if (cleaned.includes("</definitions>")) {
    return cleaned.replace(/([ \t]*<\/definitions>)/, `${hashTag}$1`);
  }

  return `${cleaned}\n${hashTag}`;
}

/**
 * Compares a user's library graph against the bundled version.
 */
export function compareGraphVersions(
  libraryXml: string,
  bundledXml: string,
  id: string,
): GraphUpgradeCheck {
  if (libraryXml.trim() === bundledXml.trim()) {
    const info = extractModelInfo(bundledXml);
    return {
      id,
      decision: "identical",
      libraryVersion: info.version,
      bundledVersion: info.version,
      reason: "Library copy is identical to bundled version",
    };
  }

  const bundledInfo = extractModelInfo(bundledXml);
  const libraryInfo = extractModelInfo(libraryXml);

  // If the library copy has a valid embedded hash, it has not been modified manually by the user.
  if (libraryInfo.isStamped && !libraryInfo.isModified) {
    return {
      id,
      decision: "can_auto_upgrade",
      libraryVersion: libraryInfo.version,
      bundledVersion: bundledInfo.version,
      reason: `Library copy is an unmodified older version (v${libraryInfo.version ?? "unknown"}) and can be upgraded to v${bundledInfo.version ?? "unknown"}`,
    };
  }

  // If the library copy had a stamp but the hash failed, it was edited by the user.
  if (libraryInfo.isStamped && libraryInfo.isModified) {
    return {
      id,
      decision: "modified_conflict",
      libraryVersion: libraryInfo.version,
      bundledVersion: bundledInfo.version,
      reason: `Library copy (v${libraryInfo.version ?? "unknown"}) has manual modifications that differ from bundled v${bundledInfo.version ?? "unknown"}`,
    };
  }

  // Unstamped / custom file
  return {
    id,
    decision: "custom_conflict",
    libraryVersion: libraryInfo.version,
    bundledVersion: bundledInfo.version,
    reason: `Library copy differs from bundled v${bundledInfo.version ?? "unknown"} and contains custom changes`,
  };
}
