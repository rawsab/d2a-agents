import type { Fingerprint, PageInventory, Step, Target, Workflow } from "@d2a/shared";

/** Editing operations on a workflow. Each returns a new workflow; the input is left untouched. */

export type StepKind = Step["kind"];

export const KIND_LABELS: Record<StepKind, string> = {
  navigate: "Go to URL",
  switchTab: "Switch tab",
  openTab: "Open tab",
  closeTab: "Close tab",
  click: "Click",
  fill: "Fill in",
  press: "Press key",
  waitFor: "Wait for",
  extract: "Read value",
  extractList: "Collect list",
  copyFromClipboard: "Take copied value",
  forEach: "Repeat for each",
  assert: "Check",
};

/** Where a step sits: its container, its position there, and the loop it is in, if any. */
export type Location = { container: Step[]; index: number; loop?: Extract<Step, { kind: "forEach" }> };

export function locate(steps: Step[], id: string, loop?: Location["loop"]): Location | undefined {
  for (const [index, step] of steps.entries()) {
    if (step.id === id) return { container: steps, index, loop };
    if (step.kind === "forEach") {
      const inner = locate(step.body, id, step);
      if (inner) return inner;
    }
  }
  return undefined;
}

function edit(workflow: Workflow, fn: (wf: Workflow) => void): Workflow {
  const copy = structuredClone(workflow);
  fn(copy);
  return copy;
}

export function allSteps(steps: Step[]): Step[] {
  return steps.flatMap((s) => (s.kind === "forEach" ? [s, ...allSteps(s.body)] : [s]));
}

