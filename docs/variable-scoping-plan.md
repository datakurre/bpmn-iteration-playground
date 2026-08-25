# Variable Scoping: A Design Plan

> **Status: Phases 1-2 implemented.** `ServiceTask` input mapping no longer falls back to the
> whole of `workflow.data`; `CallActivity` and `UserTask` now enforce explicit input/output
> mapping (see "What's implemented" below for the exact shape, and the deviations from the
> original plan that surfaced once it met the real engine). Phases 3-5 (ScriptTask, boundary
> events, event subprocesses, the history/inspector UI reading `Scope` objects, multi-instance)
> remain proposals.

## What's implemented

- **`Scope` persistence** (`graph_agent/persistence.py`): a `Persistent` record per execution-tree node
  (element id/type, resolved inputs, local data, resolved outputs, timestamps), stored in a
  `scopes: OOBTree` on `WorkflowInstance`. `WorkflowService._record_scope` stages one onto the
  in-memory `record` dict (`record["_pending_scopes"]`) at each `ServiceTask`/`UserTask` entry
  and completion; `WorkflowStore.save()` applies every pending scope inside the *same*
  transaction as the rest of that save, via `WorkflowStore._apply_scope`. This deviates from
  the original sketch (a direct `store.record_scope()` write per transition): opening a second,
  separate ZODB transaction concurrently with the `save()` already in flight for the same
  instance reliably deadlocked or hung the commit path in practice, both as a synchronous
  event-loop-thread call and as its own `asyncio.to_thread` call. Riding along in the existing
  transaction sidesteps that entirely, and is arguably the more natively-ZODB shape anyway: one
  transaction per state transition, not several.
- **`ServiceTask` input scoping**: `WorkflowRunner.prompt()` and `WorkflowService._dispatch()`
  both resolve `camunda:inputParameter`s via `resolve_scope_inputs()` (`graph_agent/engine.py`) with no
  fallback to the whole of `workflow.data`; `_dispatch()` additionally *replaces* the task's
  `task.data` with exactly that resolved scope before dispatching the harness, so
  SpiffWorkflow's own gateway/script evaluation on that task never sees anything beyond it.
- **`CallActivity` input/output scoping**: `CallActivity.copy_data`/`update_data` are patched at
  import time (`_patch_call_activity_scoping()` in `graph_agent/engine.py`) to resolve
  `camunda:inputParameter`/`outputParameter` instead of SpiffWorkflow's default full-data copy.
  Output resolves against the called process's own `subworkflow.data` (its instance-wide scope),
  not its terminal task's `task.data` chain -- see "Deviations" below for why.
- **`UserTask` output scoping**: `submit_task()` filters a submission through explicit
  `outputParameters` when declared, else through the task's own `camunda:formData` field ids --
  see "Deviations" for why form fields double as the mapping here.
- **A real, pre-existing gap this surfaced**: `_specs_defined_by()`/`_load_extensions()`
  (`graph_agent/engine.py`) only ever matched `<bpmn:process>` elements, so a task nested inside an
  embedded or event `<bpmn:subProcess>` never got its `camunda:properties`/`formData`/
  `inputOutput` attached at all -- silently masked before this change because the old
  "no inputParameters -> whole workflow.data" prompt fallback happened to make the data visible
  anyway. Fixed by also matching `<bpmn:subProcess>`/`<bpmn:transaction>`/`<bpmn:adHocSubProcess>`
  elements against `workflow.subprocess_specs`.
- **A real, pre-existing gap in message delivery**: `send_message()` only ever wrote an inbound
  message's payload onto the newly-spawned subprocess's `workflow.data` for the event-subprocess
  case; a message resuming an *existing* waiting task left the payload on that task's `task.data`
  chain only. That was invisible until a downstream task's `camunda:inputParameter` started
  reading `workflow.data` exclusively (see `test_events_inbound.py`'s
  `test_workflow_parks_on_message_and_resumes_on_delivery`, which asserted a value that had only
  ever survived by riding the old implicit inheritance chain). `send_message()` now merges the
  payload into the *catching task's own containing (sub)workflow's* `data` for that case too.

