import { describe, expect, it } from "vitest";
import type { RawEvent, RecordedEvent } from "./events.js";
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
