import type { Fingerprint } from "@d2a/shared";

export const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[contenteditable='']",
  "[contenteditable='true']",
  ...["button", "link", "menuitem", "tab", "checkbox", "radio", "switch", "option", "combobox", "textbox", "searchbox"].map(
    (r) => `[role=${r}]`,
  ),
].join(",");

const MAX_TEXT = 100;
const MAX_HTML = 800;
export const TEST_ID_ATTRS = ["data-testid", "data-test", "data-test-id", "data-qa", "data-cy"];

/** The element a click "meant": clicks often land on an icon or span inside a button. */
export function interactiveAncestor(el: Element): Element {
  return el.closest(INTERACTIVE_SELECTOR) ?? el;
}

export function clean(s: string | null | undefined, max = MAX_TEXT): string | undefined {
  const t = s?.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const INPUT_ROLES: Record<string, string> = {
  button: "button", submit: "button", reset: "button", image: "button",
  checkbox: "checkbox", radio: "radio", range: "slider", search: "searchbox", number: "spinbutton",
  text: "textbox", email: "textbox", tel: "textbox", url: "textbox", password: "textbox", "": "textbox",
};

export function roleOf(el: Element): string | undefined {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit.split(/\s+/)[0];
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return el.hasAttribute("href") ? "link" : undefined;
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "select") return (el as HTMLSelectElement).multiple ? "listbox" : "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "img") return "img";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "form") return "form";
  if (tag === "input") return INPUT_ROLES[(el as HTMLInputElement).type] ?? undefined;
  if ((el as HTMLElement).isContentEditable) return "textbox";
  return undefined;
}

export function accessibleName(el: Element): string | undefined {
  const aria = clean(el.getAttribute("aria-label"));
  if (aria) return aria;
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = clean(labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
    if (text) return text;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const label = clean(Array.from(el.labels ?? []).map((l) => l.textContent ?? "").join(" "));
    if (label) return label;
    if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type) && el.value) return clean(el.value);
    const placeholder = clean(el.getAttribute("placeholder"));
    if (placeholder) return placeholder;
  }
  if (el instanceof HTMLImageElement) return clean(el.alt);
  const text = clean((el as HTMLElement).innerText);
  if (text) return text;
  return clean(el.getAttribute("title")) ?? clean(el.querySelector("img[alt]")?.getAttribute("alt"));
}

/** IDs that look framework-generated change between page loads; don't build selectors on them. */
function isStableId(id: string): boolean {
  return !/^\d|\d{4,}|[0-9a-f]{8,}|^:|^(ember|react|mui|radix|headlessui)/i.test(id);
}

function isUnique(selector: string): boolean {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

function testIdOf(el: Element): string | undefined {
  for (const attr of TEST_ID_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) return v;
  }
  return undefined;
}

function nthOfType(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (!parent) return tag;
  const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
  return same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(el) + 1})` : tag;
}

function stablePart(el: Element): string | undefined {
  if (el.id && isStableId(el.id)) return `#${CSS.escape(el.id)}`;
  for (const attr of TEST_ID_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) return `[${attr}="${CSS.escape(v)}"]`;
  }
  const name = el.getAttribute("name");
  if (name && /^(input|select|textarea|button|form)$/i.test(el.tagName)) {
    return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
  }
  return undefined;
}

/** Shortest readable selector that is unique in the document, built bottom-up. */
export function cssPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.documentElement && parts.length < 8) {
    const stable = stablePart(cur);
    if (stable && parts.length === 0 && isUnique(stable)) return stable;
    parts.unshift(stable ?? nthOfType(cur));
    const candidate = parts.join(" > ");
    if (isUnique(candidate)) return candidate;
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

/** Cheap unique path: nth-of-type chain up to the nearest uniquely-identified ancestor. No per-level uniqueness checks. */
export function structuralPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    if (cur.id && isStableId(cur.id) && document.querySelectorAll(`#${CSS.escape(cur.id)}`).length === 1) {
      parts.unshift(`#${CSS.escape(cur.id)}`);
      return parts.join(" > ");
    }
    parts.unshift(nthOfType(cur));
    cur = cur.parentElement;
  }
  return ["body", ...parts].join(" > ");
}

export function xpathOf(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === Node.ELEMENT_NODE) {
    const tag = cur.tagName.toLowerCase();
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      parts.unshift(same.length > 1 ? `${tag}[${same.indexOf(cur) + 1}]` : tag);
    } else parts.unshift(tag);
    cur = parent;
  }
  return `/${parts.join("/")}`;
}

function trimmedHtml(el: Element): string {
  let html = el.outerHTML;
  if (html.length > 20_000) html = `${html.slice(0, html.indexOf(">") + 1)}…`;
  html = html
    .replace(/<svg[\s\S]*?<\/svg>/g, "<svg/>")
    .replace(/\s(style|d|srcset)="[^"]*"/g, "")
    .replace(/\s+/g, " ");
  const parent = el.parentElement;
  const parentOpen = parent ? parent.outerHTML.slice(0, parent.outerHTML.indexOf(">") + 1) : "";
  const out = parentOpen ? `${parentOpen}${html}</${parent!.tagName.toLowerCase()}>` : html;
  return out.length > MAX_HTML ? `${out.slice(0, MAX_HTML - 1)}…` : out;
}

function bboxOf(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}

/** Full fingerprint for an element the user acted on. */
export function fingerprint(el: Element): Fingerprint {
  return {
    role: roleOf(el),
    name: accessibleName(el),
    text: clean((el as HTMLElement).innerText),
    testId: testIdOf(el),
    id: el.id || undefined,
    nameAttr: el.getAttribute("name") ?? undefined,
    css: cssPath(el),
    xpath: xpathOf(el),
    href: el instanceof HTMLAnchorElement && el.href ? el.href : undefined,
    bbox: bboxOf(el),
    html: trimmedHtml(el),
  };
}

/** Lighter fingerprint for page inventories: skips the uniqueness search and HTML context. */
export function lightFingerprint(el: Element): Fingerprint {
  return {
    role: roleOf(el),
    name: accessibleName(el),
    testId: testIdOf(el),
    id: el.id || undefined,
    nameAttr: el.getAttribute("name") ?? undefined,
    css: structuralPath(el),
    href: el instanceof HTMLAnchorElement && el.href ? el.href : undefined,
    bbox: bboxOf(el),
  };
}