### Deviations from the original plan, and why

- **CallActivity output resolves against `subworkflow.data`, not `subworkflow.last_task.data`.**
  The original sketch mirrored SpiffWorkflow's own default (read the terminal task's data
  chain). But a `UserTask` inside the called process now narrows its own `task.data` to its
  input/output mapping on submission (see below), which breaks that chain for anything an
  *earlier* sibling task published and the `UserTask` didn't re-declare. `subworkflow.data` --
  the called process's own instance-wide scope, which every task's declared output mapping
  already publishes into -- is the correct source once every scoped element stops relying on
  chain inheritance.
- **`UserTask` output mapping defaults to declared form fields, not an empty scope.** The
  original plan didn't settle this. Every bundled template's `UserTask`s route gateway
  conditions on submitted form field values with no `camunda:outputParameter` declared anywhere
  (`plan_approval`, `outline_decision`, `proceed_with_fix`, ...) -- requiring an explicit
  `outputParameter` for every one would have meant rewriting every template's forms. Camunda's
  own convention treats a form field as an implicit process-variable declaration; this
  codebase now does too, with an explicit `outputParameter` (when present) taking precedence
  over it. A `UserTask` with neither declared gets nothing published, consistent with every
  other scoped element.
- **The embedded/event `SubProcess` half of the plan is *not* implemented**, only
  `CallActivity`. SpiffWorkflow 3.2.0 parses every `triggeredByEvent="true"` subprocess as the
  plain `SubWorkflowTask` class, not `EventSubprocess` -- there is no class-level way to
  distinguish "an embedded SubProcess" from "an event SubProcess" the way `CallActivity` can be
  singled out from both (confirmed empirically, not assumed). Patching the shared base class
  would have applied the same mapping-required rule to `graph_agent/data/workflows/project.bpmn`'s spawn
  mechanism, whose payload-delivery shape (see above) isn't ready for that yet. Left for a
  follow-up once that shape is settled, per the original plan's own Phase 3.

## Why this needs a plan before it needs code

Today, "workflow data" is one shared dict per SpiffWorkflow (sub)process, and almost every BPMN
element either reads all of it or writes into it directly. Only `ServiceTask` output has any
declared scoping, and only on the way *out*. That is enough to work for the templates in
`graph_agent/data/workflows/`, but it means:

- A CallActivity subprocess sees its entire caller's data on entry and dumps its entire final
  task's data back on return — `camunda:inputOutput` on a `<bpmn:callActivity>` is not read
  anywhere in the codebase, so there is no way to declare (or enforce) what a subprocess is
  actually allowed to depend on.
- A `UserTask` submission (`WorkflowService.submit_task`) writes form output straight into
  `task.data` / `task.workflow.data` with no output-mapping step at all.
- `WorkflowRunner.prompt()` falls back to handing an agent the *entire* `workflow.data` dict
  whenever a `ServiceTask` declares no `inputParameters` (`graph_agent/engine.py`) — several bundled
  templates rely on this fallback today, which is exactly the implicit leakage this plan removes.
- History and forking are the same mechanism: a save point is `copy.deepcopy(workflow)`, the
  *entire* live SpiffWorkflow object graph, taken at every phase boundary
  (`WorkflowService._add_save_point`). Inspecting "what did this task see" means deep-copying and
  keeping around far more state than that task's own scope, and it couples history's shape to
  SpiffWorkflow's internal object model (see `graph_agent/migrations.py`, which exists purely to patch
  persisted SpiffWorkflow internals across version upgrades).
- Nothing states which scope a gateway condition or script expression actually evaluates
  against when a task's own data and its ancestors' data disagree on a key. It works by accident
  of SpiffWorkflow's own inheritance, not by a rule this project chose.

The user-facing ask is simple to state and hard to retrofit: **every element that can declare
Camunda input/output mapping gets its own scope, input mapping is the only way data enters a
child scope, and output mapping is the only way data leaves it back to the parent.** This
document works out what that means element by element, how it sits on top of (not instead of)
SpiffWorkflow, and how it reshapes ZODB persistence and history.

---

## Design principles

