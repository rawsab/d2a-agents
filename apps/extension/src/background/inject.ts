/**
 * Injects the page-world clipboard hook and the recorder/executor content script into a tab.
 * Both are idempotent, so this is safe on tabs that already have them.
 */
export async function injectInto(tabId: number) {
  const files = chrome.runtime.getManifest().content_scripts?.flatMap((cs) => cs.js ?? []) ?? [];
  const target = { tabId };
  await chrome.scripting.executeScript({ target, files: ["mainworld.js"], world: "MAIN" });
  await chrome.scripting.executeScript({ target, files });
}

/** Declared content scripts only load into pages opened after the extension (re)loads. */
export async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.all(
    tabs.map((tab) =>
      tab.id === undefined
        ? undefined
        : injectInto(tab.id).catch(() => {
            // Pages extensions can't script (Chrome Web Store, PDF viewer, discarded tabs).
          }),
    ),
  );
}
