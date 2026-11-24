import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "D2A Recorder",
  version: "0.0.1",
  description: "Demonstrate a browser task once; let an agent repeat it.",
  permissions: ["tabs", "scripting", "storage", "sidePanel", "debugger", "clipboardRead", "webNavigation"],
  host_permissions: ["<all_urls>"],
  background: { service_worker: "src/background/index.ts", type: "module" },
  side_panel: { default_path: "src/sidepanel/index.html" },
  action: { default_title: "D2A Recorder" },
  content_scripts: [
    { matches: ["<all_urls>"], js: ["src/content/index.ts"], run_at: "document_start", all_frames: false },
  ],
});
