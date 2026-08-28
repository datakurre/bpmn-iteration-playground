# Camunda 8 style BPMN: what it would cost and what it would buy

Checked 2026-08-28. Every claim below is either a registry/licence fact or the
result of a spike run against the engine actually in this repo.

The question: this project currently models Camunda **7** flavour (`camunda:`
namespace, `camunda:properties` harness selection, `camunda:inputOutput`). Should
it move to Camunda **8** style (`zeebe:` namespace, JSON-native variables, FEEL
everywhere)? bpmn-engine dictates the answer, so that is where the research starts.

## 1. bpmn-engine runs Camunda 8 style BPMN — verified

A spike built a C8-shaped graph and ran it on `bpmn-engine` unchanged:

```xml
<serviceTask id="turn">
  <extensionElements>
    <zeebe:taskDefinition type="agent:turn" retries="3" />
    <zeebe:ioMapping>
      <zeebe:input source="=goal" target="instructions" />
      <zeebe:output source="=status" target="agent_status" />
    </zeebe:ioMapping>
  </extensionElements>
</serviceTask>
...
<conditionExpression xsi:type="tFormalExpression">=agent_status = "success"</conditionExpression>
```

Result:

```
1. zeebe namespace parses, warnings: 0
   zeebe:taskDefinition type = agent:turn retries = 3
   zeebe:ioMapping inputs: [ 'instructions<==goal' ]
2. serializer id: Defs_c8
3. dispatched job type: agent:turn
4. path taken: start -> turn -> gw -> ok
RESULT: Camunda 8 style graph EXECUTES on bpmn-engine
```

What that took: `zeebe-bpmn-moddle` as `moddleOptions.zeebe`, one extension
function reading `zeebe:taskDefinition` instead of `camunda:properties`, and an
expressions handler that recognises C8's leading `=` instead of `${...}`. That
last point is the only non-obvious one — C8 conditions are not `${}`-wrapped, so
`isExpression`/`hasExpression` have to be overridden as well as
`resolveExpression`, or bpmn-elements treats the condition as a literal string
and takes the flow unconditionally.

`adHocSubProcess` also executes (`end:start | end:read_file | end:run_bash |
end:tools | end:end`). **Unverified:** whether bpmn-elements supports *selective*
activation of contained activities, which is what C8's agentic orchestration
relies on. It ran both contained tasks. This needs checking before leaning on it.

### The caveat that applies to both options

Neither choice makes bpmn-engine engine-compatible. bpmn-engine implements the
BPMN 2.0 scheme and executes whatever behaviour we attach; `camunda:` and
`zeebe:` are equally just namespaces it parses without semantics. A graph written
here will not run unchanged on Zeebe, and a Zeebe graph will not bring its
semantics here. This is a **modelling-convention** decision, not an engine
decision — which is exactly why bpmn-engine does not veto it.

## 2. What it would do to the editor dependencies

This is where the real gain is, and it is bigger than expected.

The three vendored Operaton submodules exist to keep Camunda 7 element templates
working. Their divergence from upstream turns out to be *one commit*:

```
ed8d91e chore: package-lock.json
87cf548 chore: keep Camunda 7 element templates only     <- the fork
6cb8c75 2.24.0                                            <- upstream
```

Upstream `bpmn-js-element-templates` (2.34.0, MIT, published 2026-08-27) still
supports **both** engines and exports a provider for each:

| Engine | Module |
| --- | --- |
| Camunda 7 | `ElementTemplatesPropertiesProviderModule` |
| Camunda 8 | `CloudElementTemplatesPropertiesProviderModule` |

So the forks are a *narrowing*, not a capability we cannot get from npm. Moving
to C8 style means the editor can take the upstream package directly, and with it:

- **all three git submodules go away** — no `.gitmodules`, no `make vendor-build`,
  no `make check-vendor-pins`, no flake inputs mirroring submodule pins;
- **the esbuild alias map goes away** — it exists solely because the vendored
  rollup dists import `@bpmn-io/properties-panel` and preact as unresolved bare
  specifiers that then resolve to each submodule's own `node_modules`. With
  ordinary npm packages there is no second install to leak, so the entire
  Preact-duplication hazard (and the `useService` crash it causes) stops existing
  rather than being defended against;