1. **One scope per execution-tree node.** Every occurrence of a task, subprocess, or process root
   in the running instance — not every task *spec* — gets its own scope object. Two parallel
   branches through the same `ServiceTask` get two independent scopes, the same way they already
   get two independent `task.data` dicts in SpiffWorkflow.
2. **A child scope's initial contents are exactly its resolved input mapping.** No fallback to
   "the whole parent scope" for any element type, including the ones that today get it for free
   (CallActivity, UserTask, and to a lesser extent ServiceTask's empty-`inputParameters` case).
3. **A parent scope only changes because of a completed child's output mapping.** Nothing a child
   scope did to its own local data is visible upward except through declared
   `camunda:outputParameter` entries, resolved against that child's local data at completion.
4. **The scope tree is the single source of truth for "what can this expression see."** Anywhere
   BPMN evaluates an expression — gateway conditions, script tasks, `resolve_input()` — it
   evaluates against one scope object, not a mix of `task.data` and `workflow.data`.
5. **Scopes are ZODB-native objects, not a serialization of SpiffWorkflow's object graph.** A
   scope is a small `Persistent` record: element id, parent, inputs, local data, outputs,
   timestamps. It does not require deep-copying anything to persist, and it does not require
   `migrate_workflow_object()`-style upgrade shims because it isn't shaped like SpiffWorkflow
   internals.
6. **History is the set of completed scopes, not a set of whole-graph snapshots.** "What happened
   in this run" becomes "list the scopes that reached `completed`/`failed`, each self-contained
   with its own inputs/outputs" — no SpiffWorkflow object needs loading to answer it.

---

## The Scope model

```python
class Scope(Persistent):
    id: str                 # == the SpiffWorkflow task.id for this execution-tree node
    workflow_id: str         # root WorkflowInstance this scope belongs to (for indexing)
    bpmn_id: str              # task_spec.bpmn_id
    bpmn_name: str
    element_type: str         # "Process", "ServiceTask", "UserTask", "CallActivity", ...
    parent_scope_id: str | None   # None only for a process root scope

    status: str                # "active" | "completed" | "failed" | "cancelled"
    inputs: PersistentMapping   # resolved camunda:inputParameter values, as received (audit)
    data: PersistentMapping     # local working variables while this element is active
    outputs: PersistentMapping  # resolved camunda:outputParameter values, as published (audit)

    entered_at: str   # ISO-8601
    completed_at: str | None
```

`inputs` and `outputs` are deliberately kept even though they duplicate values that also land in
`data` / the parent's `data` — they are the audit trail that answers "what mapping actually fired
here", independent of whatever the element did with those values afterward (an agent turn may
mutate `data` extensively; `inputs`/`outputs` never change after being set).

A `WorkflowInstance` (already the ZODB root for one instance in `graph_agent/persistence.py`) gains a
`scopes: OOBTree[str, Scope]` alongside its existing `tasks`/`save_points`/`jobs`. Writes to a
single scope are in-place `Persistent` mutations, exactly like every other field on
`WorkflowInstance` today — no new conflict-retry story needed beyond what
`WorkflowStore._retry_on_conflict` already provides.

A CallActivity's subprocess gets its own **process root scope** (a fresh scope tree, not a node
inside the caller's tree) whose `parent_scope_id` points at the CallActivity task's scope in the
caller. That mirrors how `_sync_children` already treats a called subprocess as its own
`WorkflowInstance` with a `parent_workflow_id` back-reference — the scope tree follows the same
seam, just one level more precise (which *scope*, not just which *instance*, fed it its inputs).

---

## Scope boundaries by element type

