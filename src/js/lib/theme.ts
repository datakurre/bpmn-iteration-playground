export function updateThemeIcons(): void {
  const isDark = document.documentElement.classList.contains("dark");
  document.querySelectorAll<HTMLElement>(".theme-toggle-icon").forEach((el) => {
    el.textContent = isDark ? "☀️" : "🌙";
  });
  document.querySelectorAll<HTMLElement>(".theme-toggle-text").forEach((el) => {
    el.textContent = isDark ? "Light" : "Dark";
  });
}

export function toggleTheme(): void {
  const isDark = document.documentElement.classList.toggle("dark");
  localStorage.theme = isDark ? "dark" : "light";
  updateThemeIcons();
}

export function initMobileMenu(): void {
  const btn = document.getElementById("mobile-menu-btn");
  const menu = document.getElementById("mobile-menu");
  if (!btn || !menu) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target as Node) && !btn.contains(e.target as Node)) {
      menu.classList.add("hidden");
    }
  });
}

declare global {
  interface Window {
    toggleTheme: typeof toggleTheme;
  }
}
window.toggleTheme = toggleTheme;
