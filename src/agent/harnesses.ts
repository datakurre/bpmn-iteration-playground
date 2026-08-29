/**
 * The job types a graph can dispatch to.
 *
 * Each `zeebe:taskDefinition type="..."` in a diagram names one of these. They
 * are deliberately thin: the decisions live in the graph, and the state lives in
 * the Pi session, so a harness is mostly a translation between the two.
 */
import { spawn } from "node:child_process";
import { layoutProcess } from "bpmn-auto-layout";
import { checkSplice } from "./graph.ts";
import { failed, ok, type Harness, type HarnessRegistry, type HarnessResult } from "./harness.ts";
import type { PiSession, ToolCallRequest } from "./pi-session.ts";
import type { ToolExecutor } from "./tool-executor.ts";
import type { SessionStore } from "./session-store.ts";
import type { TurnRecord } from "../studio/types.ts";

/** Matches craft-graph.bpmn's own `gw_lint` condition (`lint_attempts >= 3`). */
const MAX_LINT_ATTEMPTS = 3;

/**
 * Canned instructions for `zeebe:taskHeaders`' `agent_role` header, layered in
 * front of whatever the graph maps as the turn's own `prompt`. draft_fragment
 * has always carried `agent_role="graph_architect"`, but nothing ever read it
 * (issue #37): the model drafting a splice got only the generic session
 * prompt, with no hint that the output must be a complete, parseable
 * `<bpmn:definitions>` document, that ids must be additive and stable, or
 * that prose and markdown fences are not acceptable -- so the first attempt,
 * and every attempt after it, was a blind guess.
 */
const AGENT_ROLES: Record<string, string> = {
  graph_architect:
    "You are drafting a replacement for the session graph below. " +
    "Respond with ONLY a complete, valid <bpmn:definitions> XML document -- " +
    "no markdown code fences, no prose before or after, nothing but the XML. " +
    "Define exactly one <bpmn:process> in it. What you return REPLACES the " +
    "current graph outright, so it must be the current graph's own content " +
    "in full, verbatim, with your new elements woven in -- do not return only " +
    "the new or changed pieces, and do not reference an existing element (by " +
    "id, sourceRef, or targetRef) without also copying its own full " +
    "definition into your output. Everything currently in the graph keeps " +
    "its exact id and its <bpmn:definitions id>; give every new element a " +
    "brand-new id -- nothing existing may be renamed or removed. Auto-layout " +
    "adds visual positioning afterward, so omit the <bpmndi:BPMNDiagram> " +
    "section entirely; do not invent one.\n\n" +
    "The <bpmn:definitions> root must declare exactly these namespaces, " +
    "copied verbatim -- inventing a different BPMN namespace URI is the most " +
    "common way this fails:\n" +
    '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="..." targetNamespace="http://graph-agent/bpmn">',
};

/**
 * Strips a single wrapping markdown code fence, if there is one -- models
 * fence XML by default even when told not to, and neither bpmn-auto-layout
 * nor the BPMN parser tolerates the fence markers.
 */
function stripCodeFence(text: string): string {
  const match = /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(text.trim());
  return match ? (match[1] ?? "") : text;
}

/**
 * Roles whose prompt must also carry the session's current graph -- a
 * real-model run showed `graph_architect` cannot draft an *additive*
 * fragment (checkSplice's core requirement) without knowing which element
 * ids already exist to preserve; every attempt reused nothing and got
 * rejected as "removed or renamed" everything. Capped well under a typical
 * context window: the graph a splice targets is a single session graph, not
 * the whole shared library, so this is a safety margin against a pathological
 * one, not an expected truncation.
 */
const ROLES_NEEDING_CURRENT_GRAPH = new Set(["graph_architect"]);
const MAX_CURRENT_GRAPH_CHARS = 20_000;

function currentGraphBlock(xml: string): string {
  const truncated = xml.length > MAX_CURRENT_GRAPH_CHARS;
  const body = truncated ? xml.slice(0, MAX_CURRENT_GRAPH_CHARS) : xml;
  return (
    "The current graph you are splicing into is:\n\n" +
    "```xml\n" +
    body +
    (truncated ? "\n... (truncated)" : "") +
    "\n```"
  );
}