| Element | Gets its own scope? | Input mapping source | Output mapping target |
| :--- | :--- | :--- | :--- |
| Process (root / start event) | Yes — the tree root | The instance's initial `variables` | n/a (its "output" is instance completion data) |
| `ServiceTask` | Yes | `camunda:inputParameter`, resolved against parent scope | `camunda:outputParameter`, published to parent scope |
| `UserTask` | Yes | Same as ServiceTask | Submitted form fields, filtered through declared `outputParameter`s (today `submit_task` publishes the raw submission unfiltered — see Phase 2) |
| `ScriptTask` | Yes | Same as ServiceTask | Same as ServiceTask |
| `CallActivity` | Yes, **and** its called process gets its own root scope | `camunda:inputParameter` on the CallActivity element → the called process's root scope | `camunda:outputParameter` on the CallActivity element, resolved against the called process's terminal scope |
| Embedded `SubProcess` / transaction `SubProcess` | Yes, same rule as CallActivity | `camunda:inputParameter` on the subprocess element | `camunda:outputParameter` on the subprocess element |
| Event `SubProcess` (`triggeredByEvent="true"`) | Yes, one fresh scope tree per spawn | `camunda:inputParameter` on the subprocess element, seeded with the triggering message payload as a named input (see below) | Same as SubProcess — nothing implicit |
| Gateways (exclusive/inclusive/parallel) | No — transparent | n/a | n/a |
| Boundary events | Own scope, child of the *activity's* scope | `camunda:inputParameter` on the boundary event | `camunda:outputParameter` on the boundary event |
| Multi-instance activity | One scope per **instance**, all children of the activity's own scope | Loop item mapped in per `camunda:inputParameter` referencing the loop variable | Per-instance outputs collected into the activity's own scope as a list, under the declared output name |

Treating embedded `SubProcess` identically to `CallActivity` is a deliberate simplification, not
a BPMN-spec requirement — Camunda's own default lets an embedded subprocess see its container's
data transparently, since it's "the same process". This plan picks the opaque, mapping-required
reading for **every** subprocess-shaped element, so there is exactly one rule to teach workflow
authors ("if it can nest tasks, it needs `camunda:inputOutput` to see or publish anything"),
rather than one rule for CallActivity and a different one for everything else that happens to
draw a box around other tasks.

### Resolving the ambiguous cases the user flagged

- **Gateways evaluate the scope of the task that just completed**, not a scope of their own.
  They are routing nodes, not data-owning nodes; `agent_status == 'success'` in a
  `bpmn:conditionExpression` reads the immediately preceding task's local `data`. This is already
  effectively true today by accident of SpiffWorkflow's inheritance — this plan makes it a rule
  rather than an accident, and it is why gateways are absent from the "gets its own scope" column
  above.
- **Script tasks** get the same input/output mapping treatment as `ServiceTask` — a script's
  expression evaluates against its own scope's `data`, seeded only from its input mapping.
- **Boundary events** get a scope that is a *child of the activity they're attached to*, not a
  sibling and not the activity's own scope reused — a boundary event fires because the activity
  did *not* complete normally, so it must not inherit the activity's (possibly partial,
  possibly never-published) outputs. It gets its own input mapping, resolved against the
  activity's *parent* scope (the same scope the activity itself was mapped in from).
- **Event subprocesses**: today `send_message()` special-cases this by copying the message
  payload directly onto the spawned subprocess's `workflow.data`, bypassing mapping entirely
  (`graph_agent/workflow_service.py`, documented in `AGENTS.md` §4). Under this model the payload becomes
  a named input available to the event subprocess's `camunda:inputParameter`s (e.g.
  `${__trigger_payload.task_brief}`), resolved the same way any other subprocess input is —
  removing the special case rather than keeping it as a second code path.
- **Multi-instance** is flagged here as the least-settled piece of this plan. Per-instance scopes
  and output collection are sketched above, but multi-instance is not used anywhere in
  `graph_agent/data/workflows/*.bpmn` today, so there is no concrete case to validate the design against yet.
  Recommend deferring multi-instance scoping to its own follow-up once a real template needs it,
  rather than guessing the shape now.

---

## Sitting on top of SpiffWorkflow, not replacing it

SpiffWorkflow still owns task states, gateway routing, timers, and event delivery — none of that
is being rebuilt. What changes is that **SpiffWorkflow's own `task.data` / `workflow.data` stop
being trusted as the source of truth for "what can this element see"**, and instead become a
view that this project resets at every scope boundary:

