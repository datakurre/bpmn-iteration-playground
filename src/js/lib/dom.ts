export function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/**
 * Render `items` into `container` as joined HTML, or `empty` when there are none.
 *
 * Every page module fetches a list, maps it to a template string, joins, and assigns
 * `innerHTML` -- this is that one step, factored out so it isn't hand-rolled per page.
 * Event wiring (click handlers, delegation) stays with the caller: it differs enough
 * per list (confirm dialogs, different actions) that forcing one shape here would cost
 * more than the duplication it removes.
 */
export function renderList<T>(container: HTMLElement, items: T[], template: (item: T) => string, empty = ""): void {
  container.innerHTML = items.length ? items.map(template).join("") : empty;
}

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
