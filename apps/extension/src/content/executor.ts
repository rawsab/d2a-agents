import type { ListField, ListItem, Locator } from "@d2a/shared";
import { INTERACTIVE_SELECTOR, TEST_ID_ATTRS, accessibleName, clean, roleOf, structuralPath } from "./fingerprint.js";
import { pageInventory } from "./inventory.js";

export type ExecRequest =
  | { type: "exec/locate"; locator: Locator }
  | { type: "exec/prepareFill"; locator: Locator }
  | { type: "exec/readValue"; locator: Locator }
  | { type: "exec/setValue"; locator: Locator; value: string }
  | { type: "exec/focus"; locator: Locator }
  | { type: "exec/probe"; locator: Locator; textIncludes?: string }
  | { type: "exec/extract"; locator: Locator; attr?: string }
  | { type: "exec/extractList"; container?: Locator; itemSelector: string; fields: Record<string, ListField> }
  | { type: "exec/lastCopied" }
  | { type: "exec/snapshot" };

/** How much each locator strategy's vote counts; a vote is split among all elements it matches. */
const WEIGHTS = { testId: 3, roleName: 3, id: 2, css: 2, href: 2, xpath: 1, text: 1 } as const;
type Strategy = keyof typeof WEIGHTS;
const MAX_TEXT = 2000;

const norm = (s?: string) => s?.replace(/\s+/g, " ").trim().toLowerCase();

function isVisible(el: Element): boolean {
  // The page itself: sites like YouTube give <body> no height, but its text is still on screen.
  if (el === document.body || el === document.documentElement) return true;
  if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function queryAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return []; // recorded selector isn't valid here
  }
}

function xpathAll(xpath: string): Element[] {
  try {
    const snap = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    return Array.from({ length: snap.snapshotLength }, (_, i) => snap.snapshotItem(i)).filter(
      (n): n is Element => n instanceof Element,
    );
  } catch {
    return [];
  }
}

function byRoleAndName(root: ParentNode, role: string, name: string): Element[] {
  const want = norm(name);
  const withRole = Array.from(root.querySelectorAll("*")).filter((el) => roleOf(el) === role);
  const exact = withRole.filter((el) => norm(accessibleName(el)) === want);
  return exact.length ? exact : withRole.filter((el) => want && norm(accessibleName(el))?.includes(want));
}

