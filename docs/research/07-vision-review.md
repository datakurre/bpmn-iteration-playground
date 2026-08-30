# How the implementation stands against the vision

Fourth pass, on `main` at 37c3eb8 -- a clean checkout, after the five issues
the third pass (`5776ba1`) raised were all closed. Method unchanged: read the
tree, then drive the built CLI, TUI and studio against real
`claude-haiku-4-5` in a throwaway workspace (`XDG_*` pointed at scratch, never
this checkout -- `createPiToolExecutor` hands the model real
`write`/`edit`/`bash`).

`make lint` (all six graphs clean), `make test` (449 tests) and
`make verify-editor` are green.

## The vision, restated

1. A Pi coding agent whose control flow is a mutable BPMN graph rather than a
   code loop.
2. Start simple by reproducing Pi's default loop, then iterate towards
   dedicated, re-usable definitions.
3. Usable from a CLI or a TUI; the Web UI is for visualising and editing the
   diagram.
4. Every session gets its own mutable BPMN definition and a running instance
   of it.
5. The default is: start from a prompt, then let a predefined sub-graph
   (generate -> lint -> verify, through a `callActivity`) interpret it and
   build the steps that follow.
6. The user can update the graph through the Web UI at any time, as long as
   the parts currently executing are not removed, so the instance can migrate.
7. User tasks for prompts, service tasks for agent and shell work, made easy
   by predefined element templates.
8. Out of the box it behaves like default Pi, with execution going through the
   session-specific BPMN and `callActivity`s implementing Pi's loops.

## Every numbered point is now met

This is the first pass where that is true, so it is worth saying plainly.
Points 1, 2, 4, 7 and 8 have held since the second pass; point 5 landed with
`session-craft` in the third; and this pass closes the two that were still
mis-calibrated.

**Point 3 is real now.** `graph-agent tui --resume` was unusable last pass --
it rendered the parked question and quit 5.9 seconds later. Verified fixed,
end to end against Haiku: reattach to a session parked on `await_intent`, type
the three form fields, and the session drives the craft sub-graph and parks
again on the *next* gate, interactively:

```
 waiting on await_intent — Goal (intent):
 ...
  lint_fragment  graph:lint  adds 2 element(s)
 waiting on review_fragment — Apply this extension? (approval):
# meta: 0 turns -> 1 turn, tokens await_intent -> craft, lint_fragment, gw_lint, review_fragment
```

The status strip also names the graph (`graph session-skeleton`) rather than
the `(resumed)` placeholder.

**Point 6's rule is now calibrated correctly.** The live set is derived from
the engine snapshot rather than from cumulative bookkeeping, so both halves
hold at once -- verified against two real sessions:

```
parked session, token inside craft:
  rename draft_fragment   -> HTTP 409  "these elements have live state"
completed session, no live state:
  rename await_intent     -> HTTP 200
```

An element with recoverable state in a running sub-process is protected; one
belonging to a process that has ended is editable again. That is the vision's
sentence, not a proxy for it.

Also fixed and verified: `--max-auto-answers` exists so the cap message's own
advice is followable, `session_done` is checked before re-entering craft
(answering "End the session instead" no longer costs a model turn), and
`--help` documents `tui --resume`.

## Where it still falls short

The remaining gaps are no longer about features. They are about what happens
when two writers touch one session at the same time -- which the vision's
"at any time the user can update the graph" makes the expected mode, not an
edge case.

| # | Gap | Vision point |
|---|---|---|
| [#75](https://github.com/datakurre/graph-agent/issues/75) | A studio edit made during a live run is silently discarded by the next `graph:extend`, and `checkSplice` compares against a stale baseline | 6 |
| [#76](https://github.com/datakurre/graph-agent/issues/76) | `PUT /api/sessions/:id/graph` has no concurrency control and no awareness of a live run; two editors overwrite each other | 6 |
| [#77](https://github.com/datakurre/graph-agent/issues/77) | `--max-auto-answers abc` reports `got 'NaN'` rather than what the user typed | -- |

### The shape of what is left

`drive()` reads the session graph once (`src/agent/runner.ts:218`) and caches
it for the whole run. Everything downstream -- `getGraph()`, and therefore
`graph:lint` and `graph:extend`'s `checkSplice` baseline -- sees that copy, not
the file. Demonstrated with a real crafting run and a studio edit ten seconds
in:

```
revisions 3
  r0 started from .../session-craft.bpmn, linked craft_graph, pi_default_loop
  r1 studio edit
  r2 graph:extend  ['shell_pwd', 'shell_to_crafted']

000.bpmn studio_added=0
001.bpmn studio_added=1     <- the user's edit, orphaned
002.bpmn studio_added=0     <- current graph: edit discarded, no warning
```

The second half is the sharper one: because the baseline was stale, the
additive check never saw `studio_added` being removed. The guard that exists to
stop elements disappearing out from under a live instance could not see the
element it was meant to protect. On a graph without `graph:extend` the milder
version applies -- the edit survives on disk and the run simply ignores it,
also silently.

#76 is the same root seen from the server side: the write route validates the
*content* of an edit carefully and the *timing* not at all -- no `ETag`, no
`If-Match`, no check on `meta.pid`, even though `pid` and `isProcessAlive()`
already exist from #52 and answer exactly that question. Two studio tabs
clobber each other with two `200`s.

Neither is hard to fix, and both are the last structural thing standing
between "the vision is implemented" and "the vision is safe to use the way it
is described".

### On the documentation

Accurate on every point checked this pass. The `tui --resume` claim that
outran the code two passes ago is now true and documented in `--help` as well
as in `README.md` and `docs/getting-started.md`; the `session-craft` worked
example matches what the graph actually does.

The one omission is the subject of #75 and #76: nothing in `docs/` says what
happens if you edit a graph while its session is running -- which is the
first thing a reader of the vision statement would try.
