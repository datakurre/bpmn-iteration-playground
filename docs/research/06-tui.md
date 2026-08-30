> **Implemented** as `graph-agent tui` ([#50](https://github.com/datakurre/graph-agent/issues/50)),
> following the recommendation below: `pi-tui` directly, `AssistantMessageComponent`/
> `ToolExecutionComponent` a la carte through `src/tui/pi-bridge.ts`, and the
> trail/status strip/gate wizard as graph-agent's own components. Phase 1's
> transcript, trail, status strip and steering, and phase 2's gate answering
> via `onWait`, shipped together rather than staged, since the issue's own
> acceptance criteria needed gate answering from the start. The graph pane
> (`^g`, `graphOutline()`) and phase 3's `--follow <session>`/`/sessions`/
> `/graph` remain unbuilt -- see [Getting started](../getting-started.html#the-tui)
> and [Harness reference](../harnesses.html#user-tasks) for what actually
> shipped.

# A terminal UI for a graph-driven agent, on top of Pi's TUI toolkit

Checked against Pi 0.84.3 (`@earendil-works/pi-tui`, `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-agent-core`), the versions this repo already pins.

Today `graph-agent run` prints one line per activity and exits. Everything that
makes this project interesting -- where the token stands, which branch a gateway
took, what got spliced in, whether a turn read from cache -- is either invisible
or only visible in the studio, in a browser, after the fact. The studio is the
right place for the *diagram*. It is the wrong place for the thing you actually
do all day, which is talk to the agent.

So: a TUI. The question is what to build it on, and the answer turns on one
distinction that is easy to miss.

## 1. "Pi's TUI" is two different things

| | What it is | Reusable here? |
| --- | --- | --- |
| `@earendil-works/pi-tui` | A standalone terminal toolkit: `Component`/`Container`, `VStack`/`HStack`, `ScrollView`, `SelectList`, `Editor`, `Markdown`, overlays, keybindings, and two renderers (`TuiMainScreen`, `TuiAltScreen`). MIT, `engines: node >=22.19`, two runtime deps (`marked`, `get-east-asian-width`) plus optional prebuilt modifier-key addons for macOS and Windows -- no build step either way. | **Yes, wholesale.** |
| `InteractiveMode` (in `pi-coding-agent`) | Pi's actual chat app. | **No.** See below. |
| The components `InteractiveMode` is built from | `AssistantMessageComponent`, `ToolExecutionComponent`, `renderDiff`, the `Theme` -- all exported from the package index. | **Yes, a la carte.** |

`InteractiveMode` is out because of what it is welded to, not because of its
size. Its constructor takes an `AgentSessionRuntime`, and `AgentSession` owns
the loop: prompt in, Pi's `runLoop()` runs turns and tools until it decides to
stop. That is precisely the thing this project has taken away from Pi and given
to the diagram (`docs/research/05-pi-loops-and-token-cache.md` §1). Embedding
`InteractiveMode` means either handing control flow back to Pi -- which deletes
the premise -- or building a fake `AgentSession` to satisfy it, which is a large
shim against a fast-moving internal type. `FooterComponent` alone requires a
real `AgentSession`, and it is the *simplest* thing in there.

The same objection sinks the other tempting option, **write it as a Pi
extension**. The extension API is genuinely good -- `ui.setWidget()` puts
components above or below the editor, and extensions can register commands and
tool renderers -- but an extension runs inside a Pi session, where Pi still owns
the loop. An extension can decorate a graph-agent run; it cannot host one.

What survives the objection is everything that takes plain data:

```ts
new AssistantMessageComponent(message)          // message: AssistantMessage, from pi-ai
new ToolExecutionComponent(name, id, args, { showImages: false }, undefined, tui, cwd)
```

`PiSession.messages` *is* `AssistantMessage[]` (`src/agent/pi-session.ts`), and
`agent:tool` already has the name, arguments and result at hand
(`src/agent/harnesses.ts`). Nothing has to be translated.

## 2. Recommendation

**Build `graph-agent tui` as its own application on `pi-tui`, rendering the
transcript with Pi's message components and the graph with our own.**

That is not a compromise position; it is the only one that keeps the graph in
charge. What it costs is a status line, a session shell and an input loop --
maybe 600 lines -- against the benefit that the transcript pane, the editor,
autocomplete, overlays, themes and differential rendering are all somebody
else's problem.

One guard rail: every Pi component gets used through a single adapter module,
`src/tui/pi-bridge.ts`. Pi's exports are public API but Pi moves quickly, and the
repo pins exact versions (`0.84.3`, not `^0.84.3`). When a bump breaks a
component signature, one file fails to typecheck instead of six, and the
fallback -- render the message as plain `Text` -- is local.

## 3. What the screen shows

Default layout is **inline** (`TuiMainScreen`), the same as Pi's own default:
the transcript scrolls into the terminal's real scrollback, and only the live
region is redrawn.

```
 assistant  I'll check the workspace first.

   bash  git status --short
   ⋮  (3 lines)

 ─────────────────────────────────────────────────────────────────
  ● run_tools   agent:tool        ↺ 2
  ✓ llm_turn    agent:turn        stop · cache 12.1k
  ✓ drain_steer agent:steer       nothing queued
 ─────────────────────────────────────────────────────────────────
 > ▏
 pi-default-loop · 4 turns · cache 12.1k/13.4k · session a3f9c101      ^g graph
```

Three things above the editor that Pi's TUI has no concept of:

- **The trail.** The last few harness-backed activities, newest first, each with
  its `zeebe:taskDefinition` type and its one-line result summary -- exactly the
  `ActivityOutcome` stream `RunnerOptions.onActivity` already emits
  (`src/agent/engine.ts:36`). `●` marks a postponed activity, `↺ n` the
  iteration count when an id repeats.
- **The status line.** Graph id, turn count, and cache reads over input tokens
  for the session. That last number is the health check doc 05 argues for, and
  the CLI currently never shows it.
- **`^g`**, which swaps in the graph pane.

### The graph pane, without a diagram

Fullscreen (`TuiAltScreen` + `setLayoutRoot`, an `HStack` of transcript and
rail). It does **not** draw BPMN. Terminal BPMN layout is a project in itself,
and the studio already renders the real thing. Instead the rail is a **flow
outline**: a walk of the sequence flows from the start event, one row per flow
element, indented at gateway branches, with loop edges shown as an annotation
rather than as nesting.

```
  start
  ├ drain_steer      agent:steer          ·
  ├ llm_turn         agent:turn           ·
  ◆ gw_tools
  │ ├ run_tools      agent:tool           ●
  │ │ collect_batch  agent:collect-tools
  │ └ ↺ gw_more
  └ end_stop
```

`·` visited, `●` token here, blank unvisited -- all three come from
`meta.visited` / `meta.tokens`, which `SessionStore` already persists. The
outline itself needs one new pure function, `graphOutline(xml)`, alongside
`elementIds()` in `src/agent/graph.ts`: parse with the moddle options already
configured there, walk `sequenceFlow` from the start event, mark back-edges.
Testable with vitest against the four bundled workflows, no terminal involved.

Under the rail, `o` opens the session in the studio -- spawn `graph-agent
studio` if it is not already up, print the URL if opening fails. That is the
deliberate seam: **the terminal shows you where you are, the browser shows you
the shape.**

## 4. Seams that have to change first

The TUI is mostly blocked on the runner being a fire-and-forget function. Four
changes, all useful without any UI on top:

1. **A structured event stream.** `RunSessionOptions.onProgress`
   (`src/agent/runner.ts:37`) is a `(line: string) => void`; a UI cannot render
   a formatted string. Add `onEvent(e: SessionEvent)` with a discriminated union
   -- `activity_end`, `tokens`, `turn`, `graph_revision`, `wait`,
   `expression_warning` -- and keep `onProgress` as a formatter over it so the
   plain CLI is unchanged. Most of the data already flows through `drive()`; it
   is being stringified on the way out.
2. **Streaming assistant text.** `PiSession` subscribes to the agent only long
   enough to catch `message_end` (`src/agent/pi-session.ts:150`). Pi emits
   `message_start` / `message_update` / `message_end` and
   `tool_execution_start` / `_update` / `_end` (`AgentEvent` in
   `pi-agent-core`). Add a constructor-lifetime subscription that forwards them
   to an optional sink, so the TUI can stream a turn as it arrives instead of
   showing it whole 20 seconds later.
3. **A session handle.** `steering` and `followUp` are arrays in `drive()`'s
   closure (`src/agent/runner.ts:127`) with no producer outside the run, and
   `runSession()` only resolves when the run is over. Split it:
   `startSession(options)` returns `{ steer, followUp, abort, answer, done }`.
   `run` awaits `done` and behaves exactly as today; the TUI holds the handle.
4. **Human gates, answered.** `RunnerOptions.onWait` exists and works -- the
   engine re-acquires a live api for asynchronous answers
   (`signalPostponed`, `src/agent/engine.ts`) -- but `cmdRun` never passes it,
   so a `zeebe:userTask` stops the run and snapshots. In the TUI, `onWait`
   returns a promise resolved by the user's answer, and a parked gate renders as
   a question above the editor. This is what makes `session-skeleton.bpmn`'s
   `await_intent` usable interactively rather than as a stop.

Note the ordering constraint that survives all of this: steering enters the
transcript at a `agent:steer` activity, when the *graph* says so, not when the
user hits enter. The TUI must show queued-but-not-yet-delivered messages as
pending (Pi's own TUI has the same concept), or it will look broken every time
the graph is mid-tool-batch.

## 5. Commands

Slash commands with `CombinedAutocompleteProvider`, which the `Editor` takes
directly:

| | |
| --- | --- |
| `/steer <text>`, `/follow <text>` | queue for the next gate; bare text defaults to `/steer` mid-run, or starts the run when idle |
| `/graph [id]` | pick the graph to run, `SelectList` over `graphList()` |
| `/sessions` | resume something, `SelectList` over `listSessions()` |
| `/studio`, `/abort`, `/model` | as they sound |

`/sessions` and `/graph` are overlays, so they cost a `SelectList` and a data
source that already exists in `src/studio/server.ts` and
`src/agent/session-store.ts`.

## 6. Testing

The reason this design is worth preferring: **`Component.render(width)` returns
`string[]`**. The whole UI is a pure function of session state, so it tests in
vitest with no terminal:

```ts
const pane = new GraphPane(outline, { tokens: ["run_tools"], visited: [...] });
expect(stripTerminalSequences(pane.render(60).join("\n"))).toContain("● run_tools");
```

`stripTerminalSequences` is exported from `pi-tui`. For the shell itself,
`TuiBase` takes a `Terminal`, which is a small interface -- twelve methods and three getters -- so a fake that
records writes and replays keystrokes gives an end-to-end test of "type a
prompt, run a dry-run graph, assert the trail" without a pty. That keeps the
TUI inside `make test` rather than needing a `verify-editor`-style browser
harness.

Docs get the same treatment: a script that drives the TUI against a fake
terminal and a `fauxProvider`, and writes the captured frames into
`docs/tui.md` as fenced text. Real output, regenerated like the screenshots,
and no PNGs.

## 7. Phases

| Phase | Ships | Depends on |
| --- | --- | --- |
| 0 | `SessionEvent` union, `startSession()` handle, streaming sink on `PiSession` | -- |
| 1 | `graph-agent tui`: editor, transcript via Pi's components, trail, status line, steering. Walkable with `--dry-run`. | 0 |
| 2 | `graphOutline()`, the graph pane, `^g`, gate answering via `onWait` | 0, 1 |
| 3 | `--follow <session>` (watch the sessions dir like the studio does), `/sessions`, `/graph`, splice notices | 1, 2 |

`graph-agent run` stays exactly as it is: non-interactive, scriptable, what CI
uses. `tui` is a new command, not a flag on `run`.

## 8. Compromises, stated plainly

- **No BPMN in the terminal.** An outline and a trail, plus a key that opens the
  studio. A branch-heavy graph will read worse here than in the browser.
- **Loops flatten.** The outline annotates a back-edge (`↺ gw_more`); it does
  not nest iterations. Iteration count lives on the trail instead.
- **Pi's components are pinned, wrapped, and expendable.** A Pi bump may break
  the transcript pane. One adapter module, plain-text fallback, render tests to
  catch it.
- **Fullscreen loses scrollback.** Hence inline by default and fullscreen as a
  toggle, rather than the reverse.
- **No images, no mouse** in phase 1 -- `ToolExecutionComponent` gets
  `showImages: false`, `TuiAltScreen` gets `mouse: false`.
- **`graph:extend` is reported, not reviewed.** When the agent splices itself,
  the TUI says what element ids arrived and offers the studio. Diffing BPMN in a
  terminal is not phase 3, and may never be.

## 9. Open

- **Following a run started elsewhere.** Phase 3 watches the sessions directory,
  which gives activity and token updates but not streamed text -- the transcript
  is only in Pi's `session.jsonl` after the fact. Good enough for a monitor
  pane; not the same as attaching.
- **Two writers, one session.** Nothing stops `run` and `tui` from opening the
  same session id. `SessionStore` writes atomically, so the file never tears,
  but last-writer-wins on `meta.json`. A lock file, or just a refusal, before
  phase 3.
- **Where the model's own tool-call rendering ends and the graph's begins.** Pi
  renders a tool call as one unit; here the call and its execution are separated
  by at least one activity, and a gateway can refuse the call entirely (doc 05
  §3). The component may need to show a call that never ran.
