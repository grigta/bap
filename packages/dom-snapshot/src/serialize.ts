import type { PageSnapshot, SnapshotElement } from "./snapshot.ts";

const q = (s: string) => JSON.stringify(s);

function line(el: SnapshotElement): string {
  const parts = [`[${el.ref}]`, el.role];
  if (el.name) parts.push(q(el.name));
  else if (el.text) parts.push(q(el.text));
  if (el.text && el.name && el.text !== el.name && el.role !== "textbox") parts.push(`text=${q(el.text)}`);
  if (el.value !== undefined) parts.push(`value=${q(el.value)}`);
  if (el.attrs.type && el.tag === "input") parts.push(`type=${el.attrs.type}`);
  if (el.attrs.href) parts.push(`href=${q(el.attrs.href)}`);
  if (el.options) parts.push(`options=${q(el.options.join(" | "))}`);
  if (el.states.length) parts.push(`(${el.states.join(", ")})`);
  if (el.context && el.interactive && el.context !== el.name) parts.push(`in ${q(el.context)}`);
  if (el.shadowHost) parts.push(`shadow:${el.shadowHost}`);
  return parts.join(" ");
}

/**
 * The page as compact text for the model: visible elements with their refs, grouped by frame.
 * Hidden elements are left out: the model may only choose what a person could see.
 */
export function serializeSnapshot(page: PageSnapshot, maxChars = 30_000): string {
  const out = [`URL: ${page.url}`, `Title: ${page.title}`];
  let frame = "";
  for (const el of page.elements) {
    if (!el.visible) continue;
    if (el.frame !== frame) {
      frame = el.frame;
      out.push(frame ? `--- frame ${frame} ---` : "--- top document ---");
    }
    out.push(line(el));
  }
  const text = out.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (cut)` : text;
}
