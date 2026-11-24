/** Renders {{path}} placeholders: {{vars.x}}, {{video.url}} (a forEach item), or {{x}} for a variable. */
export function render(template: string, scope: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w$.]+)\s*\}\}/g, (_, path: string) => {
    const value = path.split(".").reduce<unknown>((obj, key) => (obj as Record<string, unknown> | undefined)?.[key], scope);
    if (value === undefined || value === null) throw new Error(`unknown variable {{${path}}}`);
    return String(value);
  });
}
