import type { Workflow } from "@d2a/shared";

/**
 * Hand-written workflow for the fixture site: for every playlist item, copy its share link and
 * submit it to the downloader. Two targets carry deliberately stale CSS so role+name must win.
 */
export function fixtureWorkflow(origin: string, playlistQuery = "", downloaderQuery = ""): Workflow {
  const status = { description: "status message", fingerprint: { role: "status", css: "#status" } };
  const copy = { description: "Copy button", fingerprint: { role: "button", name: "Copy", css: "#copy" } };
  return {
    id: "fixture-playlist-to-downloader",
    name: "Fixture: playlist → downloader",
    instruction: "Repeat for every video in the playlist",
    tabs: {
      playlist: { startUrl: `${origin}/list.html${playlistQuery}` },
      downloader: { startUrl: `${origin}/form.html${downloaderQuery}` },
    },
    steps: [
      { id: "s1", kind: "switchTab", role: "playlist" },
      {
        id: "s2",
        kind: "extractList",
        name: "videos",
        itemSelector: "#playlist .item",
        fields: { title: { selector: "a.title" }, url: { selector: "a.title", attr: "href" } },
      },
      {
        id: "s3",
        kind: "forEach",
        list: "videos",
        as: "video",
        body: [
          { id: "s3.1", kind: "switchTab", role: "playlist" },
          {
            id: "s3.2",
            kind: "click",
            target: { description: "this video's Share button", within: "video", fingerprint: { role: "button", name: "Share" } },
            until: { target: copy },
          },
          { id: "s3.3", kind: "click", target: copy },
          { id: "s3.4", kind: "copyFromClipboard", name: "link" },
          { id: "s3.5", kind: "switchTab", role: "downloader" },
          {
            id: "s3.6",
            kind: "fill",
            target: { description: "link field", fingerprint: { role: "textbox", name: "Paste link", css: "#stale-url-field" } },
            value: "{{link}}",
          },
          {
            id: "s3.7",
            kind: "click",
            target: { description: "Download button", fingerprint: { role: "button", name: "Download", css: "form > button.stale" } },
          },
          { id: "s3.8", kind: "waitFor", target: status, textIncludes: "Queued {{link}}" },
        ],
      },
    ],
  };
}

/** YouTube playlist (a watch URL with &list=) → a downloader page with the fixture form's fields. */
export function youtubeWorkflow(playlistUrl: string, downloaderUrl: string): Workflow {
  const share = { description: "Share button", fingerprint: { role: "button", name: "Share" } };
  const copy = { description: "Copy button", fingerprint: { role: "button", name: "Copy" } };
  return {
    id: "youtube-playlist-to-downloader",
    name: "YouTube playlist → downloader",
    tabs: { yt: { startUrl: playlistUrl }, downloader: { startUrl: downloaderUrl } },
    steps: [
      { id: "s1", kind: "switchTab", role: "yt" },
      { id: "s2", kind: "waitFor", target: share, timeoutMs: 20_000 },
      {
        id: "s3",
        kind: "extractList",
        name: "videos",
        itemSelector: "ytd-playlist-panel-renderer#playlist #items > ytd-playlist-panel-video-renderer",
        fields: { title: { selector: "#video-title" }, url: { selector: "a#wc-endpoint", attr: "href" } },
      },
      {
        id: "s4",
        kind: "forEach",
        list: "videos",
        as: "video",
        body: [
          { id: "s4.1", kind: "switchTab", role: "yt" },
          { id: "s4.2", kind: "navigate", url: "{{video.url}}" },
          // YouTube renders Share before its click handler is attached; `until` retries the click.
          { id: "s4.4", kind: "click", target: share, until: { target: copy } },
          { id: "s4.5", kind: "click", target: copy },
          { id: "s4.6", kind: "copyFromClipboard", name: "link" },
          { id: "s4.7", kind: "switchTab", role: "downloader" },
          { id: "s4.8", kind: "fill", target: { description: "link field", fingerprint: { role: "textbox", name: "Paste link" } }, value: "{{link}}" },
          { id: "s4.9", kind: "click", target: { description: "Download button", fingerprint: { role: "button", name: "Download" } } },
          {
            id: "s4.10",
            kind: "waitFor",
            target: { description: "status message", fingerprint: { role: "status", css: "#status" } },
            textIncludes: "Queued {{link}}",
          },
        ],
      },
    ],
  };
}

// `pnpm fixtures:workflow` saves the fixture workflow to the dev server (pointing at `pnpm fixtures`);
// `pnpm fixtures:workflow "<youtube watch URL with &list=>"` also saves the YouTube one.
if (import.meta.url === `file://${process.argv[1]}`) {
  const FIXTURES = "http://127.0.0.1:7822";
  const workflows = [fixtureWorkflow(FIXTURES)];
  if (process.argv[2]) workflows.push(youtubeWorkflow(process.argv[2], `${FIXTURES}/form.html`));
  for (const wf of workflows) {
    const res = await fetch("http://127.0.0.1:7821/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(wf),
    });
    console.log(res.ok ? `saved "${wf.name}"` : `failed to save "${wf.name}": ${await res.text()}`);
  }
}