- **On task entry** (a task becomes `READY`/`STARTED`): resolve `camunda:inputParameter`
  against the parent scope, write the result into a new `Scope`, and — critically — **replace**
  `task.data` with exactly those resolved values (not merge into whatever SpiffWorkflow already
  inherited there). This is what makes SpiffWorkflow's own gateway/script evaluation honor the
  mapping: it evaluates `task.data`, so `task.data` must already equal the mapped scope by the
  time SpiffWorkflow looks at it.
- **On task completion**: resolve `camunda:outputParameter` against the task's own `Scope.data`
  (which by then holds whatever the harness/form produced, mirroring today's `_complete_pi`
  pattern of writing agent results into `task.data` before mapping them out), write the result
  into `Scope.outputs`, and merge *only those* keys into the parent scope. Then — same
  "replace, don't merge" discipline — `task.complete()` proceeds, and any successor's own entry
  step resolves its input mapping from the parent scope as usual, so SpiffWorkflow's own copy of
  data into the successor task never gets a chance to leak the completed task's unmapped locals.
- **On subprocess launch/return** (CallActivity, embedded/transaction/event SubProcess): same
  two hooks, at the subprocess's start task and its end/terminal task, mapping into and out of a
  fresh root `Scope` for the called process rather than a task-level `Scope`.

Concretely this is a small number of interception points, all already present as seams in
`graph_agent/workflow_service.py` and `graph_agent/engine.py`:

- `WorkflowRunner.prompt()` already resolves `inputParameters` for the prompt string; it needs to
  also become the place that *seeds* the task's `Scope` and writes the mapped values into
  `task.data`, and it needs to stop falling back to the whole of `workflow.data` when no
  `inputParameters` are declared (that fallback is exactly the implicit-leakage case this plan
  removes — see Phase 1 below for the compatibility note).
- `WorkflowService._complete_pi()` already computes `sources` and filters through
  `outputParameters` for `ServiceTask`; the same filtering logic becomes the general
  output-mapping step, reused for `UserTask` submission (`submit_task`, which today skips mapping
  entirely) and for subprocess return.
- `WorkflowService._sync_children()` already walks every `SubWorkflowTaskMixin` task to sync
  child `WorkflowInstance` records; the same walk is where a called process's root `Scope` gets
  created and wired to its parent.
- A new symmetric hook is needed at subprocess *launch* — there isn't one today, because
  SpiffWorkflow seeds the subprocess's `workflow.data` itself before this project ever gets a
  chance to intervene. This is the one genuinely new piece of engine plumbing this plan requires:
  intercepting a `CallActivityMixin`/`SubWorkflowTaskMixin` task the moment it starts, before
  `do_engine_steps()` lets SpiffWorkflow populate the child's `workflow.data` from the parent
  task's data, and overwriting it with the resolved input mapping instead.

---

## ZODB persistence: scopes as history, savepoints as resume state

These are two different concerns that are accidentally the same mechanism today, and separating
them is most of what "native to ZODB persistence" buys:

- **History / inspection** ("what did this run do, what did each step see") is answered by
  reading `Scope` objects — cheap, structural, independent of SpiffWorkflow's object model. The
  history view, the Variable Inspector, and the Save Point Inspector (`docs/features/
  history-analytics.md`, `docs/features/savepoints-forking.md`) can all be rebuilt on top of
  "list this workflow's scopes, most recently completed first", each one rendering its own
  `bpmn_id`/`bpmn_name`, `inputs`, `outputs`, and timestamps directly — no deep-copied
  `SavePointSnapshot.workflow` needed to answer any of today's history questions.
- **Resume / fork state** ("give me back a live, resumable SpiffWorkflow at this point") still
  needs *something* SpiffWorkflow-shaped, because forking genuinely means re-entering
  SpiffWorkflow's own execution machinery (`task.complete()`, `do_engine_steps()`) partway
  through. This plan does not remove that need. What it does remove is the requirement that the
  same object also carry every scope's full history for display purposes — today's
  `SavePointSnapshot` conflates "resumable engine state" with "human-readable history", which is
  why it has to deep-copy the entire graph on every phase transition. Once history reads from
  `Scope` objects instead, the resume-state snapshot only needs to be *just* enough SpiffWorkflow
  state to call `task.complete()` and continue — a real reduction in what gets deep-copied, even
  though designing that smaller snapshot format is its own follow-up (see Non-goals below).

