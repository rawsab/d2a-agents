import type { Condition, Fingerprint, RecordedEvent, SemanticStep, Step, Target, Workflow } from "@d2a/shared";
import type { CompiledWorkflow, InnerStep, TargetRef, TopStep } from "./schema.js";

type Ctx = {
  steps: Map<string, SemanticStep>;
  recorded: RecordedEvent[];
  tabs: Set<string>;
  /** Field names of each extracted list, for checking {{item.field}} templates. */
  listFields: Map<string, Set<string>>;
  errors: string[];
};

/** Variables in scope at a point in the workflow; loop items map to their field names. */
type Scope = { vars: Set<string>; items: Map<string, Set<string>> };

const ITEM_META_FIELDS = ["_index", "_selector"];

function nonNull<T extends object>(obj: T): Partial<{ [K in keyof T]: NonNullable<T[K]> }> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)) as never;
}

function inventoryOf(step: SemanticStep, recorded: RecordedEvent[]) {
  return step.events.map((i) => recorded[i]?.inventory).find(Boolean);
}

function recordedTarget(step: SemanticStep): Fingerprint | undefined {
  return "target" in step ? step.target : undefined;
}

function resolveTarget(ref: TargetRef, where: string, loopItem: string | undefined, ctx: Ctx): Target | undefined {
  let fingerprint: Fingerprint | undefined;
  if (ref.fromStep != null) {
    const step = ctx.steps.get(ref.fromStep);
    if (!step) {
      ctx.errors.push(`${where}: fromStep "${ref.fromStep}" is not a recorded step`);
      return undefined;
    }
    if (ref.inventoryIndex != null) {
      const inventory = inventoryOf(step, ctx.recorded);
      const item = inventory?.[ref.inventoryIndex];
      if (!item) {
        ctx.errors.push(`${where}: step ${ref.fromStep} has no inventory entry ${ref.inventoryIndex}`);
        return undefined;
      }
      fingerprint = item.fingerprint;
    } else {
      fingerprint = recordedTarget(step);
      if (!fingerprint) {
        ctx.errors.push(`${where}: recorded step ${ref.fromStep} (${step.kind}) has no target element; use inventoryIndex or role/name/css`);
        return undefined;
      }
    }
  }
  // Explicit role/name/css refine a recorded fingerprint, or describe a new element.
  const explicit = nonNull({ role: ref.role, name: ref.name, css: ref.css });
  fingerprint = { ...fingerprint, ...explicit };
  if (!fingerprint.role && !fingerprint.name && !fingerprint.css && !fingerprint.xpath && !fingerprint.testId && !fingerprint.id) {
    ctx.errors.push(`${where}: target "${ref.description}" gives no way to find the element`);
    return undefined;
  }
  if (ref.withinItem && !loopItem) {
    ctx.errors.push(`${where}: target "${ref.description}" has withinItem but is not inside a forEach`);
    return undefined;
  }
  const source = ref.fromStep != null ? { step: ref.fromStep, ...(ref.inventoryIndex != null ? { inventoryIndex: ref.inventoryIndex } : {}) } : undefined;
  return { description: ref.description, fingerprint, ...(ref.withinItem ? { within: loopItem } : {}), ...(source ? { source } : {}) };
}

/** Checks {{path}} references against the variables defined so far. */
function checkTemplate(template: string, where: string, scope: Scope, ctx: Ctx) {
  for (const [, path] of template.matchAll(/\{\{\s*([\w$.]+)\s*\}\}/g)) {
    const [head, field, ...rest] = path.split(".");
    if (head === "vars") {
      if (!field || !scope.vars.has(field)) ctx.errors.push(`${where}: {{${path}}} refers to an undefined variable`);
    } else if (scope.items.has(head)) {
      const fields = scope.items.get(head)!;
      if (!field || rest.length || !fields.has(field)) {
        ctx.errors.push(`${where}: {{${path}}}: "${head}" items have fields ${[...fields].join(", ")}`);
      }
    } else if (!scope.vars.has(head) || field) {
      ctx.errors.push(`${where}: {{${path}}} refers to an undefined variable`);
    }
  }
}

function need<T>(value: T | null | undefined, field: string, where: string, ctx: Ctx): T | undefined {
  if (value === null || value === undefined || value === "") {
    ctx.errors.push(`${where}: "${field}" is required`);
    return undefined;
  }
  return value;
}

