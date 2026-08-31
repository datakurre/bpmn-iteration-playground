// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { PiSession } from "./pi-session.ts";

/** A scripted provider, so none of this needs a network or an API key. */
function scripted(responses: unknown[]) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
  faux.setResponses(responses as never);
  return faux;
}

function session(responses: unknown[], sessionId = "s1") {
  const faux = scripted(responses);
  const model = faux.getModel();
  return {
    faux,
    pi: new PiSession({
      model,
      systemPrompt: "You are a test agent.",
      // Permissive schemas: these tests exercise PiSession's own parking and
      // turn-orchestration behaviour, scripting arbitrary tool-call arguments
      // that are not meant to satisfy a real tool's schema.
      tools: [
        { name: "read", description: "Read a file.", parameters: { type: "object", additionalProperties: true } },
        { name: "bash", description: "Run a bash command.", parameters: { type: "object", additionalProperties: true } },
      ],
      streamFn: (m, context, options) => faux.provider.streamSimple(m, context, options),
      sessionId,
    }),
  };
}

describe("PiSession", () => {
  it("returns as soon as the assistant has spoken, before its tools run", async () => {
    const { pi } = session([
      fauxAssistantMessage([fauxText("Reading it."), fauxToolCall("read", { path: "a.ts" })]),
    ]);

    const turn = await pi.beginTurn("look at a.ts");

    expect(turn.text).toBe("Reading it.");
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]?.name).toBe("read");
    // the tool is parked, waiting for the graph -- Pi has not run it
    expect(pi.pendingToolCalls).toEqual([turn.toolCalls[0]?.id]);
  });

  it("writes the graph's tool result into Pi's own transcript", async () => {
    const { pi } = session([
      fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" })]),
    ]);

    const turn = await pi.beginTurn("look at a.ts");
    pi.resolveTool(turn.toolCalls[0]!.id, { content: "file contents here" });
    const end = await pi.endTurn();

    expect(end.toolResults).toBe(1);
    const results = pi.messages.filter((m) => (m as { role: string }).role === "toolResult");
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0])).toContain("file contents here");
  });

  it("terminates only when the whole batch asks to, as Pi does", async () => {
    const two = () => fauxAssistantMessage([fauxToolCall("read", { a: 1 }), fauxToolCall("bash", { b: 2 })]);

    const mixed = session([two()]).pi;
    let turn = await mixed.beginTurn("go");
    mixed.resolveTool(turn.toolCalls[0]!.id, { content: "ok", terminate: true });
    mixed.resolveTool(turn.toolCalls[1]!.id, { content: "ok" });
    expect((await mixed.endTurn()).terminate).toBe(false);

    const all = session([two()], "s2").pi;
    turn = await all.beginTurn("go");
    all.resolveTool(turn.toolCalls[0]!.id, { content: "ok", terminate: true });
    all.resolveTool(turn.toolCalls[1]!.id, { content: "ok", terminate: true });
    expect((await all.endTurn()).terminate).toBe(true);
  });

  it("fails a tool call the graph never answered rather than hanging", async () => {
    const { pi } = session([fauxAssistantMessage([fauxToolCall("read", {})])]);
    await pi.beginTurn("go");
    const end = await pi.endTurn();
    expect(end.toolResults).toBe(1);
    expect(JSON.stringify(pi.messages)).toContain("never executed by the graph");
  });

  it("continues the same transcript across graph-coordinated turns", async () => {
    const { pi } = session([
      fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" })]),
      fauxAssistantMessage([fauxText("Done.")]),
    ]);

    const first = await pi.beginTurn("look at a.ts");
    pi.resolveTool(first.toolCalls[0]!.id, { content: "contents" });
    await pi.endTurn();

    // No prompt: the graph decided to take another turn on the same transcript.
    const second = await pi.beginTurn();
    await pi.endTurn();

    expect(second.text).toBe("Done.");
    const roles = pi.messages.map((m) => (m as { role: string }).role);
    expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });

  it("keeps the prompt cache warm across turns, which is the whole point", async () => {
    // The faux provider models prompt caching the way a real one does: it keys
    // on sessionId and credits the shared prefix. A second turn on the same
    // transcript must therefore read from cache rather than pay full price.
    const { pi } = session([
      fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" })]),
      fauxAssistantMessage([fauxText("Done.")]),
    ]);

    const first = await pi.beginTurn("look at a.ts and tell me what it does");
    pi.resolveTool(first.toolCalls[0]!.id, { content: "export const answer = 42;" });
    await pi.endTurn();

    const second = await pi.beginTurn();
    await pi.endTurn();

    expect(first.usage.cacheRead).toBe(0);
    expect(second.usage.cacheRead).toBeGreaterThan(0);
  });

  it("refuses to start a turn while one is in flight", async () => {
    const { pi } = session([fauxAssistantMessage([fauxToolCall("read", {})])]);
    await pi.beginTurn("go");
    await expect(pi.beginTurn("again")).rejects.toThrow(/already in flight/);
  });

  it("extracts cost, reasoning, and totalTokens from message usage", async () => {
    const customMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello with usage" }],
      stopReason: "stop",
      usage: {
        input: 100,
        output: 50,
        cacheRead: 200,
        cacheWrite: 30,
        reasoning: 25,
        totalTokens: 350,
        cost: {
          input: 0.0001,
          output: 0.0002,
          cacheRead: 0.00005,
          cacheWrite: 0.00003,
          total: 0.00038,
        },
      },
    };

    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
    const pi = new PiSession({
      model: faux.getModel(),
      systemPrompt: "You are a test agent.",
      tools: [],
      streamFn: () => {
        async function* gen() {
          yield {
            type: "start",
            partial: { role: "assistant", content: [], stopReason: "pending" },
          } as never;
          yield {
            type: "text_start",
            contentIndex: 0,
            partial: { role: "assistant", content: [{ type: "text", text: "Hello with usage" }] },
          } as never;
          yield {
            type: "text_end",
            contentIndex: 0,
            content: "Hello with usage",
            partial: { role: "assistant", content: [{ type: "text", text: "Hello with usage" }] },
          } as never;
          yield {
            type: "done",
            reason: "stop",
            message: customMessage,
          } as never;
        }
        return Object.assign(gen(), {
          result: async () => customMessage,
        }) as never;
      },
    });

    const outcome = await pi.beginTurn("test usage");
    await pi.endTurn();

    expect(outcome.usage.input).toBe(100);
    expect(outcome.usage.output).toBe(50);
    expect(outcome.usage.cacheRead).toBe(200);
    expect(outcome.usage.cacheWrite).toBe(30);
    expect(outcome.usage.reasoning).toBe(25);
    expect(outcome.usage.totalTokens).toBe(350);
    expect(outcome.usage.cost?.total).toBe(0.00038);
    expect(outcome.usage.cost?.input).toBe(0.0001);
  });
});
