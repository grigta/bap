import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright-core";
import type { NodeHandle, Snapshot } from "./snapshot.ts";

export type ElementAction =
  | { kind: "click" }
  | { kind: "dblclick" }
  /** Right button: opens a site's context menu. */
  | { kind: "rightclick" }
  /** Moves the mouse over the element: menus that open on hover. */
  | { kind: "hover" }
  | { kind: "fill"; value: string }
  | { kind: "select"; value: string }
  /** Files on this Mac for an <input type=file>. */
  | { kind: "upload"; files: string[] };

export class ActionError extends Error {}

/** Centre of the element in the top viewport, after scrolling it into view. */
async function clickPoint(handle: NodeHandle, centred = false): Promise<{ x: number; y: number }> {
  const { session, backendNodeId } = handle;
  const quadsOf = async () => ((await session.send("DOM.getContentQuads", { backendNodeId }).catch(() => ({ quads: [] }))) as { quads: number[][] }).quads;
  const before = JSON.stringify(await quadsOf());
  // Outermost first: the <iframe> must be in view before anything inside it can be. To the middle of the view,
  // as a person would look at it: at an edge, sticky headers and footers cover it.
  // (An <iframe> owner is scrolled by the browser: in an isolated world its node would resolve to the child frame.)
  for (const owner of [...handle.owners].reverse()) await owner.session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: owner.backendNodeId }).catch(() => {});
  await callInIsolatedWorld(handle, TO_CENTRE, [false]).catch(() => session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {}));
  // Clicks are routed by the compositor's hit-test data, which lags a scroll by a frame: right after scrolling,
  // a click can land on whatever was at that point before (e.g. a cross-origin frame). Wait for painted frames.
  if (handle.owners.length > 0 || JSON.stringify(await quadsOf()) !== before) {
    // Every frame that scrolled must paint: the pages holding the <iframe> owners, then the element's own frame.
    for (const owner of handle.owners) await framesPainted(owner.session);
    await callInIsolatedWorld(handle, NEXT_FRAMES, [], true).catch(() => {});
  }
  const quads = await quadsOf();
  const quad = quads.find((q) => Math.abs(q[4]! - q[0]!) > 1 && Math.abs(q[5]! - q[1]!) > 1);
  if (!quad) throw new ActionError("the element has no visible box to click");
  let x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
  let y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
  // A person would click whatever covers the element (a cookie banner, a modal): say so instead. A sticky header
  // or footer covers it only at the edge of the view: one more look with the element in the middle.
  const cover = (await callInIsolatedWorld(handle, COVERED_BY, [x, y])) as string;
  if (cover && !centred) {
    await callInIsolatedWorld(handle, TO_CENTRE, [true]).catch(() => {});
    await callInIsolatedWorld(handle, NEXT_FRAMES, [], true).catch(() => {});
    return clickPoint(handle, true);
  }
  if (cover) throw new ActionError(`the element is covered by ${cover}`);
  // Quads of an out-of-process frame are in its own viewport: add each owner <iframe>'s content box.
  for (const owner of handle.owners) {
    const box = (await owner.session.send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId })) as { model: { content: number[] } };
    x += box.model.content[0]!;
    y += box.model.content[1]!;
  }
  return { x, y };
}

/** Runs a function on the element in an isolated world: the page's own scripts and globals never see it. */
async function callInIsolatedWorld(handle: NodeHandle, fn: string, args: unknown[], awaitPromise = false): Promise<unknown> {
  const { session, backendNodeId } = handle;
  // The node's own frame: an <iframe> owner lives in its parent's frame.
  const frameId = handle.frameId || ((await session.send("DOM.describeNode", { backendNodeId })) as { node: { frameId?: string } }).node.frameId!;
  const world = (await session.send("Page.createIsolatedWorld", { frameId, worldName: "bap-recipes" })) as { executionContextId: number };
  const { object } = (await session.send("DOM.resolveNode", { backendNodeId, executionContextId: world.executionContextId })) as { object: { objectId: string } };
  const res = (await session.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: fn,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise,
  })) as { result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text: string } };
  if (res.exceptionDetails) throw new ActionError(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  return res.result.value;
}

/** Scrolls the element to the middle of the view only when it is not fully inside the view already. */
const TO_CENTRE = `function (force) {
  const r = this.getBoundingClientRect();
  const inside = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
  if (force || !inside) this.scrollIntoView({ block: "center", inline: "center" });
}`;

/** Waits for two painted frames of the session's own document, in an isolated world. */
async function framesPainted(session: NodeHandle["session"]): Promise<void> {
  try {
    const { frameTree } = (await session.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
    const world = (await session.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "bap-recipes" })) as { executionContextId: number };
    await session.send("Runtime.evaluate", { expression: "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))", contextId: world.executionContextId, awaitPromise: true });
  } catch {
    // a frame that went away has nothing left to paint
  }
}

/** Resolves after two painted frames of the node's frame. */
const NEXT_FRAMES = "function () { return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))); }";

