import { describe, expect, it } from "vitest";
import { render } from "./template.js";

describe("render", () => {
  const scope = { vars: { link: "https://youtu.be/x" }, link: "https://youtu.be/x", video: { title: "One", _index: 0 } };

  it("fills variables, item fields and shorthand names", () => {
    expect(render("{{vars.link}}", scope)).toBe("https://youtu.be/x");
    expect(render("Queued {{ link }} for {{video.title}} #{{video._index}}", scope)).toBe("Queued https://youtu.be/x for One #0");
  });

  it("fails loudly on unknown variables instead of typing 'undefined'", () => {
    expect(() => render("{{video.missing}}", scope)).toThrow("unknown variable {{video.missing}}");
  });
});