/** Text without a target is looked for anywhere on the page. */
const WHOLE_PAGE: Target = { description: "the page", fingerprint: { css: "body" } };

function convertCondition(c: NonNullable<InnerStep["until"]>, where: string, loopItem: string | undefined, scope: Scope, ctx: Ctx) {
  const out: Condition = {};
  if (c.target) out.target = resolveTarget(c.target, where, loopItem, ctx);
  else if (c.textIncludes) out.target = WHOLE_PAGE;
  if (c.textIncludes) {
    checkTemplate(c.textIncludes, where, scope, ctx);
    out.textIncludes = c.textIncludes;
  }
  if (c.urlMatches) out.urlMatches = c.urlMatches;
  return out;
}

function convertStep(s: InnerStep | TopStep, scope: Scope, loopItem: string | undefined, ctx: Ctx): Step | undefined {
  const where = `step ${s.id} (${s.kind})`;
  const basedOn = s.basedOn.filter((id) => ctx.steps.has(id));
  const base = { id: s.id, ...(s.tab && s.kind !== "switchTab" ? { tab: s.tab } : {}), ...(basedOn.length ? { basedOn } : {}) };
  if (s.tab && !ctx.tabs.has(s.tab)) ctx.errors.push(`${where}: tab "${s.tab}" is not declared in tabs`);
  const target = (ref: TargetRef | null | undefined, field = "target") => {
    const r = need(ref, field, where, ctx);
    return r && resolveTarget(r, where, loopItem, ctx);
  };
  const template = (value: string | null | undefined, field: string) => {
    const v = need(value, field, where, ctx);
    if (v !== undefined) checkTemplate(v, where, scope, ctx);
    return v;
  };

  switch (s.kind) {
    case "navigate": {
      const url = template(s.url, "url");
      return url === undefined ? undefined : { ...base, kind: "navigate", url };
    }
    case "switchTab": {
      const role = need(s.tab, "tab", where, ctx);
      if (s.url) checkTemplate(s.url, where, scope, ctx);
      return role === undefined ? undefined : { ...base, kind: "switchTab", role, ...(s.url ? { url: s.url } : {}) };
    }
    case "openTab": {
      const role = need(s.tab, "tab", where, ctx);
      const url = template(s.url, "url");
      return role === undefined || url === undefined ? undefined : { ...base, kind: "openTab", role, url };
    }
    case "closeTab": {
      const role = need(s.tab, "tab", where, ctx);
      return role === undefined ? undefined : { ...base, kind: "closeTab", role };
    }
    case "click": {
      const t = target(s.target);
      const until = s.until ? convertCondition(s.until, where, loopItem, scope, ctx) : undefined;
      if (s.opensTab && !ctx.tabs.has(s.opensTab)) ctx.errors.push(`${where}: opensTab "${s.opensTab}" is not declared in tabs`);
      return t && { ...base, kind: "click", target: t, ...(until ? { until } : {}), ...(s.opensTab ? { opensTab: s.opensTab } : {}) };
    }
    case "fill": {
      const t = target(s.target);
      const value = template(s.value, "value");
      return t && value !== undefined ? { ...base, kind: "fill", target: t, value } : undefined;
    }
    case "press": {
      const key = need(s.key, "key", where, ctx);
      const t = s.target ? resolveTarget(s.target, where, loopItem, ctx) : undefined;
      return key === undefined ? undefined : { ...base, kind: "press", key, ...(t ? { target: t } : {}) };
    }
    case "waitFor": {
      if (!s.target && !s.textIncludes && !s.urlMatches) ctx.errors.push(`${where}: needs a target, textIncludes or urlMatches`);
      const t = s.target ? resolveTarget(s.target, where, loopItem, ctx) : s.textIncludes ? WHOLE_PAGE : undefined;
      if (s.textIncludes) checkTemplate(s.textIncludes, where, scope, ctx);
      return {
        ...base,
        kind: "waitFor",
        ...(t ? { target: t } : {}),
        ...nonNull({ textIncludes: s.textIncludes, urlMatches: s.urlMatches, timeoutMs: s.timeoutMs }),
      };
    }
    case "extract": {
      const name = need(s.name, "name", where, ctx);
      const t = target(s.target);
      if (name) scope.vars.add(name);
      return name && t ? { ...base, kind: "extract", name, target: t, ...nonNull({ attr: s.attr }) } : undefined;
    }
    case "extractList": {
      const name = need(s.name, "name", where, ctx);
      const itemSelector = need(s.itemSelector, "itemSelector", where, ctx);
      const fields = need(s.fields?.length ? s.fields : null, "fields", where, ctx);
      const container = s.container ? resolveTarget(s.container, where, loopItem, ctx) : undefined;
      if (!name || !itemSelector || !fields) return undefined;
      scope.vars.add(name);
      ctx.listFields.set(name, new Set([...fields.map((f) => f.name), ...ITEM_META_FIELDS]));
      return {
        ...base,
        kind: "extractList",
        name,
        itemSelector,
        fields: Object.fromEntries(fields.map((f) => [f.name, nonNull({ selector: f.selector, attr: f.attr })])),
        ...(container ? { container } : {}),
      };
    }
    case "copyFromClipboard": {
      const name = need(s.name, "name", where, ctx);
      if (name) scope.vars.add(name);
      return name ? { ...base, kind: "copyFromClipboard", name } : undefined;
    }
    case "assert": {
      const condition = need(s.condition, "condition", where, ctx);
      const t = s.target ? resolveTarget(s.target, where, loopItem, ctx) : undefined;
      return condition ? { ...base, kind: "assert", condition, ...(t ? { target: t } : {}) } : undefined;
    }
    case "forEach": {
      const top = s as TopStep;
      const list = need(top.list, "list", where, ctx);
      const as = need(top.as, "as", where, ctx);
      const body = need(top.body?.length ? top.body : null, "body", where, ctx);
      if (!list || !as || !body) return undefined;
      const fields = ctx.listFields.get(list);
      if (!fields) ctx.errors.push(`${where}: "${list}" must be collected by an earlier extractList`);
      const inner: Scope = { vars: new Set(scope.vars), items: new Map(scope.items).set(as, fields ?? new Set()) };
      const steps = body.map((b) => convertStep(b, inner, as, ctx)).filter((b): b is Step => b !== undefined);
      return { ...base, kind: "forEach", list, as, body: steps };
    }
  }
}

