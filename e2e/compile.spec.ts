import { expect, test } from "@playwright/test";
import { API, launch } from "./harness.js";
import { recordFixtureDemo } from "./demo.js";
import { startFixtureServer } from "../fixtures/server.js";

test("compiling without Claude credentials explains how to set them", async () => {
  test.skip(Boolean(process.env.ANTHROPIC_API_KEY), "credentials are set; the live test covers compiling");
  const fixture = await startFixtureServer();
  const env = await launch({ ANTHROPIC_API_KEY: "" });
  try {
    const recordingId = await recordFixtureDemo(env, fixture.origin);
    const res = await fetch(`${API}/recordings/${recordingId}/compile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "Repeat for every video in the playlist" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toContain("ANTHROPIC_API_KEY");
  } finally {
    await env.close();
    await fixture.close();
  }
});