`Scope` objects for a completed element are not deleted or summarized away — they stay exactly as
written, which is what "history should be persisted completed elements with their local scopes"
means concretely: the completed `Scope` *is* the history record, not a derived summary of one.
Manual savepoint purge (`plans/concepts.md` "Savepoint retention is a manual purge", implemented
in `WorkflowService.purge_save_points`) continues to apply to the resume-state snapshots only —
`Scope` history is cheap enough (no workspace blob, no deep-copied graph) that it does not need
the same retention story, though this plan does not rule one out later.

---

## Rollout plan

This touches the engine's core data-flow assumptions and every bundled template, so it should
land in independently mergeable, independently testable phases rather than one sweeping change:

1. **Close the ServiceTask input gap, since it is closest to done.** Output mapping is already
   scope-correct (`_complete_pi` filters through `outputParameters`); input mapping is not
   (`resolve_input()`'s whole-`workflow.data` fallback in `WorkflowRunner.prompt()`). Introduce
   `Scope` objects for `ServiceTask` only, require `inputParameters` to be declared (or make the
   fallback an explicit, documented opt-in rather than a silent default), and audit
   `graph_agent/data/workflows/*.bpmn` for templates currently relying on the fallback — `AGENTS.md` §4 already
   notes "several bundled templates rely on this", so expect to update them alongside this phase.
2. **UserTask and CallActivity/SubProcess — the actually-unimplemented cases.** These are zero
   percent scoped today (`submit_task` bypasses mapping; CallActivity has no mapping code at all,
   confirmed by grepping `graph_agent/` for `inputParameters`/`outputParameters` handling — none exists
   outside `ServiceTask`'s `_complete_pi` path). This is the highest-risk, highest-value phase:
   it requires the new subprocess-launch interception hook described above, and it changes
   `composed_delivery.bpmn`'s behavior (its `CallActivity_Review` element currently has no
   `camunda:inputOutput` at all and relies entirely on SpiffWorkflow's default full-data
   inheritance to see `subject` and to publish `cycle_decision`/`cycle_summary`/`cycle_notes`).
3. **ScriptTask, boundary events, event subprocesses.** Each gets its own scope per the table
   above; the event-subprocess payload special case in `send_message()` is replaced by ordinary
   input mapping against a named trigger-payload input.
4. **History and inspection UI move onto `Scope` reads.** Once every element type that can
   declare mapping actually has a `Scope`, rebuild the history/inspector read paths to use it
   instead of `SavePointSnapshot.to_summary()`'s deep-copied `data`/`tasks` fields (they can
   coexist during migration — a `Scope` tree and a resume-state snapshot are additive, not
   mutually exclusive fields on `WorkflowInstance`).
5. **Multi-instance**, deferred until a real template needs it (see above).

Each phase should ship with its own BPMN test fixture exercising exactly the scope rule it adds —
the existing `tests/test_form_mapping.py`, `tests/test_workflow.py`, and
`tests/test_event_subprocess.py` are the natural homes for these, and `tests/test_engine_helpers.py`
already covers `resolve_input()` directly.

---

## Non-goals

- **Not** replacing SpiffWorkflow's execution engine, its script evaluation, or its task-state
  machine. This plan changes what data those mechanisms are handed, not how they work.
- **Not**, in this pass, redesigning the resume-state snapshot format that fork/retry depend on
  (today's `SavePointSnapshot` deep copy). Separating history from resume state is a
  prerequisite for shrinking that snapshot later, but this plan stops at making the separation
  possible, not at implementing a slimmer snapshot.
- **Not** committing to a final multi-instance design yet — flagged above as open.
- **Not** a compatibility promise for existing instances persisted before this lands. Given
  `graph_agent/migrations.py`'s existing precedent for evolving persisted SpiffWorkflow shapes across
  versions, an equivalent one-time migration (or accepting that pre-existing instances simply
  have an empty `scopes` tree and fall back to today's read paths) is a decision for
  implementation time, not this plan.
