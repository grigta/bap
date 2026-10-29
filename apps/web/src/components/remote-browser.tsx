import { ArrowLeft, ArrowRight, Power, RotateCw } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type MouseEvent, type WheelEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

type RemoteInput =
  | { kind: "click"; x: number; y: number; button: "left" | "right" | "middle"; clickCount: number }
  | { kind: "move"; x: number; y: number }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "key"; key: string; modifiers: ("Alt" | "Control" | "Meta" | "Shift")[] }
  | { kind: "text"; text: string }
  | { kind: "goto"; url: string }
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "reload" };

type State = { phase: "starting" } | { phase: "live" } | { phase: "closed"; reason: string };

/** Mouse moves are sent at most this often: enough for hover menus, light on the link. */
const MOVE_EVERY_MS = 33;
const BUTTONS = ["left", "middle", "right"] as const;

/**
 * The profile's browser on the Mac, live (REQ-UI-011): the agent streams the page, the operator's
 * clicks, keys and scrolling go back to it. Coordinates are mapped from the picture to the page.
 */
export function RemoteBrowser({ sessionId, title, description, onClose }: { sessionId: string; title: string; description: string; onClose: (closedByOperator: boolean) => void }) {
  const socket = useRef<WebSocket | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const size = useRef({ width: 0, height: 0 });
  const lastMove = useRef(0);
  const [frame, setFrame] = useState<string | null>(null);
  const [state, setState] = useState<State>({ phase: "starting" });
  const [page, setPage] = useState({ url: "", title: "" });
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/v1/remote/${sessionId}/ws`);
    socket.current = ws;
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { type: string; data?: string; width?: number; height?: number; url?: string; title?: string; reason?: string };
      if (m.type === "opened") setState({ phase: "live" });
      else if (m.type === "frame") {
        if (m.width && m.height) size.current = { width: m.width, height: m.height };
        setFrame(`data:image/jpeg;base64,${m.data}`);
        setState((s) => (s.phase === "starting" ? { phase: "live" } : s));
      } else if (m.type === "page") setPage({ url: m.url ?? "", title: m.title ?? "" });
      else if (m.type === "closed") setState({ phase: "closed", reason: m.reason ?? "" });
    };
    ws.onclose = () => setState((s) => (s.phase === "closed" ? s : { phase: "closed", reason: "соединение с сервером прервано" }));
    return () => ws.close();
  }, [sessionId]);
  useEffect(() => void (!editing && setAddress(page.url)), [page.url, editing]);

  const send = (input: RemoteInput) => socket.current?.readyState === WebSocket.OPEN && socket.current.send(JSON.stringify({ type: "input", input }));
  /** The point on the page under the pointer: the picture may be scaled to fit the window. */
  const at = (e: { clientX: number; clientY: number }) => {
    const r = image.current!.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) / r.width) * size.current.width), y: Math.round(((e.clientY - r.top) / r.height) * size.current.height) };
  };
  const live = state.phase === "live";

  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    image.current?.parentElement?.focus();
    send({ kind: "click", ...at(e), button: BUTTONS[e.button] ?? "left", clickCount: e.detail > 1 ? Math.min(e.detail, 3) : 1 });
  };
  const onMove = (e: MouseEvent) => {
    if (Date.now() - lastMove.current < MOVE_EVERY_MS) return;
    lastMove.current = Date.now();
    send({ kind: "move", ...at(e) });
  };
  const onWheel = (e: WheelEvent) => send({ kind: "wheel", ...at(e), deltaX: e.deltaX, deltaY: e.deltaY });
  const onKey = (e: KeyboardEvent) => {
    const modifiers = (["Alt", "Control", "Meta", "Shift"] as const).filter((m) => e.getModifierState(m));
    // Paste is the operator's own clipboard: its text goes over as typed text.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") return;
    e.preventDefault();
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) send({ kind: "text", text: e.key });
    else if (!["Alt", "Control", "Meta", "Shift"].includes(e.key)) send({ kind: "key", key: e.key, modifiers: modifiers.filter((m) => m !== "Shift" || e.key.length > 1) });
  };
  const go = (e: FormEvent) => {
    e.preventDefault();
    const url = /^https?:\/\//.test(address) ? address : `https://${address}`;
    send({ kind: "goto", url });
    setEditing(false);
  };
  /** Leaving the window ends the session too: the profile must not stay held by a browser nobody watches. */
  const close = async (byButton: boolean) => {
    await fetch(`/api/v1/remote/${sessionId}/close`, { method: "POST" }).catch(() => {});
    onClose(byButton);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && void close(false)}>
      <DialogContent className="flex h-[95vh] max-w-[95vw] flex-col gap-3 sm:max-w-[95vw]" data-testid="remote-browser">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-1.5">
          <Button size="icon-sm" variant="ghost" aria-label="Назад" disabled={!live} onClick={() => send({ kind: "back" })}>
            <ArrowLeft />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Вперёд" disabled={!live} onClick={() => send({ kind: "forward" })}>
            <ArrowRight />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Обновить" disabled={!live} onClick={() => send({ kind: "reload" })}>
            <RotateCw />
          </Button>
          <form onSubmit={go} className="min-w-0 flex-1">
            <Input aria-label="Адрес" value={address} disabled={!live} onFocus={() => setEditing(true)} onBlur={() => setEditing(false)} onChange={(e) => setAddress(e.target.value)} className="font-mono text-xs" />
          </form>
          <Button size="sm" variant="outline" onClick={() => void close(true)}>
            <Power aria-hidden />
            Закрыть сессию
          </Button>
        </div>
        <div
          role="application"
          aria-label={`Страница ${page.title || page.url}`}
          aria-roledescription="удалённый браузер"
          tabIndex={0}
          onKeyDown={live ? onKey : undefined}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (live && text) send({ kind: "text", text });
          }}
          className="relative grid min-h-0 flex-1 place-items-center overflow-hidden rounded-md border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {frame && (
            <img
              ref={image}
              src={frame}
              alt=""
              draggable={false}
              data-testid="remote-frame"
              onClick={live ? onClick : undefined}
              onDoubleClick={(e) => e.preventDefault()}
              onContextMenu={live ? onClick : undefined}
              onMouseMove={live ? onMove : undefined}
              onWheel={live ? onWheel : undefined}
              className="max-h-full max-w-full cursor-default object-contain select-none"
            />
          )}
          {state.phase !== "live" && (
            <div role="status" className="absolute inset-0 grid place-items-center bg-background/70 text-sm">
              {state.phase === "starting" ? (
                <span className="flex items-center gap-2">
                  <Spinner aria-hidden />
                  Запускаем браузер профиля…
                </span>
              ) : (
                <span>Сессия закрыта: {state.reason}</span>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
