import { describe, expect, it } from "vitest";
import type { Effect, RawEvent, RecordedEvent } from "./events.js";
import { describeStep, mergeEvents } from "./steps.js";

const YT = "https://www.youtube.com/watch?v=abc&list=PL1";
const DL = "https://downloader.example/";
const share = { role: "button", name: "Share", xpath: "/html/body/button[1]" };
const copyBtn = { role: "button", name: "Copy", xpath: "/html/body/div/button[2]" };
const urlField = { role: "textbox", name: "Paste link", xpath: "/html/body/form/input" };
const dlBtn = { role: "button", name: "Download", xpath: "/html/body/form/button" };

const rec = (events: RawEvent[]): RecordedEvent[] => events.map((event) => ({ event }));

describe("mergeEvents", () => {
  it("merges the playlist → downloader demonstration into semantic steps", () => {
    const steps = mergeEvents(
      rec([
        { type: "click", tabId: 1, url: YT, ts: 1000, target: share },
        { type: "click", tabId: 1, url: YT, ts: 2000, target: copyBtn },
        { type: "copy", tabId: 1, url: YT, ts: 2050, value: "https://youtu.be/abc" },
        { type: "tabActivated", tabId: 2, url: DL, ts: 3000 },
        { type: "click", tabId: 2, url: DL, ts: 3500, target: urlField },
        { type: "paste", tabId: 2, url: DL, ts: 3600, target: urlField, value: "https://youtu.be/abc" },
        { type: "input", tabId: 2, url: DL, ts: 3700, target: urlField, value: "https://youtu.be/abc", masked: false },
        { type: "click", tabId: 2, url: DL, ts: 4000, target: dlBtn },
        { type: "submit", tabId: 2, url: DL, ts: 4010, target: { role: "form", xpath: "/html/body/form" } },
        { type: "navigate", tabId: 2, url: `${DL}result`, ts: 4500, transitionType: "form_submit" },
      ]),
    );

    expect(steps.map((s) => s.kind)).toEqual(["click", "copy", "switchTab", "fill", "click"]);
    const [, copy, , fill, download] = steps;
    expect(copy).toMatchObject({ kind: "copy", value: "https://youtu.be/abc", target: copyBtn, events: [1, 2] });
    expect(fill).toMatchObject({ kind: "fill", value: "https://youtu.be/abc", fromStep: copy.id, events: [4, 5, 6] });
    expect(download.events).toEqual([7, 8, 9]);
    expect(describeStep(fill)).toBe(`Fill textbox "Paste link" with "https://youtu.be/abc" (copied in ${copy.id})`);
  });

  it("folds a new tab's activation and first navigation into openTab, linked to the click that opened it", () => {
    const link = { role: "link", name: "Open downloader", xpath: "/html/body/a" };
    const steps = mergeEvents(
      rec([
        { type: "click", tabId: 1, url: YT, ts: 100, target: link },
        { type: "tabCreated", tabId: 5, url: "", ts: 200, openerTabId: 1 },
        { type: "tabActivated", tabId: 5, url: "", ts: 210 },
        { type: "navigate", tabId: 5, url: DL, ts: 400, transitionType: "link" },
      ]),
    );
    expect(steps).toHaveLength(2);
    expect(steps[1]).toMatchObject({ kind: "openTab", url: DL, openedBy: steps[0].id, events: [1, 2, 3] });
  });

  it("keeps typed navigations but absorbs link navigations caused by a click", () => {
    const steps = mergeEvents(
      rec([
        { type: "navigate", tabId: 1, url: "https://a.example/", ts: 0, transitionType: "typed" },
        { type: "click", tabId: 1, url: "https://a.example/", ts: 1000, target: share },
        { type: "navigate", tabId: 1, url: "https://a.example/next", ts: 1200, transitionType: "link" },
        { type: "navigate", tabId: 1, url: "https://a.example/next2", ts: 9000, transitionType: "link" },
      ]),
    );
    expect(steps.map((s) => s.kind)).toEqual(["navigate", "click", "navigate"]);
    expect(steps[2].url).toBe("https://a.example/next2");
  });

  it("orders events by timestamp regardless of arrival order", () => {
    const steps = mergeEvents(
      rec([
        { type: "copy", tabId: 1, url: YT, ts: 2050, value: "x" },
        { type: "click", tabId: 1, url: YT, ts: 2000, target: copyBtn },
      ]),
    );
    expect(steps).toMatchObject([{ kind: "copy", value: "x", events: [1, 0] }]);
  });

  it("drops the clipboard link when the final value no longer contains the pasted text", () => {
    const steps = mergeEvents(
      rec([
        { type: "copy", tabId: 1, url: YT, ts: 0, value: "abc" },
        { type: "paste", tabId: 1, url: YT, ts: 10, target: urlField, value: "abc" },
        { type: "input", tabId: 1, url: YT, ts: 20, target: urlField, value: "typed instead", masked: false },
      ]),
    );
    expect(steps[1]).toMatchObject({ kind: "fill", value: "typed instead", fromStep: undefined });
  });
});

