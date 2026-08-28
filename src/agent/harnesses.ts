/**
 * The job types a graph can dispatch to.
 *
 * Each `zeebe:taskDefinition type="..."` in a diagram names one of these. They
 * are deliberately thin: the decisions live in the graph, and the state lives in
 * the Pi session, so a harness is mostly a translation between the two.
 */
import { layoutProcess } from "bpmn-auto-layout";
import { checkSplice } from "./graph.ts";
import { failed, ok, type Harness, type HarnessRegistry, type HarnessResult } from "./harness.ts";
import type { PiSession, ToolCallRequest } from "./pi-session.ts";
import type { ToolExecutor } from "./tool-executor.ts";
import type { SessionStore } from "./session-store.ts";
import type { TurnRecord } from "../studio/types.ts";

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
}

/** Turn index, so each recorded turn is numbered in execution order. */
function nextTurnIndex(store: SessionStore): number {
  return store.readMeta().turns.length + 1;
}

export function createHarnesses(deps: HarnessDeps): HarnessRegistry {
  const { pi, tools, store } = deps;

  /** Tool calls of the turn in flight, so `agent:tool` can find them by index. */
  let currentToolCalls: ToolCallRequest[] = [];

  const agentTurn: Harness = async (context) => {
    const prompt = context.input.prompt;
    const text = typeof prompt === "string" && prompt.length > 0 ? prompt : undefined;
    if (text === undefined && pi.messages.length === 0) {
      return failed(
        `${context.activityId} starts a turn with nothing to say: map a 'prompt' input, ` +
          `or place it after an activity that has already spoken.`,
      );
    }
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

    return ok(outcome.text.slice(0, 200) || `stopped: ${outcome.stopReason}`, {
      stop_reason: outcome.stopReason,
      // FEEL sees a list, so `count(tool_calls)` and the loop over the batch work.
      tool_calls: outcome.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
      usage: outcome.usage,
    });
  };

  const agentTool: Harness = async (context) => {
    const raw = context.input.tool_call;
    const call = resolveToolCall(raw, currentToolCalls);
    if (!call) return failed("the activity received no tool call to run");

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
      const source = String(context.input.fragment ?? deps.getGraph());
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
      const attempt = Number(context.variables.lint_attempts ?? 0) + 1;
      const fragment = String(context.input.fragment ?? "");
      if (!fragment) return failed("nothing to lint", { attempt });
      try {
        const splice = await checkSplice(deps.getGraph(), fragment);
        return splice.ok
          ? ok(`adds ${splice.added.length} element(s)`, { added: splice.added, attempt })
          : failed(splice.reason ?? "the fragment is not an additive splice", { attempt });
      } catch (error) {
        return failed(`the fragment is not valid BPMN: ${message(error)}`, { attempt });
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
  };
}

/**
 * A multi-instance batch hands each instance its own element. Accept the tool
 * call itself, or an index into the turn's calls, or fall back to the first
 * unanswered one.
 */
export function resolveToolCall(raw: unknown, calls: ToolCallRequest[]): ToolCallRequest | undefined {
  if (raw && typeof raw === "object") {
    const candidate = raw as Partial<ToolCallRequest>;
    if (typeof candidate.id === "string" && typeof candidate.name === "string") {
      return { id: candidate.id, name: candidate.name, arguments: candidate.arguments ?? {} };
    }
  }
  if (typeof raw === "number" && Number.isInteger(raw)) return calls[raw];
  return calls[0];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
