/**
 * Choosing the model a session runs on.
 *
 * Pi's ModelRuntime owns provider configuration and credentials, so this is a
 * thin resolver over it rather than a second place to configure models: if `pi`
 * can talk to a provider, so can we.
 */
import { existsSync, readFileSync } from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
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
 * Reads `[agent] model` out of `config.toml`. Deliberately not a general TOML
 * parser -- the file has exactly one setting worth reading -- so a stray `#`
 * inside a quoted value or a `[agent.sub]` table is not handled; both are
 * outside what `init` ever writes.
 */
export function readConfiguredModel(configFile: string): string | undefined {
  if (!existsSync(configFile)) return undefined;
  const text = readFileSync(configFile, "utf8");

  let inAgentSection = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      inAgentSection = section[1]?.trim() === "agent";
      continue;
    }
    if (!inAgentSection) continue;

    const setting = /^model\s*=\s*(.+)$/.exec(line);
    if (setting) return setting[1]?.trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

/** Caps a long list for an error message: `n` items, then a "…and N more" tail. */
function capList(items: readonly string[], max = 20): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")}, …and ${items.length - max} more`;
}

/** Describes what `spec` could have meant, without dumping the whole catalogue. */
function describeAvailable(available: readonly Model<Api>[], spec: string): string {
  const providers = [...new Set(available.map((m) => m.provider))];
  const slash = spec.indexOf("/");
  if (slash === -1) {
    return `available providers: ${capList(providers)}. Pass 'provider/model', e.g. '${providers[0]}/${available[0]?.id}'.`;
  }

  const provider = spec.slice(0, slash);
  const inProvider = available.filter((m) => m.provider === provider);
  if (inProvider.length === 0) {
    return `no provider '${provider}' has credentials configured. Available providers: ${capList(providers)}.`;
  }
  return `available in '${provider}': ${capList(inProvider.map((m) => `${m.provider}/${m.id}`))}.`;
}

/** Descriptions and attribution headers for known providers. */
function matchesHost(baseUrl: string | undefined, expectedHost: string): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === expectedHost;
  } catch {
    return baseUrl.includes(expectedHost);
  }
}

export function isOpenCodeModel(model: { provider: string; baseUrl?: string }): boolean {
  return (
    model.provider === "opencode" ||
    model.provider === "opencode-go" ||
    matchesHost(model.baseUrl, "opencode.ai")
  );
}

export function isOpenRouterModel(model: { provider: string; baseUrl?: string }): boolean {
  return model.provider === "openrouter" || (model.baseUrl !== undefined && model.baseUrl.includes("openrouter.ai"));
}

export function isNvidiaNimModel(model: { provider: string; baseUrl?: string }): boolean {
  return model.provider === "nvidia" || matchesHost(model.baseUrl, "integrate.api.nvidia.com");
}

export function isCloudflareModel(model: { provider: string; baseUrl?: string }): boolean {
  return (
    model.provider === "cloudflare-workers-ai" ||
    model.provider === "cloudflare-ai-gateway" ||
    matchesHost(model.baseUrl, "api.cloudflare.com") ||
    matchesHost(model.baseUrl, "gateway.ai.cloudflare.com")
  );
}

export function getProviderAttributionHeaders(
  model: { provider: string; baseUrl?: string },
  sessionId?: string,
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};

  if (sessionId && isOpenCodeModel(model)) {
    headers["x-opencode-session"] = sessionId;
    headers["x-opencode-client"] = "graph-agent";
  }

  if (isOpenRouterModel(model)) {
    headers["HTTP-Referer"] = "https://github.com/datakurre/graph-agent";
    headers["X-OpenRouter-Title"] = "graph-agent";
    headers["X-OpenRouter-Categories"] = "cli-agent";
  } else if (isNvidiaNimModel(model)) {
    headers["X-BILLING-INVOKE-ORIGIN"] = "graph-agent";
  } else if (isCloudflareModel(model)) {
    headers["User-Agent"] = "graph-agent";
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * `spec` is `provider/model`, or just a provider, or omitted to fall back to
 * `configuredModel` (typically `[agent] model` from config.toml), or omitted
 * entirely for the first model that has credentials.
 */
export async function resolveModel(spec?: string, configuredModel?: string): Promise<ResolvedModel> {
  const runtime = await ModelRuntime.create();
  // Credential-filtered, unlike getModels(): that returns every model of every
  // provider Pi knows about, whether or not this machine can actually call it.
  const available = await runtime.getAvailable();

  if (available.length === 0) {
    throw new Error(
      "no model is configured. Authenticate with Pi first (`pi`, then /login), or use --dry-run to walk a graph without calling a model.",
    );
  }

  const effectiveSpec = spec ?? configuredModel;

  let model: Model<Api> | undefined;
  if (effectiveSpec) {
    const slash = effectiveSpec.indexOf("/");
    model =
      slash === -1
        ? available.find((m) => m.provider === effectiveSpec || m.id === effectiveSpec)
        : available.find((m) => m.provider === effectiveSpec.slice(0, slash) && m.id === effectiveSpec.slice(slash + 1));
    if (!model) {
      throw new Error(`no model matches '${effectiveSpec}'. ${describeAvailable(available, effectiveSpec)}`);
    }
  } else {
    model = available[0];
  }
  if (!model) throw new Error("no model could be resolved");

  const chosen = model;
  return {
    model: chosen,
    streamFn: (m, context, options) =>
      runtime.streamSimple(m, context, {
        ...options,
        transformHeaders: async (requestHeaders: ProviderHeaders) => {
          const attribution = getProviderAttributionHeaders(m, options?.sessionId);
          const customTransform = (
            options as
              | { transformHeaders?: (headers: ProviderHeaders) => Promise<ProviderHeaders> | ProviderHeaders }
              | undefined
          )?.transformHeaders;
          const transformed = customTransform ? await customTransform(requestHeaders) : requestHeaders;
          return {
            ...(attribution ?? {}),
            ...(transformed ?? {}),
          };
        },
      } as never),
    label: `${chosen.provider}/${chosen.id}`,
  };
}
