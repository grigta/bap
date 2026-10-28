import type { CDPSession, Page } from "playwright-core";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One element of the page as the system sees it: no selectors, only what survives a redesign best. */
export interface SnapshotElement {
  /** e1…eN in document order; valid for this snapshot only. */
  ref: string;
  /** Accessibility role (button, link, textbox…), or "text"/"heading" for content. */
  role: string;
  /** Accessible name. */
  name: string;
  tag: string;
  /** Text inside the element, collapsed and cut to 120 characters. */
  text: string;
  /** Current value of a form field; secrets are masked. */
  value?: string;
  /** id, name, type, placeholder, href, title, alt, role, aria-*, data-*. */
  attrs: Record<string, string>;
  /** disabled, checked, selected, expanded, required, readonly, focused. */
  states: string[];
  visible: boolean;
  interactive: boolean;
  /** Position in the top document, in CSS pixels. */
  rect: Rect;
  /** Nearest text before the element: the caption a person reads next to it. */
  label: string;
  /** Text of the nearest container (card, row, form): tells identical buttons apart. */
  context: string;
  /** Semantic ancestors: landmarks, forms, lists, tables. Wrapper divs are left out. */
  path: string[];
  /** Origin and path of the frame document; "" for the top document. */
  frame: string;
  /** Tag of the nearest shadow host, when the element lives in a shadow tree. */
  shadowHost?: string;
  /** Option labels of a <select>. */
  options?: string[];
}

export interface PageSnapshot {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  elements: SnapshotElement[];
  /** Visible text of the whole page (all frames), collapsed. */
  text: string;
}

/** Where an element lives, for acting on it; not serializable, stays on the agent. */
export interface NodeHandle {
  session: CDPSession;
  backendNodeId: number;
  frameId: string;
  /** Owner <iframe> elements of out-of-process frames, innermost first: their offsets apply to clicks. */
  owners: { session: CDPSession; backendNodeId: number }[];
}

export interface Snapshot {
  page: PageSnapshot;
  handles: Map<string, NodeHandle>;
  /** Detaches the CDP sessions behind the handles. */
  dispose(): Promise<void>;
}

export interface SnapshotOptions {
  /** Values that must never leave the agent (secret inputs): replaced with •••. */
  secrets?: string[];
  /** Upper bound on elements; interactive ones are kept first. */
  maxElements?: number;
}

export const MASK = "•••";

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option", "menuitem",
  "menuitemcheckbox", "menuitemradio", "tab", "switch", "spinbutton", "slider", "treeitem",
]);
const SEMANTIC = new Set(["header", "nav", "main", "footer", "aside", "form", "article", "dialog", "table", "ul", "ol", "fieldset"]);
const SKIP_TEXT = new Set(["script", "style", "noscript", "template", "head", "title"]);
const KEPT_ATTR = /^(id|name|type|placeholder|href|title|alt|role|for|aria-[\w-]+|data-[\w-]+)$/;

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface RawSnapshot {
  documents: RawDocument[];
  strings: string[];
}
interface RareString {
  index: number[];
  value: number[];
}
interface RawDocument {
  documentURL: number;
  title: number;
  frameId: number;
  nodes: {
    parentIndex: number[];
    nodeType: number[];
    shadowRootType?: RareString;
    nodeName: number[];
    nodeValue: number[];
    backendNodeId: number[];
    attributes: number[][];
    textValue?: RareString;
    inputValue?: RareString;
    inputChecked?: { index: number[] };
    optionSelected?: { index: number[] };
    contentDocumentIndex?: { index: number[]; value: number[] };
    isClickable?: { index: number[] };
  };
  layout: { nodeIndex: number[]; styles: number[][]; bounds: number[][]; clientRects?: number[][] };
}
interface AxNode {
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
  properties?: { name: string; value: { value: unknown } }[];
  backendDOMNodeId?: number;
}

/** A document captured from one CDP session, placed in the top document's coordinates. */
interface PlacedDocument {
  session: CDPSession;
  doc: RawDocument;
  strings: string[];
  offset: { x: number; y: number };
  owners: NodeHandle["owners"];
  top: boolean;
}