- **`src/js/build/bundle-invariants.test.ts` becomes unnecessary** — it guards a
  hazard that would no longer be reachable.

That is a large, permanent simplification of the riskiest part of the port.

## 3. Licences

| Package | Version | Licence |
| --- | --- | --- |
| `zeebe-bpmn-moddle` | 2.0.0 | MIT |
| `bpmn-js-element-templates` | 2.34.0 | MIT |
| `@bpmn-io/element-templates-validator` | 2.26.0 | MIT |
| `@camunda/element-templates-json-schema` | 0.22.1 | MIT |
| `@bpmn-io/feel-editor` | 2.7.1 | MIT |
| `@bpmn-io/feel-lint` | 3.2.0 | MIT |
| `camunda-bpmn-js` | 5.34.0 | MIT |
| `feelin` | 7.0.1 | MIT |
| **`bpmn-js`** | 18.25.1 | **bpmn.io licence, not MIT** |

All of the C8 stack is MIT and all of it was published within the last week.

`bpmn-js` deserves its own line, and it applies **either way**: it is MIT-like
except for one clause —

> The source code responsible for displaying the bpmn.io project watermark that
> links back to https://bpmn.io as part of rendered diagrams MUST NOT be removed
> or changed. When this software is being used in a website or application, the
> watermark must stay fully visible and not visually overlapped by other elements.

Any UI shipping the modeler or viewer has to keep that watermark visible and
unobscured. Worth knowing now rather than at release.

## 4. The three features, assessed

**JSON-native process instance data.** C8 variables are JSON throughout. In
practice bpmn-engine variables are already plain JavaScript objects and the
session store already round-trips them as JSON, so the gain here is convention
rather than capability: `zeebe:ioMapping` with FEEL expressions replaces
`camunda:inputOutput` with `${}` string templates, and nested structures stop
needing the dotted-path lookup that `camunda7.ts` implements by hand.

**FEEL as the sole expression language.** Already done — the engine moved to
`feelin` before this question came up. C8 style changes only the surface syntax:
`=status = "success"` rather than `${status = "success"}`. The single-language
argument is stronger under C8, because C7 mixes JUEL, and diagrams here would no
longer be half-Camunda-7-syntax-half-FEEL, which is a genuinely confusing hybrid
to leave in place.

**Editor experience.** `@bpmn-io/feel-editor` (MIT) is the FEEL widget the
properties panel uses for `zeebe:` bindings — syntax highlighting, completion and
`@bpmn-io/feel-lint` diagnostics on every expression field. Under C7 bindings the
same fields are plain text inputs. This is the largest day-to-day difference for
anyone editing graphs by hand, which the studio exists to support.

## 5. Direction of travel

Camunda 8.8 and 8.9 build **agentic orchestration** on `adHocSubProcess`: a
system prompt, a set of tools inside an ad-hoc sub-process, and an LLM that
activates them one at a time until it returns a final answer. That is the same
shape as this project's design, arrived at independently. Modelling in C8
conventions means the diagrams stay legible to that ecosystem and its tooling;
Camunda 7 is end-of-life, with Operaton as its community continuation.

## 6. Recommendation

**Switch, and switch now.** The editor-dependency simplification alone justifies
it — deleting three submodules, a vendored build step, and the single most
fragile piece of the whole port. The FEEL argument is already half-won, and the
remaining half removes a confusing hybrid rather than adding anything.

Cost, and why now is the cheapest moment: three workflow graphs to re-express,
`camunda7.ts` to become a `zeebe` mapping, three element templates to rewrite,
one editor module swap, submodules and their pin-checking to delete. Every one of
those grows with the number of diagrams in the repo, and there are three today.

Open item to settle first: selective activation inside `adHocSubProcess`
(§1). If bpmn-elements cannot activate contained activities individually, the
agent loop keeps its current explicit shape — which works — and ad-hoc regions
stay a modelling nicety rather than the mechanism.
