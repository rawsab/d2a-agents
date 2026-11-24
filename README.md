# d2a-agents

Demonstrate a browser task once, then let an agent repeat it. A Chrome extension records what you do, Claude turns the recording and your instruction (e.g. "repeat for every video in this playlist") into a workflow, and the extension replays that workflow in your browser.

Early work in progress.

```sh
pnpm install
pnpm dev:server                          # local server on 127.0.0.1:7821
pnpm --filter @d2a/extension build       # then load apps/extension/dist as an unpacked extension
```
