// The `.collapsed`-toggling accordion pattern used by dashboard/instance/history_detail
// (`app/static/common.js`'s `.hidden`+icon-rotate variant was dead code: every page that
// wired up `toggleAcc`/`handleAccKey` already redefined its own `.collapsed`-based version
// as a same-named global, which silently shadowed the common.js one at script-load time).

export function toggleAcc(headerOrId: string | HTMLElement): void {
  const header = typeof headerOrId === "string" ? document.getElementById(headerOrId) : headerOrId;
  if (!header) return;
  const isCollapsed = header.classList.toggle("collapsed");
  const body = header.nextElementSibling;
  if (body) body.classList.toggle("collapsed", isCollapsed);
}

export function handleAccKey(event: KeyboardEvent, el: HTMLElement): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    toggleAcc(el);
  }
}

declare global {
  interface Window {
    toggleAcc: typeof toggleAcc;
    handleAccKey: typeof handleAccKey;
  }
}
window.toggleAcc = toggleAcc;
window.handleAccKey = handleAccKey;
