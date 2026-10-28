import { type Server, type Socket, connect, createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

/** TCP proxy to a local port that can drop every connection, refuse new ones or lose answers (network loss, database outage). */
export function outageProxy(targetPort: number) {
  const sockets = new Set<Socket>();
  let down = false;
  let muted: "all" | "websocket" | null = null;
  const server: Server = createServer((client) => {
    if (down) return void client.destroy();
    const upstream = connect(targetPort, "127.0.0.1");
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("error", () => {});
    }
    let websocket = false;
    client.once("data", (first: Buffer) => (websocket = /^upgrade:\s*websocket/im.test(first.toString("latin1"))));
    client.pipe(upstream);
    upstream.on("data", (chunk) => (muted === "all" || (muted === "websocket" && websocket) ? undefined : client.write(chunk)));
    // A killed peer must close both halves, as a real TCP connection would.
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  const proxy = {
    server,
    listen: (port = 0) => new Promise<number>((r) => server.listen(port, "127.0.0.1", () => r((server.address() as { port: number }).port))),
    /** Drops all connections and refuses new ones until `up()`. */
    down() {
      down = true;
      for (const s of sockets) s.destroy();
    },
    up() {
      down = false;
      muted = null;
    },
    /** Requests still arrive but answers are lost (e.g. acknowledgements), until the next `up()`; optionally only on WebSocket connections. */
    muteReplies(only: "all" | "websocket" = "all") {
      muted = only;
    },
    async outage(ms: number) {
      proxy.down();
      await sleep(ms);
      proxy.up();
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  return proxy;
}
