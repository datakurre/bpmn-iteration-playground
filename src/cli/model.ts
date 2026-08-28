/**
 * Choosing the model a session runs on.
 *
 * Pi's ModelRuntime owns provider configuration and credentials, so this is a
 * thin resolver over it rather than a second place to configure models: if `pi`
 * can talk to a provider, so can we.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { Agent } from "@earendil-works/pi-agent-core";

export interface ResolvedModel {
  model: Model<any>;
  streamFn: ConstructorParameters<typeof Agent>[0]["streamFn"];
  label: string;
}

/**
 * A scripted provider that answers once and stops. Lets `run --dry-run` walk a
 * graph end to end with no credentials and no network, which is the fastest way
 * to see whether a graph does what its author meant.
 */
export function dryRunModel(turns = 1): ResolvedModel {
  const faux = fauxProvider({ provider: "dry-run", models: [{ id: "dry-run", name: "Dry run" }] });
  faux.setResponses(
    Array.from({ length: turns }, () =>
      fauxAssistantMessage([fauxText("[dry run] no model was called.")], { stopReason: "stop" }),
    ) as never,
  );
  return {
    model: faux.getModel(),
    streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
    label: "dry-run (no model called)",
  };
}

/**
 * `spec` is `provider/model`, or just a provider, or omitted for the first model
 * that has credentials.
 */
export async function resolveModel(spec?: string): Promise<ResolvedModel> {
  const runtime = await ModelRuntime.create();
  const available = runtime.getModels();

  if (available.length === 0) {
    throw new Error(
      "no model is configured. Authenticate with Pi first (`pi`, then /login), or use --dry-run to walk a graph without calling a model.",
    );
  }

  let model: Model<any> | undefined;
  if (spec) {
    const slash = spec.indexOf("/");
    model =
      slash === -1
        ? available.find((m) => m.provider === spec || m.id === spec)
        : runtime.getModel(spec.slice(0, slash), spec.slice(slash + 1));
    if (!model) {
      throw new Error(
        `no model matches '${spec}'. Available: ${available.map((m) => `${m.provider}/${m.id}`).join(", ")}`,
      );
    }
  } else {
    model = available[0];
  }
  if (!model) throw new Error("no model could be resolved");

  const chosen = model;
  return {
    model: chosen,
    streamFn: (m, context, options) => runtime.streamSimple(m, context, options as never),
    label: `${chosen.provider}/${chosen.id}`,
  };
}
