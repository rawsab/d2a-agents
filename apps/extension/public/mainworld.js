// Runs in the page's own JS world so it can see clipboard writes made by page code
// (e.g. a "Copy link" button). Forwards the copied text to the isolated-world recorder.
(() => {
  const clip = navigator.clipboard;
  if (!clip || clip.__d2aWrapped) return;
  const notify = (text) =>
    window.dispatchEvent(new CustomEvent("__d2a_clipboard", { detail: String(text) }));

  const writeText = clip.writeText.bind(clip);
  clip.writeText = (text) => {
    notify(text);
    return writeText(text);
  };

  const write = clip.write?.bind(clip);
  if (write) {
    clip.write = async (items) => {
      try {
        for (const item of items) {
          if (item.types.includes("text/plain")) notify(await (await item.getType("text/plain")).text());
        }
      } catch {}
      return write(items);
    };
  }
  Object.defineProperty(clip, "__d2aWrapped", { value: true });
})();
