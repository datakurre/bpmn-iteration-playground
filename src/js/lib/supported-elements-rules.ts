// Restricts what the modeler lets a person create, append, or replace an
// element with to SUPPORTED_ELEMENT_TYPES -- the same allowlist the linters
// enforce (see supported-bpmn-elements.ts). Two layers, both needed:
//
// 1. A `Rules` veto (`SupportedElementsRules` below) for 'shape.create',
//    'elements.create', 'connection.create' and 'shape.replace' -- the real
//    backstop. `BpmnRules` (bpmn-js/lib/features/rules/BpmnRules.js) checks
//    these same actions at the default priority (1000, since it never passes
//    an explicit priority to `addRule`); registering the same actions at a
//    higher priority and returning `false` for a disallowed type vetoes the
//    action outright, before `BpmnRules` is even asked, regardless of which
//    UI path triggered it (palette, keyboard shortcut, paste, XML import).
// 2. A popup-menu entry filter (`SupportedElementsPopupFilter` below) for the
//    'bpmn-create' and 'bpmn-append' ids `bpmn-js-create-append-anything`
//    registers providers on (it replaces the classic per-type palette
//    buttons with a single "create" popup, and the append-from-context-pad
//    popup). Without this, the veto above still blocks the *action*, but the
//    popup would keep listing disallowed options that silently do nothing
//    when clicked -- confusing. This is what actually makes the UI *look*
//    restricted.
//
// Follows this project's existing DI-module pattern (see
// element-templates-extend.ts): plain classes with `static $inject`,
// instantiated by bpmn-js's own DI container, registered as `type` entries
// whose only job is a constructor-time side effect (adding rules / a popup
// provider).
import RuleProvider from "diagram-js/lib/features/rules/RuleProvider";
import { SUPPORTED_ELEMENT_TYPES } from "./supported-bpmn-elements";

interface EventBusLike {
  on(event: string, priority: number, callback: (event: unknown) => unknown): void;
}

interface ElementLike {
  type?: string;
}

// Only the fields each rule's context actually reads -- see
// node_modules/bpmn-js/lib/features/modeling/BpmnRules.js for the same
// context shapes (`shape.create`: `context.shape`; `elements.create`:
// `context.elements`; `connection.create`: `context.source`/`context.target`;
// `shape.replace`: `context.newData`, per diagram-js's Modeling#replaceShape).
interface ShapeCreateContext {
  shape?: ElementLike;
}
interface ElementsCreateContext {
  elements?: ElementLike[];
}
interface ConnectionCreateContext {
  source?: ElementLike;
  target?: ElementLike;
}
interface ShapeReplaceContext {
  newData?: ElementLike;
}

function isAllowed(element: ElementLike | undefined): boolean {
  return element?.type === undefined || SUPPORTED_ELEMENT_TYPES.has(element.type);
}

const HIGHER_THAN_BPMN_RULES = 1500;

export class SupportedElementsRules extends RuleProvider {
  static $inject = ["eventBus"];

  // RuleProvider's own constructor already calls `this.init()` -- overriding
  // `init` (rather than adding a constructor) is the standard extension point,
  // matching every other RuleProvider subclass in bpmn-js/diagram-js.
  override init(): void {
    this.addRule("shape.create", HIGHER_THAN_BPMN_RULES, (context: ShapeCreateContext) =>
      isAllowed(context.shape) ? undefined : false,
    );
    this.addRule("elements.create", HIGHER_THAN_BPMN_RULES, (context: ElementsCreateContext) =>
      (context.elements ?? []).every(isAllowed) ? undefined : false,
    );
    this.addRule("connection.create", HIGHER_THAN_BPMN_RULES, (context: ConnectionCreateContext) =>
      isAllowed(context.source) && isAllowed(context.target) ? undefined : false,
    );
    this.addRule("shape.replace", HIGHER_THAN_BPMN_RULES, (context: ShapeReplaceContext) =>
      isAllowed(context.newData) ? undefined : false,
    );
  }
}

interface PopupMenuEntries {
  [id: string]: unknown;
}

interface PopupMenuProviderLike {
  registerProvider(id: string, priority: number, provider: unknown): void;
}

/**
 * `bpmn-js-create-append-anything` builds each popup entry's id as
 * `${idPrefix}-${actionName}` (CreateMenuProvider uses `idPrefix: 'create'`,
 * AppendMenuProvider `idPrefix: 'append'`) and, once built, the entry itself
 * no longer carries the target bpmn:* type -- only the label/className/action
 * survive (see `toActionEntry` in that package). So filtering has to match on
 * the *action name* half of the id instead. This list is the same allowlist
 * as SUPPORTED_ELEMENT_TYPES, just spelled in that package's own option ids
 * (from its CREATE_OPTIONS/PopupEntries) -- keep the two in sync by hand if
 * either changes.
 */
const ALLOWED_ACTION_NAMES = new Set([
  "user-task",
  "service-task",
  "call-activity",
  "exclusive-gateway",
  "parallel-gateway",
  "none-start-event",
  "none-end-event",
  "terminate-end",
  "collapsed-subprocess",
  "expanded-subprocess",
  // Boundary events, scoped to Timer + Error -- see supported-bpmn-elements.ts's
  // SUPPORTED_EVENT_DEFINITIONS for why. This package has no
  // "non-interrupting-error-boundary" option at all (only an interrupting one).
  "timer-boundary",
  "non-interrupting-timer-boundary",
  "error-boundary",
]);

function filterEntries(entries: PopupMenuEntries, prefix: string): PopupMenuEntries {
  const filtered: PopupMenuEntries = {};
  for (const [id, entry] of Object.entries(entries)) {
    if (id.startsWith(`${prefix}-`)) {
      const actionName = id.slice(prefix.length + 1);
      if (!ALLOWED_ACTION_NAMES.has(actionName)) continue;
    }
    // Anything not under our known prefix (an element-template entry, say)
    // is left untouched -- those are already curated to supported types.
    filtered[id] = entry;
  }
  return filtered;
}

class SupportedElementsPopupFilter {
  static $inject = ["popupMenu"];

  constructor(popupMenu: PopupMenuProviderLike) {
    const HIGHER_THAN_CREATE_APPEND_ANYTHING = 1000;
    popupMenu.registerProvider("bpmn-create", HIGHER_THAN_CREATE_APPEND_ANYTHING, {
      getPopupMenuEntries: () => (entries: PopupMenuEntries) => filterEntries(entries, "create"),
    });
    popupMenu.registerProvider("bpmn-append", HIGHER_THAN_CREATE_APPEND_ANYTHING, {
      getPopupMenuEntries: () => (entries: PopupMenuEntries) => filterEntries(entries, "append"),
    });
  }
}

export const SupportedElementsRulesModule = {
  __init__: ["supportedElementsRules", "supportedElementsPopupFilter"],
  supportedElementsRules: ["type", SupportedElementsRules],
  supportedElementsPopupFilter: ["type", SupportedElementsPopupFilter],
};
