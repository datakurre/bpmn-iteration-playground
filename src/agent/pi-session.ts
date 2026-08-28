/**
 * One Pi agent, for the whole session.
 *
 * The BPMN engine decides *when* a turn happens; Pi owns the transcript it
 * happens in. That split is not an aesthetic choice -- Pi's prompt cache covers
 * the prefix `system prompt -> tools -> messages`, so a transcript that only ever
 * grows keeps every earlier turn cached, while building a fresh agent per graph
 * activity would pay full price on every step. See
 * docs/research/05-pi-loops-and-token-cache.md.
 *
 * The awkward part is tool execution. The graph wants to run the tools, but Pi
 * wants to run them itself and record the results in its own transcript. Rather
 * than fight that, every tool is registered as a *parked* tool: Pi calls it, the
 * call suspends, the graph runs the real work and hands the result back, and Pi
 * finalises it into the transcript exactly as it would have anyway. The
 * transcript stays byte-identical to a normal Pi run, which is precisely what
 * the cache needs.
 */
import { Agent, type AgentMessage, type AgentTool, type AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { TurnUsage } from "../studio/types.ts";

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface TurnOutcome {
  /** Why the assistant stopped: `stop`, `toolUse`, `length`, `error`, `aborted`. */
  stopReason: string;
  /** Tool calls the assistant asked for, in the order it asked. */
  toolCalls: ToolCallRequest[];
  usage: TurnUsage;
  /** Assistant text, for the session log. */
  text: string;
  errorMessage?: string;
}

/** What the graph hands back for one tool call. */
export interface ToolOutcome {
  content: string;
  isError?: boolean;
  /**
   * Ask the agent to stop after this batch. Pi only honours it when *every*
   * result in the batch sets it.
   */
  terminate?: boolean;
}

export interface PiSessionOptions {
  model: Model<any>;
  systemPrompt: string;
  /** Tool names the model may call. Kept stable for the session: see the note above. */
  toolNames: string[];
  /** Injected so tests can drive a scripted provider. */
  streamFn: ConstructorParameters<typeof Agent>[0]["streamFn"];
  sessionId?: string;
}

interface Parked {
  resolve: (outcome: ToolOutcome) => void;
}

/**
 * stopReasons after which Pi never calls the tools, so nothing will park:
 * a truncated response has its whole batch failed without execution, and an
 * errored or aborted turn ends immediately.
 */
const NO_TOOLS_RUN = new Set(["length", "error", "aborted"]);

const EMPTY_USAGE: TurnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export class PiSession {
  readonly agent: Agent;
  private run: Promise<void> | null = null;
  private runError: unknown = null;
  private readonly parked = new Map<string, Parked>();
  private lastBatch: ToolOutcome[] = [];
  /** Wakes beginTurn once every tool call of the current turn has parked. */
  private onParked: (() => void) | null = null;

  constructor(options: PiSessionOptions) {
    this.agent = new Agent({
      streamFn: options.streamFn,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      // The graph owns iteration: every run is exactly one turn, and the graph
      // decides whether there is another.
      shouldStopAfterTurn: () => true,
      initialState: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        tools: options.toolNames.map((name) => this.parkingTool(name)),
        messages: [],
      },
    });
  }

  /**
   * A tool that does nothing except wait for the graph. Pi sees an ordinary
   * tool; the work happens in an `agent:tool` activity.
   */
  private parkingTool(name: string): AgentTool<any> {
    return {
      name,
      label: name,
      description: `Deferred to the process graph.`,
      parameters: { type: "object", additionalProperties: true } as never,
      execute: async (toolCallId: string): Promise<AgentToolResult<unknown>> => {
        const outcome = await new Promise<ToolOutcome>((resolve) => {
          this.parked.set(toolCallId, { resolve });
          this.onParked?.();
        });
        this.lastBatch.push(outcome);
        return {
          content: [{ type: "text", text: outcome.content }],
          details: {},
          ...(outcome.terminate === true ? { terminate: true } : {}),
        };
      },
    } as unknown as AgentTool<any>;
  }

  get messages(): AgentMessage[] {
    return this.agent.state.messages;
  }

  /** Tool calls still waiting for the graph to answer them. */
  get pendingToolCalls(): string[] {
    return [...this.parked.keys()];
  }

  /**
   * Start a turn and return as soon as the assistant has finished speaking --
   * before its tool calls run, because running them is the graph's job.
   */
  async beginTurn(prompt?: string): Promise<TurnOutcome> {
    if (this.run) throw new Error("a turn is already in flight");
    this.lastBatch = [];
    this.runError = null;

    const settled = new Promise<AssistantMessage>((resolve) => {
      const unsubscribe = this.agent.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          unsubscribe();
          resolve(event.message as AssistantMessage);
        }
      });
    });

    // Deliberately not awaited: the run stays suspended inside the parked tools
    // until the graph answers them, and endTurn() collects it.
    this.run = (
      prompt === undefined
        ? this.agent.continue()
        : this.agent.prompt([{ role: "user", content: prompt, timestamp: Date.now() } as AgentMessage])
    ).catch((error: unknown) => {
      this.runError = error;
    });

    const message = await settled;
    const stopReason = String(message.stopReason ?? "stop");
    const toolCalls = message.content
      .filter((block): block is Extract<typeof block, { type: "toolCall" }> => block.type === "toolCall")
      .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments ?? {} }));

    // message_end fires before Pi calls the tools, so the parked map is still
    // empty here. Wait for the calls to actually arrive, or the graph would try
    // to answer tool calls that are not yet waiting.
    if (toolCalls.length > 0 && !NO_TOOLS_RUN.has(stopReason)) {
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (toolCalls.every((call) => this.parked.has(call.id))) {
            this.onParked = null;
            resolve();
          }
        };
        this.onParked = check;
        check();
      });
    }

    return {
      stopReason,
      toolCalls,
      usage: readUsage(message),
      text: message.content
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join(""),
      ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
    };
  }

  /** Answer one parked tool call. */
  resolveTool(toolCallId: string, outcome: ToolOutcome): void {
    const parked = this.parked.get(toolCallId);
    if (!parked) throw new Error(`no tool call is waiting with id '${toolCallId}'`);
    this.parked.delete(toolCallId);
    parked.resolve(outcome);
  }

  /**
   * Let Pi finish the turn: it writes the tool results into the transcript and
   * settles the run. Returns whether the whole batch asked to terminate, which
   * is Pi's rule -- all of them, not any of them.
   */
  async endTurn(): Promise<{ terminate: boolean; toolResults: number }> {
    if (!this.run) return { terminate: false, toolResults: 0 };
    // A tool the graph never answered would hang the run; fail it instead.
    this.onParked = null;
    for (const [id, parked] of this.parked) {
      this.parked.delete(id);
      parked.resolve({ content: `Tool call ${id} was never executed by the graph.`, isError: true });
    }
    await this.run;
    this.run = null;
    if (this.runError) throw this.runError instanceof Error ? this.runError : new Error(String(this.runError));

    const batch = this.lastBatch;
    return {
      terminate: batch.length > 0 && batch.every((outcome) => outcome.terminate === true),
      toolResults: batch.length,
    };
  }

  /** Queue a message for the next turn boundary. */
  steer(text: string): void {
    this.agent.steer({ role: "user", content: text, timestamp: Date.now() } as AgentMessage);
  }

  followUp(text: string): void {
    this.agent.followUp({ role: "user", content: text, timestamp: Date.now() } as AgentMessage);
  }

  abort(): void {
    this.agent.abort();
  }
}

function readUsage(message: AssistantMessage): TurnUsage {
  const usage = (message as { usage?: Partial<TurnUsage> }).usage;
  if (!usage) return { ...EMPTY_USAGE };
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
  };
}
