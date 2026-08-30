// bpmn-js-bpmnlint runs in the browser with no filesystem, so bpmnlint's
// default node-resolver (which `require()`s rule packages by name) can't
// resolve rule names from a plain `.bpmnlintrc`-style config. Normally a
// bundler loader (bpmnlint-loader for webpack, rollup-plugin-bpmnlint for
// Rollup) packs the resolved rule implementations at build time; esbuild has
// no equivalent, so this builds the same kind of static cache by hand from
// bpmnlint's own bundled "recommended" rule config and rule modules.
import recommendedConfig from "bpmnlint/config/recommended";
import StaticResolver from "bpmnlint/lib/resolver/static-resolver";

import adHocSubProcess from "bpmnlint/rules/ad-hoc-sub-process";
import conditionalFlows from "bpmnlint/rules/conditional-flows";
import endEventRequired from "bpmnlint/rules/end-event-required";
import eventBasedGateway from "bpmnlint/rules/event-based-gateway";
import eventSubProcessTypedStartEvent from "bpmnlint/rules/event-sub-process-typed-start-event";
import fakeJoin from "bpmnlint/rules/fake-join";
import globalRule from "bpmnlint/rules/global";
import labelRequired from "bpmnlint/rules/label-required";
import linkEvent from "bpmnlint/rules/link-event";
import noBpmndi from "bpmnlint/rules/no-bpmndi";
import noComplexGateway from "bpmnlint/rules/no-complex-gateway";
import noDisconnected from "bpmnlint/rules/no-disconnected";
import noDuplicateSequenceFlows from "bpmnlint/rules/no-duplicate-sequence-flows";
import noGatewayJoinFork from "bpmnlint/rules/no-gateway-join-fork";
import noImplicitEnd from "bpmnlint/rules/no-implicit-end";
import noImplicitSplit from "bpmnlint/rules/no-implicit-split";
import noImplicitStart from "bpmnlint/rules/no-implicit-start";
import noInclusiveGateway from "bpmnlint/rules/no-inclusive-gateway";
import noOverlappingElements from "bpmnlint/rules/no-overlapping-elements";
import singleBlankStartEvent from "bpmnlint/rules/single-blank-start-event";
import singleEventDefinition from "bpmnlint/rules/single-event-definition";
import startEventRequired from "bpmnlint/rules/start-event-required";
import subProcessBlankStartEvent from "bpmnlint/rules/sub-process-blank-start-event";
import superfluousGateway from "bpmnlint/rules/superfluous-gateway";
import superfluousTermination from "bpmnlint/rules/superfluous-termination";

// bpmnlint resolves bare (unprefixed) rule names, as used by
// `config/recommended`, against the `bpmnlint` package itself, so the
// StaticResolver cache keys are `rule:bpmnlint/<rule-name>`.
const resolver = new StaticResolver({
  "rule:bpmnlint/ad-hoc-sub-process": adHocSubProcess,
  "rule:bpmnlint/conditional-flows": conditionalFlows,
  "rule:bpmnlint/end-event-required": endEventRequired,
  "rule:bpmnlint/event-based-gateway": eventBasedGateway,
  "rule:bpmnlint/event-sub-process-typed-start-event": eventSubProcessTypedStartEvent,
  "rule:bpmnlint/fake-join": fakeJoin,
  "rule:bpmnlint/global": globalRule,
  "rule:bpmnlint/label-required": labelRequired,
  "rule:bpmnlint/link-event": linkEvent,
  "rule:bpmnlint/no-bpmndi": noBpmndi,
  "rule:bpmnlint/no-complex-gateway": noComplexGateway,
  "rule:bpmnlint/no-disconnected": noDisconnected,
  "rule:bpmnlint/no-duplicate-sequence-flows": noDuplicateSequenceFlows,
  "rule:bpmnlint/no-gateway-join-fork": noGatewayJoinFork,
  "rule:bpmnlint/no-implicit-end": noImplicitEnd,
  "rule:bpmnlint/no-implicit-split": noImplicitSplit,
  "rule:bpmnlint/no-implicit-start": noImplicitStart,
  "rule:bpmnlint/no-inclusive-gateway": noInclusiveGateway,
  "rule:bpmnlint/no-overlapping-elements": noOverlappingElements,
  "rule:bpmnlint/single-blank-start-event": singleBlankStartEvent,
  "rule:bpmnlint/single-event-definition": singleEventDefinition,
  "rule:bpmnlint/start-event-required": startEventRequired,
  "rule:bpmnlint/sub-process-blank-start-event": subProcessBlankStartEvent,
  "rule:bpmnlint/superfluous-gateway": superfluousGateway,
  "rule:bpmnlint/superfluous-termination": superfluousTermination,
});

// Shape expected by `bpmn-js-bpmnlint`'s `linting.bpmnlint` option.
export const recommendedLintConfig = {
  config: {
    ...recommendedConfig,
    rules: {
      ...recommendedConfig.rules,
      // Matches scripts/bpmn-tools.mjs's CLI config: an implicit merge (more
      // than one incoming flow into a plain activity or event) is forbidden
      // here too, not just flagged at "warn" -- see that file's own comment
      // for why, and any workflows/*.bpmn's gw_*_entry gateways for the
      // merging-exclusive-gateway pattern to use instead.
      "fake-join": "error",
    },
  },
  resolver,
};
