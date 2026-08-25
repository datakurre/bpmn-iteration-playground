/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./graph_agent/templates/**/*.html",
    "./graph_agent/static/**/*.js",
    "./src/js/**/*.js"
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: 'var(--color-bg)',
        panel: 'var(--color-panel)',
        'panel-alt': 'var(--color-panel-alt)',
        'panel-header': 'var(--color-panel-header)',
        card: 'var(--color-card)',
        'card-hover': 'var(--color-card-hover)',
        line: 'var(--color-line)',
        'line-highlight': 'var(--color-line-highlight)',
        'line-subtle': 'var(--color-line-subtle)',
        ink: 'var(--color-ink)',
        'ink-secondary': 'var(--color-ink-secondary)',
        muted: 'var(--color-muted)',
        accent: {
          DEFAULT: 'var(--color-accent)',
          hover: 'var(--color-accent-hover)',
          dim: 'var(--color-accent-dim)',
          border: 'var(--color-accent-border)',
        },
        amber: {
          DEFAULT: 'var(--color-amber)',
          dim: 'var(--color-amber-dim)',
          border: 'var(--color-amber-border)',
        },
        danger: {
          DEFAULT: 'var(--color-danger)',
          dim: 'var(--color-danger-dim)',
          border: 'var(--color-danger-border)',
        },
        sky: {
          DEFAULT: 'var(--color-sky)',
          dim: 'var(--color-sky-dim)',
          border: 'var(--color-sky-border)',
        }
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'Oxygen', 'Ubuntu', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      borderRadius: {
        lg: '12px',
        md: '8px',
        sm: '6px',
      }
    },
  },
  plugins: [],
}
