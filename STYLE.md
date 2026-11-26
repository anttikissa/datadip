# Style

Clean, native-feeling macOS developer tool aesthetic: calm neutral
surfaces, crisp hairlines, generous whitespace, and zero webfont lag.

## App icon

- Production icon (`public/icon.svg` / `public/icon-1024.png`).
- The dev environment's icon adds an orange ring, `oklch(0.72 0.17 55)`
  (`#f3821d`), so a dev tab never passes for production
  (`public/icon-dev.svg`).
- PNG sizes: 32 (favicon), 180 (Apple touch), 192 and 512 (manifest),
  1024 (macOS `.icns`).

## Palette

- Light theme (default):
  - Canvas: `#f7f7f8`
  - Surface: `#ffffff`
  - Subtle / elevated: `#f0f1f4`
  - Border / hairline: `rgba(17, 24, 39, 0.08)` (subtle) / `rgba(17, 24, 39, 0.14)` (strong)
  - Primary ink: `#141518`
  - Secondary ink: `#5a606c`
  - Muted ink: `#888e9b`
  - Accent: `#2563eb` (hover `#1d4ed8`)
  - Foreign Key link: `#1d4ed8` (tint `rgba(37, 99, 235, 0.08)`)
  - Production alert: `#dc2626` (tint `#fef2f2`)
  - Write-armed warning: `#b45309` (tint `#fef3c7`)
  - Staged edit highlight: `#fef9c3` (border `#d97706`)
- Dark theme:
  - Canvas: `#0e0f12`
  - Surface: `#15171c`
  - Subtle / elevated: `#1d2027`
  - Border / hairline: `rgba(255, 255, 255, 0.08)` (subtle) / `rgba(255, 255, 255, 0.14)` (strong)
  - Primary ink: `#eef0f4` (lighter weight `350` for dark-on-light irradiation balance)
  - Secondary ink: `#9ca3b0`
  - Accent: `#6095ff`
  - Production alert: `#f87171` (tint `#2a1215`)
  - Write-armed warning: `#fbbf24` (tint `#291e0b`)

## Typography & Geometry

- UI font: `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif` (offline-ready native system UI).
- Data & SQL font: `'Berkeley Mono', 'SF Mono', ui-monospace, Menlo, monospace` with `font-variant-numeric: tabular-nums`.
- Shape family: modern macOS rounded (`6px` buttons/inputs/sidebar items, `10px` cards/popovers, `12px` modals/command palettes, `999px` badges/pills; `0px` on spreadsheet grid cells).
- Motion: `150ms cubic-bezier(0.23, 1, 0.32, 1)` transitions on hover/press (`scale(0.98)` on active buttons) and modal fade/scale entry; respects `prefers-reduced-motion`.
- Focus: `:focus-visible` only, `2px solid var(--accent)` with `outline-offset: 2px`.
- Marks: crisp 16px stroke SVGs centered in their viewBox.