function textOf(el: Element): string {
  return ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

/** Reads a property when it exists (e.g. `href` gives the absolute URL), else the attribute. */
function readAttr(el: Element, attr: string): string {
  const prop = (el as unknown as Record<string, unknown>)[attr];
  return typeof prop === "string" ? prop : (el.getAttribute(attr) ?? "");
}

export class ResolveError extends Error {}

export function resolve({ fingerprint: fp, within }: Locator): { el: Element; strategies: Strategy[] } {
  const root: ParentNode = within ? document.querySelector(within) ?? fail(`container ${within} not found`) : document;
  const votes: [Strategy, Element[]][] = [];
  if (fp.testId) votes.push(["testId", queryAll(root, TEST_ID_ATTRS.map((a) => `[${a}="${CSS.escape(fp.testId!)}"]`).join(","))]);
  if (fp.id) votes.push(["id", queryAll(root, `#${CSS.escape(fp.id)}`)]);
  if (fp.role && fp.name) votes.push(["roleName", byRoleAndName(root, fp.role, fp.name)]);
  if (fp.css) votes.push(["css", queryAll(root, fp.css)]);
  if (fp.xpath && !within) votes.push(["xpath", xpathAll(fp.xpath)]);
  if (fp.href) votes.push(["href", queryAll(root, "a[href]").filter((a) => (a as HTMLAnchorElement).href === fp.href)]);

  const scores = new Map<Element, { score: number; strategies: Strategy[] }>();
  const tally = (strategy: Strategy, els: Element[]) => {
    const visible = els.filter(isVisible);
    for (const el of visible) {
      const entry = scores.get(el) ?? { score: 0, strategies: [] };
      entry.score += WEIGHTS[strategy] / visible.length;
      entry.strategies.push(strategy);
      scores.set(el, entry);
    }
  };
  for (const [strategy, els] of votes) tally(strategy, els);
  if (scores.size === 0 && fp.text) {
    const want = norm(fp.text);
    tally("text", queryAll(root, INTERACTIVE_SELECTOR).filter((el) => norm(clean(textOf(el))) === want));
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
  if (ranked.length === 0) fail(`no visible element matches ${describe(fp)}`);
  if (ranked.length > 1 && ranked[0][1].score - ranked[1][1].score < 1e-9) {
    fail(`${describe(fp)} is ambiguous: ${ranked.filter((r) => r[1].score === ranked[0][1].score).length} equally good matches`);
  }
  return { el: ranked[0][0], strategies: ranked[0][1].strategies };
}

function fail(message: string): never {
  throw new ResolveError(message);
}

function describe(fp: Locator["fingerprint"]): string {
  const name = fp.name ?? fp.text;
  return name ? `${fp.role ?? "element"} "${name}"` : (fp.css ?? fp.xpath ?? "element");
}

/** Scrolls the element into view and returns its center in viewport CSS pixels for a CDP click. */
function locate(el: Element) {
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
    fail(`element is covered by ${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ""}`);
  }
  return { x, y };
}

function editableValue(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value;
  return (el as HTMLElement).innerText;
}

/** Sets a value the way frameworks like React notice: native setter, then input/change events. */
function setValue(el: Element, value: string) {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const proto = Object.getPrototypeOf(el);
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  } else if ((el as HTMLElement).isContentEditable) {
    (el as HTMLElement).innerText = value;
  } else fail("element is not editable");
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function extractList(req: Extract<ExecRequest, { type: "exec/extractList" }>): ListItem[] {
  const root: ParentNode = req.container ? resolve(req.container).el : document;
  return queryAll(root, req.itemSelector).map((item, i) => {
    const out: ListItem = { _index: i, _selector: structuralPath(item) };
    for (const [name, field] of Object.entries(req.fields)) {
      const el = field.selector ? item.querySelector(field.selector) : item;
      out[name] = el ? (field.attr ? readAttr(el, field.attr) : textOf(el)) : "";
    }
    return out;
  });
}

export function handleExec(req: ExecRequest, lastCopied: () => { value: string; ts: number } | null): unknown {
  switch (req.type) {
    case "exec/locate":
      return locate(resolve(req.locator).el);
    case "exec/prepareFill": {
      const { el } = resolve(req.locator);
      const point = locate(el);
      (el as HTMLElement).focus();
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
      else if ((el as HTMLElement).isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      } else if (!(el instanceof HTMLSelectElement)) fail("element is not editable");
      return { ...point, isSelect: el instanceof HTMLSelectElement };
    }
    case "exec/readValue":
      return { value: editableValue(resolve(req.locator).el) };
    case "exec/setValue":
      setValue(resolve(req.locator).el, req.value);
      return null;
    case "exec/focus":
      (resolve(req.locator).el as HTMLElement).focus();
      return null;
    case "exec/probe":
      try {
        const { el } = resolve(req.locator);
        const textMatched =
          req.textIncludes === undefined ? undefined : ((el as HTMLElement).innerText ?? el.textContent ?? "").includes(req.textIncludes);
        return { found: true, text: textOf(el), textMatched };
      } catch (err) {
        return { found: false, error: (err as Error).message };
      }
    case "exec/extract": {
      const { el } = resolve(req.locator);
      return req.attr ? readAttr(el, req.attr) : textOf(el);
    }
    case "exec/extractList":
      return extractList(req);
    case "exec/lastCopied":
      return lastCopied();
    case "exec/snapshot":
      return pageInventory();
  }
}
