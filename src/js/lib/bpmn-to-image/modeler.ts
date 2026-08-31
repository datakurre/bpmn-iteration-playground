/**
 * Headless BpmnModeler construction.
 *
 * Wraps `createHeadlessCanvas` with the moddle extensions needed to import
 * real-world BPMN files (Camunda 7 / Operaton extension attributes are
 * common even in diagrams that don't otherwise use Camunda features).
 */

import camundaModdle from 'camunda-bpmn-moddle/resources/camunda.json' with { type: 'json' };
import { createHeadlessCanvas, getBpmnModeler } from './headless-canvas';

/** Moddle extensions registered on every modeler instance by default. */
const DEFAULT_MODDLE_EXTENSIONS = { camunda: camundaModdle };

export interface CreateModelerOptions {
  /** Additional/overriding moddle extensions, merged with the Camunda defaults. */
  moddleExtensions?: Record<string, unknown>;
}

/** Create a BpmnModeler and import the supplied BPMN 2.0 XML into it. */
export async function createModelerFromXml(
  xml: string,
  options: CreateModelerOptions = {}
): Promise<any> {
  const container = createHeadlessCanvas();
  const BpmnModeler = getBpmnModeler();
  const moddleExtensions = { ...DEFAULT_MODDLE_EXTENSIONS, ...options.moddleExtensions };
  const modeler = new BpmnModeler({ container, moddleExtensions });

  const result = await modeler.importXML(xml);
  const warnings: unknown[] = (result && (result as any).warnings) || [];
  if (warnings.length > 0) {
    console.error(`[bpmn-to-image] ${warnings.length} warning(s) while importing BPMN XML`);
  }

  return modeler;
}
