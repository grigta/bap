import type { BrowserProvider, BrowserSession } from "@bap/browser-adapters";
import type { RemoteAgentMessage, RemoteInput } from "@bap/protocol";
import type { CDPSession, Page } from "playwright-core";

type Outgoing = Omit<RemoteAgentMessage, "v" | "id" | "ts">;

export interface RemoteDeps {
  provider: BrowserProvider | null;
  /** Sends to the server; `sent` runs once the bytes left, so frames never pile up behind a slow link. */
  send: (msg: Outgoing, sent?: () => void) => void;
  /** Profiles a run is using right now: the operator cannot take them over. */
  busyProfiles: () => Set<string>;
  log: (line: string) => void;
}

interface Remote {
  profileExternalId: string;
  session: BrowserSession | null;
  page: Page | null;
  cdp: CDPSession | null;
  /** Inputs apply one at a time, in the order the operator made them. */
  queue: Promise<void>;
  closed: boolean;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!;

/**
 * The operator works in a profile's browser from the panel (REQ-AGENT-005): the page is streamed with
 * CDP screencast and the operator's input is replayed with Playwright. Everything goes over the agent's
 * own connection to the server, so the Mac listens on no port.
 */
export function remoteBrowser(deps: RemoteDeps) {
  const sessions = new Map<string, Remote>();
  const send = (msg: Outgoing, sent?: () => void) => deps.send(msg, sent);

  const watch = async (sessionId: string, r: Remote, page: Page) => {
    await r.cdp?.send("Page.stopScreencast").catch(() => {});
    await r.cdp?.detach().catch(() => {});
    r.page = page;
    const cdp = await page.context().newCDPSession(page);
    r.cdp = cdp;
    cdp.on("Page.screencastFrame", ({ data, metadata, sessionId: frame }) => {
      if (r.closed || r.cdp !== cdp) return;
      // Acknowledged once sent: Chrome then produces the next frame, which keeps the stream at link speed.
      send({ type: "remote.frame", payload: { sessionId, data, width: metadata.deviceWidth, height: metadata.deviceHeight } }, () =>
        void cdp.send("Page.screencastFrameAck", { sessionId: frame }).catch(() => {}),
      );
    });
    const report = () => void page.title().then((title) => !r.closed && r.page === page && send({ type: "remote.page", payload: { sessionId, url: page.url(), title } }), () => {});
    page.on("framenavigated", (f) => f === page.mainFrame() && report());
    page.on("load", report);
    page.on("close", () => {
      if (r.closed || r.page !== page) return;
      const next = page.context().pages().filter((p) => !p.isClosed()).at(-1);
      if (next) void watch(sessionId, r, next);
      else void close(sessionId, "вкладка закрыта");
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800 });
    report();
  };

  const open = async (sessionId: string, profileExternalId: string, startUrl: string | null) => {
    if (sessions.has(sessionId)) return;
    const fail = (code: string, text: string) => send({ type: "remote.failed", payload: { sessionId, code, message: text } });
    if (!deps.provider) return fail("PROVIDER_UNAVAILABLE", "this agent has no browser provider");
    if (deps.busyProfiles().has(profileExternalId) || [...sessions.values()].some((s) => s.profileExternalId === profileExternalId))
      return fail("PROFILE_BUSY", "the profile is in use on this Mac");
    const r: Remote = { profileExternalId, session: null, page: null, cdp: null, queue: Promise.resolve(), closed: false };
    sessions.set(sessionId, r);
    try {
      r.session = await deps.provider.openSession(profileExternalId, `remote-${sessionId}`);
      await r.session.attach();
      const page = await r.session.getPage();
      // A popup the operator opens becomes the tab on screen.
      page.context().on("page", (p) => void (!r.closed && watch(sessionId, r, p)));
      // The site may be the reason for the failure: the operator still sees whatever it shows.
      if (startUrl) await page.goto(startUrl, { waitUntil: "commit" }).catch(() => {});
      if (r.closed) return;
      await watch(sessionId, r, page);
      send({ type: "remote.opened", payload: { sessionId } });
      deps.log(`remote session ${sessionId} on profile ${profileExternalId} opened`);
    } catch (e) {
      sessions.delete(sessionId);
      await r.session?.closeSession().catch(() => {});
      fail("REMOTE_OPEN_FAILED", message(e));
    }
  };

  const apply = async (page: Page, input: RemoteInput) => {
    switch (input.kind) {
      case "click":
        return page.mouse.click(input.x, input.y, { button: input.button, clickCount: input.clickCount });
      case "move":
        return page.mouse.move(input.x, input.y);
      case "wheel":
        await page.mouse.move(input.x, input.y);
        return page.mouse.wheel(input.deltaX, input.deltaY);
      case "key":
        return page.keyboard.press([...input.modifiers, input.key].join("+"));
      case "text":
        return page.keyboard.insertText(input.text);
      // Navigation returns once it started: the frames show the rest, and input is not held up by a slow site.
      case "goto":
        return void (await page.goto(input.url, { waitUntil: "commit" }));
      case "back":
        return void (await page.goBack({ waitUntil: "commit" }));
      case "forward":
        return void (await page.goForward({ waitUntil: "commit" }));
      case "reload":
        return void (await page.reload({ waitUntil: "commit" }));
    }
  };

  const input = (sessionId: string, i: RemoteInput) => {
    const r = sessions.get(sessionId);
    if (!r || r.closed) return;
    r.queue = r.queue.then(() => (r.page && !r.page.isClosed() ? apply(r.page, i) : undefined)).catch((e) => deps.log(`remote ${sessionId}: ${i.kind} failed: ${message(e)}`));
  };

  const close = async (sessionId: string, reason: string) => {
    const r = sessions.get(sessionId);
    if (!r || r.closed) return;
    r.closed = true;
    sessions.delete(sessionId);
    await r.cdp?.send("Page.stopScreencast").catch(() => {});
    await r.session?.closeSession().catch((e) => deps.log(`remote ${sessionId}: closing the browser failed: ${message(e)}`));
    send({ type: "remote.closed", payload: { sessionId, reason } });
    deps.log(`remote session ${sessionId} closed: ${reason}`);
  };

  return {
    open,
    input,
    close,
    /** Profiles the operator has open: runs must not start on them. */
    profiles: () => new Set([...sessions.values()].map((s) => s.profileExternalId)),
    closeAll: (reason: string) => Promise.all([...sessions.keys()].map((id) => close(id, reason))),
  };
}