/** What is on top of the element at its centre (frame coordinates), or "" when the element itself is. */
const COVERED_BY = `function (x, y) {
  const root = this.getRootNode();
  const hit = (root.elementFromPoint ? root : document).elementFromPoint(x, y);
  if (!hit) return "";
  const mine = hit === this || this.contains(hit) || (this.shadowRoot && this.shadowRoot.contains(hit)) || hit.control === this ||
    (this.labels && [...this.labels].some((l) => l === hit || l.contains(hit))) || (hit.contains(this) && hit.getRootNode() !== root);
  if (mine) return "";
  const text = (hit.innerText || hit.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 60);
  return "<" + hit.tagName.toLowerCase() + ">" + (text ? " “" + text + "”" : "");
}`;

/** Inputs filled through the browser's own picker (date, time, colour, range): typing into them depends on the locale. */
const PICKERS = new Set(["date", "time", "datetime-local", "month", "week", "color", "range"]);

async function pickerInput(handle: NodeHandle): Promise<boolean> {
  const { node } = (await handle.session.send("DOM.describeNode", { backendNodeId: handle.backendNodeId })) as { node: { localName: string; attributes?: string[] } };
  const attrs = node.attributes ?? [];
  const type = attrs[attrs.indexOf("type") + 1];
  return node.localName === "input" && attrs.includes("type") && PICKERS.has(type ?? "");
}

const SET_VALUE = `function (value) {
  this.value = value;
  if (this.value !== value) throw new Error("the field does not accept " + JSON.stringify(value));
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
}`;

const SELECT_OPTION = `function (wanted) {
  const norm = (s) => s.replace(/\\s+/g, " ").trim().toLowerCase();
  const option = [...this.options].find((o) => norm(o.label) === norm(wanted) || o.value === wanted);
  if (!option) throw new Error("no option " + JSON.stringify(wanted) + " in the list");
  this.value = option.value;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return option.label;
}`;

/**
 * Acts like a person: real mouse and keyboard events at the element's position (REQ-DOM-002).
 * <select> and picker inputs (date, time, colour, range) are set in an isolated world: their native popups do not
 * take mouse events and typing into them depends on the locale.
 */
export async function act(page: Page, handle: NodeHandle, action: ElementAction): Promise<void> {
  if (action.kind === "select") {
    await callInIsolatedWorld(handle, SELECT_OPTION, [action.value]);
    return;
  }
  if (action.kind === "upload") {
    // The browser's own file chooser is not scriptable by a person either; the files are set on the input.
    const missing = action.files.filter((f) => !existsSync(f));
    if (missing.length > 0) throw new ActionError(`no such file on this Mac: ${missing.join(", ")}`);
    await handle.session.send("DOM.setFileInputFiles", { files: action.files, backendNodeId: handle.backendNodeId });
    return;
  }
  if (action.kind === "fill" && (await pickerInput(handle))) {
    await callInIsolatedWorld(handle, SET_VALUE, [action.value]);
    return;
  }
  const point = await clickPoint(handle);
  if (action.kind === "hover") return void (await page.mouse.move(point.x, point.y, { steps: 5 }));
  if (action.kind === "dblclick") return void (await page.mouse.dblclick(point.x, point.y));
  if (action.kind === "rightclick") return void (await page.mouse.click(point.x, point.y, { button: "right" }));
  await page.mouse.click(point.x, point.y);
  if (action.kind === "fill") {
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    if (action.value) await page.keyboard.type(action.value, { delay: 15 });
  }
}

/**
 * Scrolls once like a person, with the mouse wheel: the first list or feed that has more below, else the page.
 * Returns false when there is nothing further down. Used to find targets that exist only once scrolled to
 * (virtualized lists, lazy loading).
 */
export async function scrollFurther(page: Page, snap: Snapshot): Promise<boolean> {
  for (const container of snap.scrollables) {
    if (container.owners.length > 0) continue; // a list inside another site's frame is scrolled with its page
    // The wheel turns what is under the mouse: the list must be in view first.
    await callInIsolatedWorld(container, TO_CENTRE, [false]).catch(() => {});
    await callInIsolatedWorld(container, NEXT_FRAMES, [], true).catch(() => {});
    const box = (await container.session.send("DOM.getContentQuads", { backendNodeId: container.backendNodeId }).catch(() => ({ quads: [] }))) as { quads: number[][] };
    const q = box.quads[0];
    if (!q) continue;
    const top = async () => (await callInIsolatedWorld(container, "function () { return this.scrollTop; }", [])) as number;
    const before = await top();
    await page.mouse.move((q[0]! + q[4]!) / 2, (q[1]! + q[5]!) / 2);
    await page.mouse.wheel(0, Math.max(100, (q[5]! - q[1]!) * 0.8));
    if (await moved(async () => (await top()) !== before)) return true;
  }
  if (!snap.page.canScrollDown) return false;
  const session = await page.context().newCDPSession(page);
  try {
    const at = async () => ((await session.send("Page.getLayoutMetrics")) as { cssVisualViewport: { pageY: number } }).cssVisualViewport.pageY;
    const before = await at();
    await page.mouse.move(snap.page.viewport.width / 2, snap.page.viewport.height / 2);
    await page.mouse.wheel(0, snap.page.viewport.height * 0.8);
    return await moved(async () => (await at()) !== before);
  } finally {
    await session.detach().catch(() => {});
  }
}

/** Whether a wheel turn moved anything: checked once per frame for as long as smooth scrolling starts (~20 frames). */
async function moved(check: () => Promise<boolean>): Promise<boolean> {
  for (let frame = 0; frame < 20; frame++) {
    if (await check()) return true;
    await sleep(16);
  }
  return false;
}