describe("noise annotation", () => {
  const quiet: Effect = {
    windowMs: 750, mutations: 0, baselineMutations: 0, requests: 0, baselineRequests: 0,
    urlChanged: false, focusMoved: false, expandedChanged: false, opened: [], closed: [], copied: false, unloaded: false,
  };
  const heading = { role: "heading", name: "Playlist", xpath: "/html/body/h1" };
  const blank = { xpath: "/html/body/div[3]" };
  const dialog = 'dialog "Share"';
  const fx = (actionId: string, ts: number, effect: Partial<Effect>): RawEvent => ({
    type: "effect", tabId: 1, url: YT, ts, actionId, effect: { ...quiet, ...effect },
  });

  it("flags clicks with no effect, more confidently on non-interactive areas", () => {
    const steps = mergeEvents(
      rec([
        { id: "a", type: "click", tabId: 1, url: YT, ts: 0, target: blank },
        fx("a", 750, {}),
        { id: "b", type: "click", tabId: 1, url: YT, ts: 1000, target: dlBtn }, // a real button that did nothing
        fx("b", 1750, { mutations: 2, baselineMutations: 2 }),
        { id: "h", type: "click", tabId: 1, url: YT, ts: 1500, target: heading },
        fx("h", 1900, {}),
        { id: "c", type: "click", tabId: 1, url: YT, ts: 2000, target: share },
        fx("c", 2750, { opened: [dialog], mutations: 12 }),
      ]),
    );
    expect(steps.map((s) => s.noise?.rule)).toEqual(["no-effect", "no-effect", "no-effect", undefined]);
    expect(steps[0].noise?.confidence).toBeGreaterThan(steps[1].noise!.confidence);
    expect(steps[2].noise?.confidence).toBe(steps[0].noise?.confidence); // headings aren't interactive either
    expect(steps[3].effect?.opened).toEqual([dialog]);
    expect(steps[3].events).toEqual([6, 7]);
  });

  it("counts a single change on a quiet page as an effect", () => {
    const steps = mergeEvents(
      rec([
        { id: "a", type: "click", tabId: 1, url: DL, ts: 0, target: dlBtn },
        fx("a", 750, { mutations: 1, requests: 1 }),
      ]),
    );
    expect(steps[0].noise).toBeUndefined();
  });

  it("compares DOM churn against the baseline before the click", () => {
    const steps = mergeEvents(
      rec([
        { id: "a", type: "click", tabId: 1, url: YT, ts: 0, target: share },
        fx("a", 750, { mutations: 40, baselineMutations: 38 }), // busy page (video playing), no real change
      ]),
    );
    expect(steps[0].noise?.rule).toBe("no-effect");
  });

  it("does not flag a click whose effect is a navigation or a copy", () => {
    const steps = mergeEvents(
      rec([
        { id: "a", type: "click", tabId: 1, url: YT, ts: 0, target: share },
        { type: "navigate", tabId: 1, url: `${YT}&index=2`, ts: 300, transitionType: "link" },
        fx("a", 750, { unloaded: true }),
        { id: "b", type: "click", tabId: 1, url: YT, ts: 2000, target: copyBtn },
        { type: "copy", tabId: 1, url: YT, ts: 2050, value: "x" },
        fx("b", 2750, { copied: true }),
      ]),
    );
    expect(steps.map((s) => [s.kind, s.noise?.rule])).toEqual([["click", undefined], ["copy", undefined]]);
    expect(steps[1].effect?.copied).toBe(true); // effect followed the click into the merged copy step
  });

  it("flags opening something and immediately dismissing it", () => {
    const steps = mergeEvents(
      rec([
        { id: "a", type: "click", tabId: 1, url: YT, ts: 0, target: share },
        fx("a", 750, { opened: [dialog] }),
        { id: "b", type: "keydown", tabId: 1, url: YT, ts: 1500, target: share, key: "Escape" },
        fx("b", 2250, { closed: [dialog] }),
        { id: "c", type: "click", tabId: 1, url: YT, ts: 3000, target: share },
        fx("c", 3750, { opened: [dialog] }),
        { id: "d", type: "click", tabId: 1, url: YT, ts: 4000, target: copyBtn },
        { type: "copy", tabId: 1, url: YT, ts: 4050, value: "x" },
        fx("d", 4750, { copied: true, closed: [dialog] }),
      ]),
    );
    expect(steps.map((s) => s.noise?.rule)).toEqual(["dismissed", "dismissed", undefined, undefined]);
  });

  it("flags rapid repeat clicks, detours, and glances at other tabs", () => {
    const steps = mergeEvents(
      rec([
        { type: "tabActivated", tabId: 1, url: YT, ts: 0 },
        { id: "a", type: "click", tabId: 1, url: YT, ts: 100, target: share },
        fx("a", 850, { opened: [dialog] }),
        { id: "b", type: "click", tabId: 1, url: YT, ts: 300, target: share },
        fx("b", 1050, {}),
        { type: "navigate", tabId: 1, url: "https://www.youtube.com/feed", ts: 2000, transitionType: "typed" },
        { type: "navigate", tabId: 1, url: YT, ts: 3000, transitionType: "link", transitionQualifiers: ["forward_back"] },
        { type: "tabActivated", tabId: 2, url: DL, ts: 4000 },
        { type: "tabActivated", tabId: 1, url: YT, ts: 5000 },
      ]),
    );
    expect(steps.map((s) => [s.kind, s.noise?.rule])).toEqual([
      ["switchTab", undefined],
      ["click", undefined],
      ["click", "no-effect"], // also a repeat; the first matching rule wins
      ["navigate", "detour"],
      ["navigate", "detour"],
      ["switchTab", "glance"],
      ["switchTab", "glance"],
    ]);
  });

  it("applies user overrides by the step's first event index", () => {
    const events = rec([
      { id: "a", type: "click", tabId: 1, url: YT, ts: 0, target: blank },
      fx("a", 750, {}),
      { id: "b", type: "click", tabId: 1, url: YT, ts: 1000, target: share },
      fx("b", 1750, { opened: [dialog] }),
    ]);
    const steps = mergeEvents(events, { "0": false, "2": true });
    expect(steps[0]).toMatchObject({ noise: undefined, keptByUser: true });
    expect(steps[1].noise).toMatchObject({ rule: "user" });
  });
});
