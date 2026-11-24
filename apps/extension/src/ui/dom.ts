import { type IconNode, Moon, Sun, createElement } from "lucide";

/** Small DOM helpers shared by the side panel and the editor. */

export type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;
export type Child = Node | string | false | null | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | string = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(typeof attrs === "string" ? { class: attrs } : attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") e.addEventListener(k.replace(/^on/, ""), v);
    else if (k === "class") e.className = String(v);
    else if (k in e && typeof (e as unknown as Record<string, unknown>)[k] !== "object") (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== false && c !== null && c !== undefined) e.append(c);
  return e;
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const icon = (node: IconNode) => createElement(node, { class: "lucide", "aria-hidden": "true" });

export function iconButton(node: IconNode, label: string, onClick: (e: Event) => void, cls = "icon-btn small"): HTMLButtonElement {
  return h("button", { class: cls, type: "button", "aria-label": label, title: label, onclick: onClick }, icon(node));
}

/** A short message at the bottom of the page, with an optional action such as Undo. Needs a #toasts element. */
export function toast(message: string, opts: { action?: { label: string; run: () => void }; bad?: boolean } = {}) {
  const el = h("div", { class: `toast ${opts.bad ? "bad" : ""}`, role: "status" }, h("span", {}, message));
  const dismiss = () => el.remove();
  if (opts.action) {
    const { label, run } = opts.action;
    el.append(h("button", { class: "btn small", type: "button", onclick: () => (run(), dismiss()) }, label));
  }
  $("toasts").append(el);
  setTimeout(dismiss, opts.bad ? 8000 : 5000);
}

// ---- Theme: dark by default, shared by every extension page ----

type Theme = "dark" | "light";
const THEME_KEY = "d2a-theme";

function storedTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/**
 * Applies the stored theme and makes `button` toggle it. Other open extension pages follow the
 * change, since they share the same storage.
 */
export function setUpTheme(button: HTMLElement) {
  const apply = (theme: Theme) => {
    document.documentElement.dataset.theme = theme;
    button.replaceChildren(icon(theme === "dark" ? Sun : Moon));
    const label = `Switch to ${theme === "dark" ? "light" : "dark"} theme`;
    button.setAttribute("aria-label", label);
    button.title = label;
  };
  apply(storedTheme());
  button.onclick = () => {
    const next: Theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    apply(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Not remembered; the theme still applies on this page.
    }
  };
  addEventListener("storage", (e) => {
    if (e.key === THEME_KEY) apply(storedTheme());
  });
}
