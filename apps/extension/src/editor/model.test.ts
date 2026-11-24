import { describe, expect, it } from "vitest";
import type { Step, Workflow } from "@d2a/shared";
import { blankStep, deleteStep, diffSteps, insertStep, moveStep, moveStepTo, newId, pickedTarget, renameTab, templatesAt } from "./model.js";

const s = (id: string): Step => ({ id, kind: "copyFromClipboard", name: id });
const wf = (steps: Step[]): Workflow => ({ id: "wf", name: "t", tabs: { main: {} }, steps });
const loop = (id: string, body: Step[]): Step => ({ id, kind: "forEach", list: "items", as: "item", body });
/** The workflow's shape as ids, loops as [id, [...body]]. */
const shape = (steps: Step[]): unknown[] => steps.map((x) => (x.kind === "forEach" ? [x.id, shape(x.body)] : x.id));

describe("moveStep", () => {
  const start = wf([s("a"), loop("L", [s("b"), s("c")]), s("d")]);

  it("swaps with a neighbour", () => {
    expect(shape(moveStep(start, "c", -1).steps)).toEqual(["a", ["L", ["c", "b"]], "d"]);
  });
  it("enters an adjacent loop at its near end", () => {
    expect(shape(moveStep(start, "a", 1).steps)).toEqual([["L", ["a", "b", "c"]], "d"]);
    expect(shape(moveStep(start, "d", -1).steps)).toEqual(["a", ["L", ["b", "c", "d"]]]);
  });
  it("leaves the loop at either end", () => {
    expect(shape(moveStep(start, "b", -1).steps)).toEqual(["a", "b", ["L", ["c"]], "d"]);
    expect(shape(moveStep(start, "c", 1).steps)).toEqual(["a", ["L", ["b"]], "c", "d"]);
  });
  it("moves a loop past steps without nesting it, and stops at the ends", () => {
    expect(shape(moveStep(start, "L", -1).steps)).toEqual([["L", ["b", "c"]], "a", "d"]);
    expect(shape(moveStep(start, "a", -1).steps)).toEqual(shape(start.steps));
  });
  it("leaves the original untouched", () => {
    moveStep(start, "b", 1);
    expect(shape(start.steps)).toEqual(["a", ["L", ["b", "c"]], "d"]);
  });
});

describe("insert and delete", () => {
  const start = wf([s("a"), loop("L", [s("b")])]);
  it("inserts after a step, at the start of a loop, or at the start of the workflow", () => {
    expect(shape(insertStep(start, s("x"), "b").steps)).toEqual(["a", ["L", ["b", "x"]]]);
    expect(shape(insertStep(start, s("x"), null, "L").steps)).toEqual(["a", ["L", ["x", "b"]]]);
    expect(shape(insertStep(start, s("x"), null).steps)).toEqual(["x", "a", ["L", ["b"]]]);
  });
  it("deletes steps inside loops, and loops with their steps", () => {
    expect(shape(deleteStep(start, "b").steps)).toEqual(["a", ["L", []]]);
    expect(shape(deleteStep(start, "L").steps)).toEqual(["a"]);
  });
  it("makes ids that aren't taken", () => {
    expect(newId(wf([s("e1"), loop("L", [s("e2")])]))).toBe("e3");
  });
  it("starts a new loop on the first collected list", () => {
    const w = wf([{ id: "c", kind: "extractList", name: "videos", itemSelector: "li", fields: { t: {} } }]);
    expect(blankStep("forEach", "e1", w)).toMatchObject({ list: "videos", as: "item", body: [] });
  });
});

describe("pickedTarget", () => {
  const el = { tag: "button", fingerprint: { role: "button", name: "Get it", css: "#list > li:nth-of-type(2) > button", bbox: { x: 1, y: 2, w: 3, h: 4 } } };
  it("keeps the locator parts and where the element was seen", () => {
    expect(pickedTarget(el, { step: "s3", inventoryIndex: 5 }, undefined, undefined)).toEqual({
      description: "Get it button",
      fingerprint: { role: "button", name: "Get it", css: "#list > li:nth-of-type(2) > button" },
      source: { step: "s3", inventoryIndex: 5 },
    });
  });
  it("inside a loop item drops positions, and keeps the user's description", () => {
    const prev = { description: "this video's Share button", fingerprint: { role: "button", name: "Share" } };
    expect(pickedTarget(el, { step: "s3", inventoryIndex: 5 }, prev, "video")).toEqual({
      description: "this video's Share button",
      fingerprint: { role: "button", name: "Get it" },
      within: "video",
      source: { step: "s3", inventoryIndex: 5 },
    });
  });
});

describe("diffSteps", () => {
  it("marks added and changed steps by id and lists removed ones", () => {
    const before = [s("a"), loop("L", [s("b"), s("c")])];
    const after = [loop("L", [{ id: "b", kind: "copyFromClipboard", name: "renamed" }, s("x")]), s("a")];
    const diff = diffSteps(before, after);
    expect(Object.fromEntries(diff.status)).toEqual({ L: "unchanged", b: "changed", x: "added", a: "unchanged" });
    expect(diff.removed.map((r) => r.id)).toEqual(["c"]);
  });
});

describe("tabs and templates", () => {
  const w: Workflow = {
    id: "wf", name: "t", tabs: { yt: {}, dl: {} },
    steps: [
      { id: "a", kind: "extractList", name: "videos", itemSelector: "li", fields: { title: {}, url: {} } },
      { id: "L", kind: "forEach", list: "videos", as: "video", body: [
        { id: "b", kind: "click", tab: "yt", target: { description: "x", fingerprint: { role: "button" } }, opensTab: "dl" },
        { id: "c", kind: "copyFromClipboard", name: "link" },
        { id: "d", kind: "switchTab", role: "dl" },
      ] },
    ],
  };
  it("renames a tab and every reference to it", () => {
    const r = renameTab(w, "dl", "downloader");
    expect(Object.keys(r.tabs)).toEqual(["yt", "downloader"]);
    expect(JSON.stringify(r.steps)).not.toContain('"dl"');
  });
  it("lists what a step can refer to", () => {
    expect(templatesAt(w, "d")).toEqual(["videos", "link", "video.title", "video.url"]);
    expect(templatesAt(w, "a")).toEqual([]);
  });
});

describe("moveStepTo", () => {
  const start = wf([s("a"), loop("L", [s("b"), s("c")]), s("d")]);
  it("drops a step before or after another, into and out of loops", () => {
    expect(shape(moveStepTo(start, "d", "b", "after").steps)).toEqual(["a", ["L", ["b", "d", "c"]]]);
    expect(shape(moveStepTo(start, "c", "a", "before").steps)).toEqual(["c", "a", ["L", ["b"]], "d"]);
  });
  it("keeps loops out of loops", () => {
    const two = wf([loop("L", [s("b")]), loop("M", [s("c")])]);
    expect(shape(moveStepTo(two, "M", "b", "before").steps)).toEqual([["M", ["c"]], ["L", ["b"]]]);
    expect(shape(moveStepTo(start, "L", "b", "after").steps)).toEqual(shape(start.steps));
  });
});