/**
 * A click that opened or revealed something in the recording, followed by a step on an element in
 * the same tab, gets `until: <that element>`, so the runner retries it if the page ignored it
 * (common while a page is still loading). Done here, deterministically, rather than relying on
 * the model to add it.
 */
function addClickRetries(compiled: (InnerStep | TopStep)[], converted: Step[], ctx: Ctx) {
  compiled.forEach((source, i) => {
    const step = converted[i];
    const next = converted[i + 1];
    if (step?.kind === "forEach" && source.kind === "forEach") addClickRetries((source as TopStep).body ?? [], step.body, ctx);
    if (step?.kind !== "click" || step.until || step.opensTab || !next) return;
    const recordedId = source.basedOn[0] ?? source.target?.fromStep;
    const effect = recordedId ? ctx.steps.get(recordedId)?.effect : undefined;
    if (!effect || !(effect.opened.length || effect.expandedChanged)) return;
    if ((next.tab ?? step.tab) !== step.tab || ["switchTab", "openTab", "closeTab", "navigate"].includes(next.kind)) return;
    const target = "target" in next ? next.target : undefined;
    if (target) step.until = { target };
  });
}

export type ConvertResult = { workflow: Workflow; errors: string[] };

/** Turns Claude's output into a Workflow, collecting every problem so one repair round can fix them all. */
export function toWorkflow(
  compiled: CompiledWorkflow,
  source: { steps: SemanticStep[]; recorded: RecordedEvent[] },
  meta: { id: string; recordingId: string; instruction: string },
): ConvertResult {
  const ctx: Ctx = {
    steps: new Map(source.steps.map((s) => [s.id, s])),
    recorded: source.recorded,
    tabs: new Set(compiled.tabs.map((t) => t.role)),
    errors: [],
    listFields: new Map(),
  };
  const tabs: Workflow["tabs"] = {};
  for (const t of compiled.tabs) {
    if (t.startUrl != null && !/^https?:\/\//.test(t.startUrl)) ctx.errors.push(`tab "${t.role}": startUrl must be an absolute http(s) URL`);
    tabs[t.role] = t.startUrl != null ? { startUrl: t.startUrl } : {};
  }
  if (compiled.tabs.length === 0) ctx.errors.push("declare at least one tab");
  const scope: Scope = { vars: new Set(), items: new Map() };
  const seen = new Set<string>();
  const walk = (s: InnerStep | TopStep) => {
    if (seen.has(s.id)) ctx.errors.push(`step id "${s.id}" is used more than once`);
    seen.add(s.id);
    if (s.kind === "forEach") (s as TopStep).body?.forEach(walk);
  };
  compiled.steps.forEach(walk);
  const converted = compiled.steps.map((s) => convertStep(s, scope, undefined, ctx));
  const steps = converted.filter((s): s is Step => s !== undefined);
  if (steps.length === 0) ctx.errors.push("the workflow has no steps");
  // Positions only line up when every step converted; with errors the workflow goes back for repair anyway.
  if (ctx.errors.length === 0) addClickRetries(compiled.steps, steps, ctx);
  return {
    workflow: {
      id: meta.id,
      name: compiled.name,
      recordingId: meta.recordingId,
      instruction: meta.instruction,
      tabs,
      steps,
      ...(compiled.closePopups ? { closePopups: true } : {}),
    },
    errors: ctx.errors,
  };
}

function toRef(t: Target): TargetRef {
  const { role, name, css } = t.fingerprint;
  return {
    description: t.description,
    fromStep: t.source?.step ?? null,
    inventoryIndex: t.source?.inventoryIndex ?? null,
    role: role ?? null,
    name: name ?? null,
    css: css ?? null,
    withinItem: Boolean(t.within),
  };
}

const isWholePage = (t: Target | undefined) => Boolean(t && t.fingerprint.css === WHOLE_PAGE.fingerprint.css && !t.source);

function toCompiledStep(step: Step): TopStep {
  const out: TopStep = { id: step.id, kind: step.kind, basedOn: step.basedOn ?? [], tab: step.tab ?? null };
  switch (step.kind) {
    case "navigate":
      return { ...out, url: step.url };
    case "switchTab":
      return { ...out, tab: step.role, url: step.url ?? null };
    case "openTab":
      return { ...out, tab: step.role, url: step.url };
    case "closeTab":
      return { ...out, tab: step.role };
    case "click": {
      const until = step.until && {
        target: step.until.target && !isWholePage(step.until.target) ? toRef(step.until.target) : null,
        textIncludes: step.until.textIncludes ?? null,
        urlMatches: step.until.urlMatches ?? null,
      };
      return { ...out, target: toRef(step.target), until: until ?? null, opensTab: step.opensTab ?? null };
    }
    case "fill":
      return { ...out, target: toRef(step.target), value: step.value };
    case "press":
      return { ...out, key: step.key, target: step.target ? toRef(step.target) : null };
    case "waitFor":
      return {
        ...out,
        target: step.target && !isWholePage(step.target) ? toRef(step.target) : null,
        textIncludes: step.textIncludes ?? null,
        urlMatches: step.urlMatches ?? null,
        timeoutMs: step.timeoutMs ?? null,
      };
    case "extract":
      return { ...out, name: step.name, target: toRef(step.target), attr: step.attr ?? null };
    case "extractList":
      return {
        ...out,
        name: step.name,
        itemSelector: step.itemSelector,
        container: step.container ? toRef(step.container) : null,
        fields: Object.entries(step.fields).map(([name, f]) => ({ name, selector: f.selector ?? null, attr: f.attr ?? null })),
      };
    case "copyFromClipboard":
      return { ...out, name: step.name };
    case "assert":
      return { ...out, condition: step.condition, target: step.target ? toRef(step.target) : null };
    case "forEach":
      return { ...out, list: step.list, as: step.as, body: step.body.map((s) => toCompiledStep(s) as InnerStep) };
  }
}

/**
 * The reverse of toWorkflow: a workflow (possibly edited by hand) in the compiler's answer format,
 * so Claude can be shown the current version. Targets map back to their recorded step where known;
 * other locator parts that format can't express (test ids, hrefs) are dropped.
 */
export function toCompiled(workflow: Workflow): CompiledWorkflow {
  const notes = workflow.notes;
  return {
    name: workflow.name,
    summary: notes?.summary ?? "",
    tabs: Object.entries(workflow.tabs).map(([role, t]) => ({ role, startUrl: t.startUrl ?? null })),
    closePopups: Boolean(workflow.closePopups),
    steps: workflow.steps.map(toCompiledStep),
    excludedSteps: notes?.excludedSteps ?? [],
    assumptions: notes?.assumptions ?? [],
    questions: notes?.questions ?? [],
  };
}
