import type { Step, Target, Workflow } from "./workflow.js";

export type WorkflowProblem = { stepId?: string; message: string };

const ITEM_META_FIELDS = ["_index", "_selector"];

type Scope = { vars: Set<string>; items: Map<string, Set<string>>; item?: string };

/**
 * Problems that would stop a workflow from running as intended: undeclared tabs, variables used
 * before they are set, loops over lists that aren't collected, missing required fields. Used by the
 * editor as you type and by the server before saving an edit.
 */
export function checkWorkflow(workflow: Workflow): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const tabs = new Set(Object.keys(workflow.tabs));
  const listFields = new Map<string, Set<string>>();
  const seen = new Set<string>();
  if (tabs.size === 0) problems.push({ message: "declare at least one tab" });
  if (workflow.steps.length === 0) problems.push({ message: "the workflow has no steps" });

  const walk = (steps: Step[], scope: Scope) => {
    for (const step of steps) {
      const add = (message: string) => problems.push({ stepId: step.id, message });
      if (seen.has(step.id)) add(`step id "${step.id}" is used more than once`);
      seen.add(step.id);
      const tab = (role: string | undefined, what = "tab") => {
        if (role !== undefined && !tabs.has(role)) add(`${what} "${role}" is not one of the workflow's tabs`);
      };
      const template = (value: string | undefined, field: string) => {
        for (const problem of templateProblems(value ?? "", scope)) add(`${field}: ${problem}`);
      };
      const target = (t: Target | undefined, field = "target") => {
        if (!t) return;
        const fp = t.fingerprint;
        if (!fp.role && !fp.name && !fp.css && !fp.xpath && !fp.testId && !fp.id && !fp.text && !fp.href) add(`${field} gives no way to find the element`);
        if (t.within && t.within !== scope.item) add(`${field} is looked up inside "${t.within}", which is not the current loop item`);
      };
      const required = (value: string | undefined, field: string) => {
        if (!value?.trim()) add(`${field} is required`);
      };
      tab(step.tab);

      switch (step.kind) {
        case "navigate":
          required(step.url, "url");
          template(step.url, "url");
          break;
        case "switchTab":
        case "closeTab":
          tab(step.role);
          if (step.kind === "switchTab") template(step.url, "url");
          break;
        case "openTab":
          tab(step.role);
          required(step.url, "url");
          template(step.url, "url");
          break;
        case "click":
          target(step.target);
          target(step.until?.target, "until");
          template(step.until?.textIncludes, "until text");
          tab(step.opensTab, "opensTab");
          break;
        case "fill":
          target(step.target);
          template(step.value, "value");
          break;
        case "press":
          required(step.key, "key");
          target(step.target);
          break;
        case "waitFor":
          if (!step.target && !step.textIncludes && !step.urlMatches) add("needs an element, text or URL pattern to wait for");
          target(step.target);
          template(step.textIncludes, "text");
          if (step.urlMatches) {
            try {
              new RegExp(step.urlMatches);
            } catch {
              add(`URL pattern "${step.urlMatches}" is not a valid regular expression`);
            }
          }
          break;
        case "extract":
          required(step.name, "name");
          target(step.target);
          scope.vars.add(step.name);
          break;
        case "extractList":
          required(step.name, "name");
          required(step.itemSelector, "item selector");
          if (Object.keys(step.fields).length === 0) add("collect at least one field");
          target(step.container, "container");
          scope.vars.add(step.name);
          listFields.set(step.name, new Set([...Object.keys(step.fields), ...ITEM_META_FIELDS]));
          break;
        case "copyFromClipboard":
          required(step.name, "name");
          scope.vars.add(step.name);
          break;
        case "assert":
          required(step.condition, "condition");
          target(step.target);
          break;
        case "forEach": {
          if (scope.item) add("loops can't be nested");
          required(step.as, "item name");
          const fields = listFields.get(step.list);
          if (!fields) add(`"${step.list}" isn't collected by an earlier "collect" step`);
          if (step.body.length === 0) add("the loop has no steps");
          walk(step.body, { vars: new Set(scope.vars), items: new Map(scope.items).set(step.as, fields ?? new Set()), item: step.as });
          break;
        }
      }
    }
  };
  walk(workflow.steps, { vars: new Set(), items: new Map() });
  return problems;
}

/** Problems with the {{...}} references in a template, given what is defined at that point. */
export function templateProblems(template: string, scope: { vars: Set<string>; items: Map<string, Set<string>> }): string[] {
  const problems: string[] = [];
  for (const [, path] of template.matchAll(/\{\{\s*([\w$.]+)\s*\}\}/g)) {
    const [head, field, ...rest] = path.split(".");
    if (head === "vars") {
      if (!field || !scope.vars.has(field)) problems.push(`{{${path}}} refers to a variable that isn't set before this step`);
    } else if (scope.items.has(head)) {
      const fields = scope.items.get(head)!;
      if (!field || rest.length || !fields.has(field)) {
        problems.push(`{{${path}}}: ${head} has the fields ${[...fields].filter((f) => !f.startsWith("_")).join(", ") || "(none)"}`);
      }
    } else if (!scope.vars.has(head) || field) {
      problems.push(`{{${path}}} refers to a variable that isn't set before this step`);
    }
  }
  return problems;
}