export interface HarnessDeps {
  pi: PiSession;
  tools: ToolExecutor;
  store: SessionStore;
  /** Current session graph; `graph:extend` replaces it. */
  getGraph: () => string;
  setGraph: (xml: string, reason: string, addedElementIds: string[]) => void;
  /** Steering and follow-up text the CLI has queued for this session. */
  takeSteering: () => string[];
  takeFollowUp: () => string[];
  /** Workspace `shell` steps run their command in. Defaults to `process.cwd()`. */
  cwd?: string;
}

/** Turn index, so each recorded turn is numbered in execution order. */
function nextTurnIndex(store: SessionStore): number {
  return store.readMeta().turns.length + 1;
}

export function createHarnesses(deps: HarnessDeps): HarnessRegistry {
  const { pi, tools, store } = deps;
  const cwd = deps.cwd ?? process.cwd();

  /** Tool calls of the turn in flight, so `agent:tool` can find them by index. */
  let currentToolCalls: ToolCallRequest[] = [];

  /**
   * `graph:lint`'s own redraft-attempt count, keyed by activity id -- kept here
   * rather than trusted from `context.variables.lint_attempts` alone. That
   * variable is meant to round-trip through zeebe:ioMapping (lint_fragment
   * publishes it, draft_fragment/lint_fragment read it back next time round),
   * but craft-graph runs as a nested, separately-recovered process behind a
   * callActivity, and issue #31 found a real run where the round-trip did not
   * happen: the count stayed at 1 forever and the redraft loop never reached
   * `lint_exhausted`, burning one model call per iteration with nothing to
   * stop it. This is the belt-and-braces bound its own suggested fix asked
   * for -- a count that survives regardless of what the variable graph does.
   */
  const lintAttempts = new Map<string, number>();

  const agentTurn: Harness = async (context) => {
    const prompt = context.input.prompt;
    const raw = typeof prompt === "string" && prompt.length > 0 ? prompt : undefined;
    if (raw === undefined && pi.messages.length === 0) {
      return failed(
        `${context.activityId} starts a turn with nothing to say: map a 'prompt' input, ` +
          `or place it after an activity that has already spoken.`,
      );
    }
    // Layered in front of the graph's own mapped prompt, never in place of it:
    // an agent_role header says what kind of work this turn is (draft_fragment's
    // is "graph_architect"), and lint_feedback -- when a graph maps it, as
    // craft-graph does -- is the previous redraft attempt's own rejection
    // reason, so a second guess is not as blind as the first.
    const agentRole = context.properties.agent_role ?? "";
    const role = AGENT_ROLES[agentRole];
    const graphBlock = ROLES_NEEDING_CURRENT_GRAPH.has(agentRole) ? currentGraphBlock(deps.getGraph()) : undefined;
    const feedback = typeof context.input.lint_feedback === "string" ? context.input.lint_feedback : undefined;
    const text =
      raw === undefined
        ? undefined
        : [role, graphBlock, raw, feedback && `The previous attempt was rejected: ${feedback}. Fix that and try again.`]
            .filter((part): part is string => Boolean(part))
            .join("\n\n");
    const outcome = await pi.beginTurn(text);
    currentToolCalls = outcome.toolCalls;

    const record: TurnRecord = {
      index: nextTurnIndex(store),
      activityId: context.activityId,
      ...(context.activityName === undefined ? {} : { activityName: context.activityName }),
      harness: context.harness,
      stopReason: outcome.stopReason,
      toolCalls: outcome.toolCalls.map((call) => call.name),
      ...(outcome.text ? { summary: outcome.text.slice(0, 400) } : {}),
      ...(outcome.errorMessage === undefined ? {} : { error: outcome.errorMessage }),
      usage: outcome.usage,
      endedAt: Date.now(),
    };
    store.update((meta) => {
      meta.turns.push(record);
    });

    const summary =
      outcome.stopReason === "error" && outcome.errorMessage
        ? `error: ${outcome.errorMessage}`
        : outcome.text.slice(0, 200) || `stopped: ${outcome.stopReason}`;

    return ok(summary, {
      stop_reason: outcome.stopReason,
      // FEEL sees a list, so `count(tool_calls)` and the loop over the batch work.
      tool_calls: outcome.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
      usage: outcome.usage,
      // `summary` above is truncated for the turn log; a graph that needs the
      // model's full response as data (craft-graph.bpmn's drafted fragment,
      // say) reads this instead.
      text: outcome.text,
    });
  };

  const agentTool: Harness = async (context) => {
    const raw = context.input.tool_call;
    const resolved = resolveToolCall(raw, currentToolCalls, new Set(pi.pendingToolCalls));
    if (!resolved.ok) return failed(resolved.reason);
    const call = resolved.call;

    const outcome = await tools.run(call.name, call.arguments, context.signal);
    pi.resolveTool(call.id, outcome);
    return ok(`${call.name}: ${outcome.isError ? "failed" : "ok"}`, {
      tool: call.name,
      terminate: outcome.terminate === true,
      isError: outcome.isError === true,
    });
  };

  /** Let Pi finish the turn once the graph has answered every tool call. */
  const finishTurn = async (summary: string): Promise<HarnessResult> => {
    const end = await pi.endTurn();
    currentToolCalls = [];
    return ok(summary, { batch_terminate: end.terminate, tool_results: end.toolResults });
  };

  return {
    "agent:turn": agentTurn,
    "agent:tool": agentTool,

    "agent:collect-tools": async () => finishTurn("tool results recorded"),

    // A response cut off by the output token limit has every tool call failed
    // without execution; Pi does that itself, so this only has to settle the run.
    "agent:fail-truncated-tools": async () => {
      currentToolCalls = [];
      return finishTurn("truncated response: tool calls failed unexecuted");
    },

    "agent:steer": async () => {
      const messages = deps.takeSteering();
      for (const text of messages) pi.steer(text);
      return ok(messages.length ? `queued ${messages.length} steering message(s)` : "nothing queued", {
        injected: messages.length,
      });
    },

    "agent:follow-up": async () => {
      const messages = deps.takeFollowUp();
      for (const text of messages) pi.followUp(text);
      return ok(messages.length ? `queued ${messages.length} follow-up(s)` : "no follow-up", {
        has_followup: messages.length > 0,
      });
    },

    /**
     * Pi's prepareNextTurn seam. Deliberately does *not* swap the system prompt
     * or the tool list: both sit in front of every message in the prompt cache,
     * so changing them here would discard the conversation's cache on every
     * iteration. See docs/research/05-pi-loops-and-token-cache.md.
     */
    "agent:prepare-next-turn": async (context) => {
      const stopReason = String(context.variables.stop_reason ?? "");
      const shouldStop = stopReason === "stop" || stopReason === "";
      return ok(shouldStop ? "agent has finished" : "another turn", { should_stop: shouldStop });
    },

    "graph:layout": async (context) => {
      const source = stripCodeFence(String(context.input.fragment ?? deps.getGraph()));
      try {
        return ok("laid out", { fragment: await layoutProcess(source) });
      } catch (error) {
        return failed(`auto-layout failed: ${message(error)}`);
      }
    },

    /**
     * Reports `attempt` so the crafting graph can bound its redraft loop: a
     * model that never produces a valid fragment would otherwise loop forever,
     * spending a turn each time round.
     */
    "graph:lint": async (context) => {
      const attempt = (lintAttempts.get(context.activityId) ?? 0) + 1;
      const exhausted = attempt >= MAX_LINT_ATTEMPTS;
      // A terminal result (accepted, or exhausted) starts the next, unrelated
      // craft invocation fresh rather than accumulating across it.
      const settle = (terminal: boolean): void => {
        if (terminal) lintAttempts.delete(context.activityId);
        else lintAttempts.set(context.activityId, attempt);
      };
      // gw_lint's own `lint_attempts >= 3` condition exists to catch this and
      // route to craft_rejected -- but issue #34 found bpmn-elements replay a
      // stale routing decision from an earlier pass through this same gateway
      // on a *resumed* run, silently ignoring a live "true" evaluation and
      // redrafting forever regardless of what the condition says. Throwing
      // here does not depend on that gateway at all: a harness rejection ends
      // the whole run (issue #30 made sure the engine actually stops on that
      // path), so the cap holds even when the graph's own routing cannot be
      // trusted to.
      const giveUp = (reason: string): never => {
        settle(true);
        const summary = `${context.activityId}: gave up after ${attempt} attempts -- ${reason}`;
        // bpmn-elements re-wraps a thrown error at every callActivity boundary
        // it crosses, and craft-graph always crosses at least one (the session
        // that spliced it in); by the time it reaches the CLI, the original
        // message is not reliably reachable off `error.message` -- it can end
        // up on a differently-shaped, arbitrarily-nested property instead.
        // meta.harnessError is a channel this project actually controls, so
        // `drive()`'s fallback (and `graph-agent show`) can report it
        // regardless of how deep that wrapping goes.
        store.update((meta) => {
          meta.harnessError = summary;
        });
        throw new Error(summary);
      };

      const fragment = stripCodeFence(String(context.input.fragment ?? ""));
      if (!fragment) {
        if (exhausted) giveUp("nothing to lint");
        settle(false);
        return failed("nothing to lint", { attempt });
      }
      try {
        const splice = await checkSplice(deps.getGraph(), fragment);
        if (splice.ok) {
          settle(true);
          return ok(`adds ${splice.added.length} element(s)`, { added: splice.added, attempt });
        }
        const reason = splice.reason ?? "the fragment is not an additive splice";
        if (exhausted) giveUp(reason);
        settle(false);
        return failed(reason, { attempt });
      } catch (error) {
        const reason = `the fragment is not valid BPMN: ${message(error)}`;
        if (exhausted) giveUp(reason);
        settle(false);
        return failed(reason, { attempt });
      }
    },

    /**
     * The self-mutation primitive: replace the session graph with a version that
     * has the fragment spliced in. Additive with stable ids only -- recovery
     * replays child state by element id.
     */
    "graph:extend": async (context) => {
      const fragment = String(context.input.fragment ?? "");
      if (!fragment) return failed("no fragment to apply");
      try {
        const splice = await checkSplice(deps.getGraph(), fragment);
        if (!splice.ok) return failed(splice.reason ?? "the fragment is not an additive splice");
        deps.setGraph(fragment, "graph:extend", splice.added);
        return ok(`spliced in ${splice.added.length} element(s)`, { added: splice.added });
      } catch (error) {
        return failed(`could not apply the fragment: ${message(error)}`);
      }
    },

    /**
     * A deterministic step: no model call, just a command and its exit status.
     * `element_templates/shell_task.json` binds the taskHeaders this reads.
     */
    "shell": async (context) => {
      const command = context.properties.command;
      if (!command) return failed("no 'command' header configured for this shell step");
      const failOnError = context.properties.fail_on_error !== "false";

      const { exit_code, stdout, stderr } = await runCommand(command, cwd, context.signal);
      const summary = `\`${command}\` exited ${exit_code}`;
      // `exit_code`, never `status`: HarnessResult already reserves `status` for
      // "success" | "failed", and zeebe:output reads this object by field name.
      const extra = { exit_code, stdout, stderr };
      if (exit_code !== 0 && failOnError) return failed(summary, extra);
      return ok(summary, extra);
    },
  };
}