const STYLES = ["visibility", "opacity", "display"];

/**
 * Builds a snapshot through CDP only (DOMSnapshot + Accessibility): nothing runs in the page's main world
 * and the page is not changed (REQ-DOM-002). Covers same-process frames, out-of-process frames and
 * open and closed shadow trees (REQ-DOM-001).
 */
export async function captureSnapshot(page: Page, opts: SnapshotOptions = {}): Promise<Snapshot> {
  const context = page.context();
  const main = await context.newCDPSession(page);
  const placed: PlacedDocument[] = [];
  const sessions: CDPSession[] = [main];
  const dispose = async () => void (await Promise.all(sessions.map((s) => s.detach().catch(() => {}))));
  try {
    const root = (await main.send("DOMSnapshot.captureSnapshot", { computedStyles: STYLES, includeDOMRects: true })) as unknown as RawSnapshot;
    placeDocuments(main, root, { x: 0, y: 0 }, [], placed, true);
    // Out-of-process frames have their own sessions; the rest are already in the documents above.
    for (const frame of page.frames().slice(1)) {
      let session: CDPSession;
      try {
        session = await context.newCDPSession(frame);
      } catch {
        continue; // same-process frame
      }
      sessions.push(session);
      const { frame: info } = ((await session.send("Page.getFrameTree")) as { frameTree: { frame: { id: string; parentId?: string } } }).frameTree;
      const parent = placed.find((p) => p.doc.frameId >= 0 && p.strings[p.doc.frameId] === info.parentId);
      if (!parent) continue;
      const frameId = info.id;
      const parentSession = parent.session;
      const owner = (await parentSession.send("DOM.getFrameOwner", { frameId }).catch(() => null)) as { backendNodeId: number } | null;
      if (!owner) continue;
      const box = (await parentSession.send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId }).catch(() => null)) as { model: { content: number[] } } | null;
      if (!box) continue; // a frame without a box (hidden) has nothing to show
      // Box model quads are in the viewport of the session's frame; snapshot bounds are in document coordinates.
      const base = parentSession === main ? await scrollOf(main) : parent.offset;
      const offset = { x: box.model.content[0]! + base.x, y: box.model.content[1]! + base.y };
      const raw = (await session.send("DOMSnapshot.captureSnapshot", { computedStyles: STYLES, includeDOMRects: true })) as unknown as RawSnapshot;
      placeDocuments(session, raw, offset, [{ session: parentSession, backendNodeId: owner.backendNodeId }, ...(parent?.owners ?? [])], placed, false);
    }
    const metrics = (await main.send("Page.getLayoutMetrics")) as { cssLayoutViewport: { clientWidth: number; clientHeight: number } };
    const viewport = { width: metrics.cssLayoutViewport.clientWidth, height: metrics.cssLayoutViewport.clientHeight };
    return { ...(await buildSnapshot(page.url(), viewport, placed, opts)), dispose };
  } catch (e) {
    await dispose();
    throw e;
  }
}

async function scrollOf(session: CDPSession) {
  const m = (await session.send("Page.getLayoutMetrics")) as { cssVisualViewport: { pageX: number; pageY: number } };
  return { x: m.cssVisualViewport.pageX, y: m.cssVisualViewport.pageY };
}

/** Adds the snapshot's documents with their offsets: a child document sits inside its <iframe>'s content box. */
function placeDocuments(session: CDPSession, raw: RawSnapshot, base: { x: number; y: number }, owners: NodeHandle["owners"], out: PlacedDocument[], top: boolean) {
  const offsets = new Map<number, { x: number; y: number }>([[0, base]]);
  raw.documents.forEach((doc, index) => {
    const offset = offsets.get(index) ?? base;
    out.push({ session, doc, strings: raw.strings, offset, owners, top: top && index === 0 });
    const content = doc.nodes.contentDocumentIndex;
    if (!content) return;
    const layoutOf = new Map(doc.layout.nodeIndex.map((n, i) => [n, i]));
    content.index.forEach((node, i) => {
      const li = layoutOf.get(node);
      const b = li !== undefined ? doc.layout.bounds[li] : undefined;
      const c = li !== undefined ? doc.layout.clientRects?.[li] : undefined;
      offsets.set(content.value[i]!, { x: offset.x + (b?.[0] ?? 0) + (c?.[0] ?? 0), y: offset.y + (b?.[1] ?? 0) + (c?.[1] ?? 0) });
    });
  });
}