/** A step id not used yet, e.g. "e3". */
export function newId(workflow: Workflow, prefix = "e"): string {
  const used = new Set(allSteps(workflow.steps).map((s) => s.id));
  for (let i = 1; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

/**
 * Moves a step one place up or down in reading order: past a neighbour, into an adjacent loop
 * (at its near end), or out of its loop at either end.
 */
export function moveStep(workflow: Workflow, id: string, dir: -1 | 1): Workflow {
  return edit(workflow, (wf) => {
    const loc = locate(wf.steps, id);
    if (!loc) return;
    const { container, index, loop } = loc;
    const step = container[index];
    const neighbour = container[index + dir];
    if (neighbour) {
      container.splice(index, 1);
      if (neighbour.kind === "forEach" && step.kind !== "forEach") {
        if (dir === -1) neighbour.body.push(step);
        else neighbour.body.unshift(step);
      } else {
        container.splice(index + dir, 0, step);
      }
      return;
    }
    if (!loop) return; // already first or last
    container.splice(index, 1);
    const outer = locate(wf.steps, loop.id)!;
    outer.container.splice(outer.index + (dir === 1 ? 1 : 0), 0, step);
  });
}

export function deleteStep(workflow: Workflow, id: string): Workflow {
  return edit(workflow, (wf) => {
    const loc = locate(wf.steps, id);
    loc?.container.splice(loc.index, 1);
  });
}

/** Inserts after the step `afterId`, or at the start of `loopId`'s body / of the workflow when afterId is null. */
export function insertStep(workflow: Workflow, step: Step, afterId: string | null, loopId?: string): Workflow {
  return edit(workflow, (wf) => {
    if (afterId) {
      const loc = locate(wf.steps, afterId);
      if (loc) return void loc.container.splice(loc.index + 1, 0, step);
    }
    const loop = loopId ? locate(wf.steps, loopId) : undefined;
    const target = loop?.container[loop.index];
    (target?.kind === "forEach" ? target.body : wf.steps).unshift(step);
  });
}

/** Appends at the end of a loop's body, or of the workflow. */
export function appendStep(workflow: Workflow, step: Step, loopId?: string): Workflow {
  return edit(workflow, (wf) => {
    const loop = loopId ? locate(wf.steps, loopId) : undefined;
    const target = loop?.container[loop.index];
    (target?.kind === "forEach" ? target.body : wf.steps).push(step);
  });
}

export function replaceStep(workflow: Workflow, step: Step): Workflow {
  return edit(workflow, (wf) => {
    const loc = locate(wf.steps, step.id);
    if (loc) loc.container[loc.index] = step;
  });
}

/** Names of the lists the workflow collects: what a loop can repeat over. */
export function listNames(workflow: Workflow): string[] {
  return allSteps(workflow.steps).flatMap((s) => (s.kind === "extractList" ? [s.name] : []));
}

/** A new step of a kind, with placeholder values the user fills in. */
export function blankStep(kind: StepKind, id: string, workflow: Workflow): Step {
  const role = Object.keys(workflow.tabs)[0] ?? "main";
  const element: Target = { description: "element", fingerprint: {} };
  switch (kind) {
    case "navigate":
      return { id, kind, url: "" };
    case "switchTab":
    case "closeTab":
      return { id, kind, role };
    case "openTab":
      return { id, kind, role, url: "" };
    case "click":
      return { id, kind, target: element };
    case "fill":
      return { id, kind, target: element, value: "" };
    case "press":
      return { id, kind, key: "Enter" };
    case "waitFor":
      return { id, kind, textIncludes: "" };
    case "extract":
      return { id, kind, name: "value", target: element };
    case "extractList":
      return { id, kind, name: "items", itemSelector: "", fields: { text: {} } };
    case "copyFromClipboard":
      return { id, kind, name: "copied" };
    case "assert":
      return { id, kind, condition: "" };
    case "forEach":
      return { id, kind, list: listNames(workflow)[0] ?? "", as: "item", body: [] };
  }
}

/**
 * The target for an element chosen in the picker. Inside a loop item only role/name-like parts are
 * kept, since positions and hrefs would tie the step to the item that was recorded.
 */
export function pickedTarget(
  element: PageInventory[number],
  source: { step: string; inventoryIndex: number },
  previous: Target | undefined,
  within: string | undefined,
): Target {
  const { role, name, testId, nameAttr, id, css, href, text } = element.fingerprint;
  const fingerprint: Fingerprint = within ? { role, name, testId, nameAttr, text } : { role, name, testId, nameAttr, id, css, href, text };
  for (const key of Object.keys(fingerprint) as (keyof Fingerprint)[]) if (fingerprint[key] === undefined) delete fingerprint[key];
  const keepDescription = previous && previous.description !== "element";
  return {
    description: keepDescription ? previous.description : `${name ?? role ?? element.tag}${role && name ? ` ${role}` : ""}`,
    fingerprint,
    ...(within ? { within } : {}),
    source,
  };
}

export type DiffStatus = "added" | "changed" | "unchanged";
export type StepDiff = { status: Map<string, DiffStatus>; removed: Step[]; before: Map<string, Step> };

/** Compares two versions step by step, matching steps by id. */
export function diffSteps(before: Step[], after: Step[]): StepDiff {
  const old = new Map(allSteps(before).map((s) => [s.id, s]));
  const now = allSteps(after);
  const status = new Map<string, DiffStatus>();
  // A loop counts as changed only for its own fields; its steps are compared on their own.
  const own = (s: Step) => JSON.stringify(s.kind === "forEach" ? { ...s, body: undefined } : s);
  for (const step of now) {
    const prev = old.get(step.id);
    status.set(step.id, !prev ? "added" : own(prev) === own(step) ? "unchanged" : "changed");
  }
  const kept = new Set(now.map((s) => s.id));
  return { status, removed: [...old.values()].filter((s) => !kept.has(s.id)), before: old };
}

/** Renames a tab role everywhere it is used. */
export function renameTab(workflow: Workflow, from: string, to: string): Workflow {
  return edit(workflow, (wf) => {
    wf.tabs = Object.fromEntries(Object.entries(wf.tabs).map(([role, t]) => [role === from ? to : role, t]));
    for (const step of allSteps(wf.steps) as (Step & { role?: string; opensTab?: string })[]) {
      if (step.tab === from) step.tab = to;
      if (step.role === from) step.role = to;
      if (step.opensTab === from) step.opensTab = to;
    }
  });
}

/** Template references available to a step: variables set before it, and its loop item's fields. */
export function templatesAt(workflow: Workflow, id: string): string[] {
  const out: string[] = [];
  const fields = new Map<string, string[]>();
  const walk = (steps: Step[], item?: string): boolean => {
    for (const step of steps) {
      if (step.id === id) {
        if (item) out.push(...(fields.get(item) ?? []).map((f) => `${item}.${f}`));
        return true;
      }
      if (step.kind === "extract" || step.kind === "copyFromClipboard") out.push(step.name);
      if (step.kind === "extractList") {
        out.push(step.name);
        fields.set(step.name, Object.keys(step.fields));
      }
      if (step.kind === "forEach") {
        fields.set(step.as, fields.get(step.list) ?? []);
        if (walk(step.body, step.as)) return true;
      }
    }
    return false;
  };
  walk(workflow.steps);
  return out;
}