/** Run a command line in a shell, rooted at `cwd`. Resolves rather than rejects on a non-zero exit. */
function runCommand(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, signal });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code, signalName) => {
      resolve({ exit_code: signalName ? -1 : (code ?? -1), stdout, stderr });
    });
  });
}

export type ResolvedToolCall = { ok: true; call: ToolCallRequest } | { ok: false; reason: string };

/**
 * A multi-instance batch hands each instance its own element (`content.tool_call`
 * for pi-default-loop's tool_batch). Accept the tool call itself or an index
 * into the turn's calls when one was mapped in.
 *
 * When nothing was mapped, falling back to `calls[0]` is only ever safe if
 * there is exactly one call still unanswered -- the ordinary single-call
 * case. With two or more outstanding, guessing runs the wrong call, runs one
 * twice, or leaves one never answered (issue #27), so that case fails loudly
 * instead: a graph with a real multi-instance batch that stops mapping
 * `tool_call` should be told, not silently misrouted.
 */
export function resolveToolCall(
  raw: unknown,
  calls: ToolCallRequest[],
  pending: ReadonlySet<string>,
): ResolvedToolCall {
  if (raw && typeof raw === "object") {
    const candidate = raw as Partial<ToolCallRequest>;
    if (typeof candidate.id === "string" && typeof candidate.name === "string") {
      return { ok: true, call: { id: candidate.id, name: candidate.name, arguments: candidate.arguments ?? {} } };
    }
  }
  if (typeof raw === "number" && Number.isInteger(raw)) {
    const call = calls[raw];
    return call ? { ok: true, call } : { ok: false, reason: `no tool call at index ${raw}` };
  }
  const unanswered = calls.filter((call) => pending.has(call.id));
  if (unanswered.length === 1) return { ok: true, call: unanswered[0]! };
  if (unanswered.length === 0) return { ok: false, reason: "the activity received no tool call to run" };
  return {
    ok: false,
    reason:
      `${unanswered.length} tool calls are still unanswered and none was mapped in -- ` +
      `map 'tool_call' (e.g. a multi-instance element variable) to say which one`,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
