import type { Page } from "playwright-core";
import type { NodeHandle } from "./snapshot.ts";

export type ElementAction =
  | { kind: "click" }
  | { kind: "fill"; value: string }
  | { kind: "select"; value: string };

export class ActionError extends Error {}

/** Centre of the element in the top viewport, after scrolling it into view. */
async function clickPoint(handle: NodeHandle): Promise<{ x: number; y: number }> {
  const { session, backendNodeId } = handle;
  const quadsOf = async () => ((await session.send("DOM.getContentQuads", { backendNodeId }).catch(() => ({ quads: [] }))) as { quads: number[][] }).quads;
  const before = JSON.stringify(await quadsOf());
  // Outermost first: the <iframe> must be in view before anything inside it can be.
  for (const owner of [...handle.owners].reverse()) await owner.session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: owner.backendNodeId }).catch(() => {});
  await session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
  // Clicks are routed by the compositor's hit-test data, which lags a scroll by a frame: right after scrolling,
  // a click can land on whatever was at that point before (e.g. a cross-origin frame). Wait for painted frames.
  if (handle.owners.length > 0 || JSON.stringify(await quadsOf()) !== before) {
    for (const h of [handle, ...handle.owners.map((o) => ({ ...handle, ...o, frameId: "" }))]) await callInIsolatedWorld(h, NEXT_FRAMES, [], true).catch(() => {});
  }
  const quads = await quadsOf();
  const quad = quads.find((q) => Math.abs(q[4]! - q[0]!) > 1 && Math.abs(q[5]! - q[1]!) > 1);
  if (!quad) throw new ActionError("the element has no visible box to click");
  let x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
  let y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
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

/** Resolves after two painted frames of the node's frame. */
const NEXT_FRAMES = "function () { return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))); }";

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
 * Only <select> is set in an isolated world, since native option popups do not take mouse events.
 */
export async function act(page: Page, handle: NodeHandle, action: ElementAction): Promise<void> {
  if (action.kind === "select") {
    await callInIsolatedWorld(handle, SELECT_OPTION, [action.value]);
    return;
  }
  const point = await clickPoint(handle);
  await page.mouse.click(point.x, point.y);
  if (action.kind === "fill") {
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    if (action.value) await page.keyboard.type(action.value, { delay: 15 });
  }
}
