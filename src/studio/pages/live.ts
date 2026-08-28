import { createBackoffScheduler } from "../../js/lib/websocket";
import type { StudioEvent } from "../types";

export interface SocketLike {
  addEventListener(type: "message", handler: (event: { data: string }) => void): void;
  addEventListener(type: "open" | "close", handler: () => void): void;
  close(): void;
}

export interface LiveOptions {
  /** Injected for tests; defaults to a real WebSocket against the current origin. */
  open?: (url: string) => SocketLike;
  schedule?: (fn: () => void, ms: number) => void;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Subscribe to studio events, reconnecting with the shared backoff scheduler.
 * Returns a stop function.
 */
export function connectStudioEvents(
  path: string,
  onEvent: (event: StudioEvent) => void,
  options: LiveOptions = {},
): () => void {
  const open =
    options.open ??
    ((url: string) => new WebSocket(url) as unknown as SocketLike);
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const backoff = createBackoffScheduler(options.initialDelayMs ?? 500, options.maxDelayMs ?? 10_000);

  let stopped = false;
  let socket: SocketLike | null = null;

  const connect = (): void => {
    if (stopped) return;
    const url =
      typeof location === "undefined"
        ? path
        : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${path}`;
    socket = open(url);
    socket.addEventListener("open", () => backoff.reset());
    socket.addEventListener("message", (event) => {
      try {
        onEvent(JSON.parse(event.data) as StudioEvent);
      } catch {
        // a malformed frame is not worth tearing the connection down for
      }
    });
    socket.addEventListener("close", () => {
      if (stopped) return;
      backoff.grow();
      schedule(connect, backoff.delay);
    });
  };

  connect();

  return () => {
    stopped = true;
    socket?.close();
  };
}
