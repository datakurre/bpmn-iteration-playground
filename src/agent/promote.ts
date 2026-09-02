/**
 * Writes a session's graph -- with the processes `linkGraph` inlined into it
 * removed -- into the shared library, so a fresh session can start from
 * whatever it converged on instead of that work staying buried in a state
 * directory (issue #55).
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lintBpmn } from "./bpmn-lint.ts";
import { processId, withDefinitionsId, withProcessId } from "./graph.ts";
import { ensureLabelDi } from "../js/lib/bpmn-label-layout.ts";
import { unlinkGraph } from "./link.ts";
import { listBpmnFiles, type Paths } from "./paths.ts";
import { SessionStore } from "./session-store.ts";

export interface PromoteOptions {
  paths: Paths;
  sessionId: string;
  name: string;
  revision?: number;
  force?: boolean;
}

export interface PromoteResult {
  success: boolean;
  targetPath?: string;
  unlinkedCount?: number;
  error?: string;
}

/** Library graph ids/filenames are plain identifiers; sanitize a definitions id the same way. */
export function sanitizeId(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

export async function promoteSession(options: PromoteOptions): Promise<PromoteResult> {
  const { paths, sessionId, name, force = false } = options;
  const store = new SessionStore(paths, sessionId);
  if (!store.exists()) {
    return { success: false, error: `unknown session '${sessionId}'` };
  }

  const revisionFiles = store.graphRevisionFiles();
  if (revisionFiles.length === 0) {
    return { success: false, error: `session '${sessionId}' has no graph` };
  }

  let revisionIndex = revisionFiles.length - 1;
  if (options.revision !== undefined) {
    if (options.revision < 0 || options.revision >= revisionFiles.length) {
      return {
        success: false,
        error: `--revision ${options.revision} is out of range (session '${sessionId}' has revisions 0-${revisionFiles.length - 1})`,
      };
    }
    revisionIndex = options.revision;
  }

  const revisionXml = readFileSync(join(store.graphDir, revisionFiles[revisionIndex]!), "utf8");
  const { xml: unlinkedXml, unlinked } = await unlinkGraph(revisionXml);
  const newProcessId = sanitizeId(name);
  const promotedXml = await ensureLabelDi(
    await withProcessId(
      await withDefinitionsId(unlinkedXml, `Defs_${newProcessId}`),
      newProcessId,
    ),
  );

  const lint = await lintBpmn(promotedXml);
  if (lint.errors > 0) {
    return {
      success: false,
      error: `revision ${revisionIndex} of '${sessionId}' fails bpmnlint:\n${lint.lines.map((l) => `  ${l}`).join("\n")}`,
    };
  }

  const target = join(paths.workflowsDir, `${name}.bpmn`);
  if (existsSync(target) && !force) {
    return {
      success: false,
      error: `'${name}.bpmn' already exists in the library; pass --force to overwrite it (backed up as '${name}.bpmn.bak' first)`,
    };
  }

  if (!force) {
    for (const { path: otherPath } of listBpmnFiles(paths.workflowsDir)) {
      if (otherPath === target) continue;
      if ((await processId(readFileSync(otherPath, "utf8"))) === newProcessId) {
        return {
          success: false,
          error: `process id '${newProcessId}' is already used by ${otherPath}; pass --force to promote anyway, or choose a different --as`,
        };
      }
    }
  }

  if (existsSync(target)) {
    copyFileSync(target, `${target}.bak`);
  }
  writeFileSync(target, promotedXml);

  return {
    success: true,
    targetPath: target,
    unlinkedCount: unlinked.length,
  };
}