async function axTree(p: PlacedDocument): Promise<Map<number, AxNode>> {
  const frameId = p.doc.frameId >= 0 ? p.strings[p.doc.frameId] : undefined;
  const res = (await p.session.send("Accessibility.getFullAXTree", frameId ? { frameId } : {}).catch(() => ({ nodes: [] }))) as { nodes: AxNode[] };
  return new Map(res.nodes.filter((n) => n.backendDOMNodeId !== undefined).map((n) => [n.backendDOMNodeId!, n]));
}

async function buildSnapshot(url: string, viewport: PageSnapshot["viewport"], placed: PlacedDocument[], opts: SnapshotOptions): Promise<Omit<Snapshot, "dispose">> {
  const secrets = (opts.secrets ?? []).filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  const mask = (s: string) => secrets.reduce((acc, secret) => acc.split(secret).join(MASK), s);
  const elements: SnapshotElement[] = [];
  const handles = new Map<string, NodeHandle>();
  const pageText: string[] = [];
  const raw: { order: number; element: SnapshotElement; handle: NodeHandle }[] = [];
  let order = 0;

  for (const p of placed) {
    const { doc, strings } = p;
    const n = doc.nodes;
    const s = (i: number | undefined) => (i === undefined || i < 0 ? "" : strings[i]!);
    const count = n.parentIndex.length;
    const ax = await axTree(p);
    const children: number[][] = Array.from({ length: count }, () => []);
    for (let i = 0; i < count; i++) if (n.parentIndex[i]! >= 0) children[n.parentIndex[i]!]!.push(i);
    const rare = (r: RareString | undefined) => new Map(r ? r.index.map((idx, k) => [idx, s(r.value[k])]) : []);
    const shadowType = rare(n.shadowRootType);
    const inputValue = rare(n.inputValue);
    const textValue = rare(n.textValue);
    const checked = new Set(n.inputChecked?.index ?? []);
    const selected = new Set(n.optionSelected?.index ?? []);
    const clickable = new Set(n.isClickable?.index ?? []);
    const layoutOf = new Map(doc.layout.nodeIndex.map((node, i) => [node, i]));
    const tag = (i: number) => s(n.nodeName[i]).toLowerCase();
    const attrs = (i: number) => {
      const list = n.attributes[i] ?? [];
      const out: Record<string, string> = {};
      for (let k = 0; k + 1 < list.length; k += 2) out[s(list[k])] = s(list[k + 1]);
      return out;
    };
    const frameUrl = (() => {
      if (p.top) return "";
      try {
        const u = new URL(s(doc.documentURL));
        return `${u.origin}${u.pathname}`;
      } catch {
        return s(doc.documentURL);
      }
    })();

    // User-agent shadow trees (inside <input>, <select>…) are browser internals, not page content.
    const hidden = new Uint8Array(count); // 1: inside a user-agent shadow tree
    const shadowHost: (string | undefined)[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const parent = n.parentIndex[i]!;
      const type = shadowType.get(i);
      if (parent >= 0) {
        hidden[i] = hidden[parent]!;
        shadowHost[i] = shadowHost[parent];
      }
      // Snapshot nodes carry the shadow root type of the tree they are in; the host is the first ancestor outside it.
      if (type === "user-agent") hidden[i] = 1;
      else if ((type === "open" || type === "closed") && parent >= 0 && !shadowType.has(parent)) shadowHost[i] = tag(parent);
    }

    // Text of every node, children first (parents always come before children in the arrays).
    const text: string[] = new Array(count).fill("");
    const own: string[] = new Array(count).fill("");
    for (let i = count - 1; i >= 0; i--) {
      if (hidden[i]) continue;
      if (n.nodeType[i] === 3) {
        text[i] = s(n.nodeValue[i]);
        continue;
      }
      if (n.nodeType[i] !== 1 && n.nodeType[i] !== 11) continue;
      if (SKIP_TEXT.has(tag(i))) continue;
      // A button made of <input> shows its value: it is the button's text for people and for containers.
      const a = tag(i) === "input" ? attrs(i) : null;
      if (a && ["submit", "button", "reset"].includes(a.type ?? "") && a.value) {
        text[i] = collapse(a.value);
        continue;
      }
      const parts = children[i]!.map((c) => text[c]!).filter(Boolean);
      text[i] = cut(collapse(parts.join(" ")), 400);
      own[i] = collapse(children[i]!.filter((c) => n.nodeType[c] === 3).map((c) => s(n.nodeValue[c])).join(" "));
    }

    const style = (i: number) => {
      const li = layoutOf.get(i);
      if (li === undefined) return null;
      const [visibility, opacity] = (doc.layout.styles[li] ?? []).map((v) => s(v));
      return { visibility, opacity, bounds: doc.layout.bounds[li]! };
    };
    const transparent = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const parent = n.parentIndex[i]!;
      if (parent >= 0) transparent[i] = transparent[parent]!;
      if (style(i)?.opacity === "0") transparent[i] = 1;
    }
    const isVisible = (i: number) => {
      const st = style(i);
      if (!st || transparent[i]) return false;
      const [, , w, h] = st.bounds;
      return st.visibility !== "hidden" && st.visibility !== "collapse" && (w ?? 0) > 0 && (h ?? 0) > 0;
    };

    // Visible text of the page, in document order.
    for (let i = 0; i < count; i++) if (n.nodeType[i] === 3 && !hidden[i] && n.parentIndex[i]! >= 0 && !SKIP_TEXT.has(tag(n.parentIndex[i]!)) && isVisible(n.parentIndex[i]!)) {
      const t = collapse(s(n.nodeValue[i]));
      if (t) pageText.push(t);
    }

    const ancestors = (i: number) => {
      const out: number[] = [];
      for (let a = n.parentIndex[i]!; a >= 0; a = n.parentIndex[a]!) out.push(a);
      return out;
    };
    const labelOf = (i: number) => {
      let node = i;
      for (let depth = 0; depth < 3 && node >= 0; depth++) {
        const parent = n.parentIndex[node]!;
        if (parent < 0) break;
        const siblings = children[parent]!;
        for (let k = siblings.indexOf(node) - 1; k >= 0; k--) {
          const t = text[siblings[k]!]!;
          if (t) return cut(t, 80);
        }
        node = parent;
      }
      return "";
    };
    const contextOf = (i: number) => {
      const mine = text[i]!.length;
      for (const [depth, a] of ancestors(i).entries()) {
        if (depth > 6) break;
        const t = text[a]!;
        if (t.length > mine + 3) return t.length <= 300 ? cut(t, 160) : "";
      }
      return "";
    };

    for (let i = 0; i < count; i++) {
      if (n.nodeType[i] !== 1 || hidden[i]) continue;
      const t = tag(i);
      if (SKIP_TEXT.has(t) || t === "html" || t === "body" || t === "iframe") continue;
      const a = attrs(i);
      const node = ax.get(n.backendNodeId[i]!);
      const axRole = node && !node.ignored ? (node.role?.value ?? "") : "";
      const formField = (t === "input" && a.type !== "hidden") || t === "select" || t === "textarea" || t === "button";
      const interactive =
        formField ||
        (t === "a" && "href" in a) ||
        INTERACTIVE_ROLES.has(axRole) ||
        (clickable.has(i) && text[i]!.length > 0 && text[i]!.length <= 80) ||
        (a.tabindex !== undefined && a.tabindex !== "-1") ||
        a.contenteditable === "true";
      const heading = /^h[1-6]$/.test(t) || axRole === "heading";
      const textual = !interactive && (heading || axRole === "alert" || axRole === "status" || (own[i]!.length > 0 && own[i]!.length <= 200));
      if (!interactive && !textual) continue;
      const visible = isVisible(i);
      if (textual && !visible) continue;

      const bounds = style(i)?.bounds ?? [0, 0, 0, 0];
      const states: string[] = [];
      if ("disabled" in a) states.push("disabled");
      if (checked.has(i)) states.push("checked");
      if (selected.has(i)) states.push("selected");
      if ("required" in a) states.push("required");
      if ("readonly" in a) states.push("readonly");
      for (const prop of node?.properties ?? []) {
        // AX values are booleans or tristate strings ("true", "false", "mixed").
        const on = String(prop.value.value) === "true";
        if (prop.name === "expanded" && on) states.push("expanded");
        if (prop.name === "focused" && on) states.push("focused");
        if (prop.name === "checked" && on && !states.includes("checked")) states.push("checked");
      }
      const kept: Record<string, string> = {};
      for (const [k, v] of Object.entries(a)) if (KEPT_ATTR.test(k)) kept[k] = mask(cut(v, 200));
      const isPassword = t === "input" && a.type === "password";
      // A <select> shows its chosen option; the snapshot marks options, not the select.
      const chosen = t === "select" ? children[i]!.find((c) => tag(c) === "option" && selected.has(c)) : undefined;
      let value = chosen !== undefined ? collapse(text[chosen]!) : (inputValue.get(i) ?? textValue.get(i));
      if (value !== undefined) value = isPassword && value ? MASK : mask(cut(value, 200));
      const options = t === "select" ? children[i]!.filter((c) => tag(c) === "option").map((c) => mask(collapse(text[c]!))) : undefined;
      const name = mask(cut(collapse(node?.name?.value ?? ""), 120));
      const element: SnapshotElement = {
        ref: "",
        role: heading ? "heading" : axRole && axRole !== "generic" && axRole !== "none" && axRole !== "StaticText" ? axRole : interactive ? defaultRole(t, a) : "text",
        name,
        tag: t,
        text: mask(cut(text[i]!, 120)),
        ...(value !== undefined && (formField || t === "textarea") && { value }),
        attrs: kept,
        states,
        visible,
        interactive,
        rect: { x: round(bounds[0]! + p.offset.x), y: round(bounds[1]! + p.offset.y), width: round(bounds[2]!), height: round(bounds[3]!) },
        label: mask(labelOf(i)),
        context: mask(contextOf(i)),
        path: ancestors(i)
          .reverse()
          .map((x) => attrs(x).role ?? (SEMANTIC.has(tag(x)) ? tag(x) : ""))
          .filter(Boolean),
        frame: frameUrl,
        ...(shadowHost[i] && { shadowHost: shadowHost[i] }),
        ...(options && { options }),
      };
      raw.push({ order: order++, element, handle: { session: p.session, backendNodeId: n.backendNodeId[i]!, frameId: p.doc.frameId >= 0 ? s(p.doc.frameId) : "", owners: p.owners } });
    }
  }

  // Interactive elements first when the page is too big, then document order again.
  const max = opts.maxElements ?? 800;
  const chosen = raw.length <= max ? raw : [...raw].sort((x, y) => Number(y.element.interactive) - Number(x.element.interactive) || x.order - y.order).slice(0, max).sort((x, y) => x.order - y.order);
  chosen.forEach(({ element, handle }, k) => {
    element.ref = `e${k + 1}`;
    handles.set(element.ref, handle);
    elements.push(element);
  });

  const top = placed.find((p) => p.top);
  return {
    page: {
      url: mask(url),
      title: mask(top && top.doc.title >= 0 ? top.strings[top.doc.title]! : ""),
      viewport,
      elements,
      text: mask(cut(pageText.join(" "), 50_000)),
    },
    handles,
  };
}

const round = (v: number) => Math.round(v * 10) / 10;

function defaultRole(tag: string, a: Record<string, string>): string {
  if (tag === "a") return "link";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const type = a.type ?? "text";
    if (["checkbox", "radio"].includes(type)) return type;
    if (["submit", "button", "reset", "image"].includes(type)) return "button";
    return "textbox";
  }
  return tag === "button" ? "button" : "generic";
}
