# Style

Utilitarian IBM Carbon-inspired technical aesthetic with a subtle Sequel
Pro nod in the app icon.

## App icon

- Machined steel disk platters stacked on a porcelain dish, topped with
  warm honey-amber glaze and a pat of butter (`public/icon.svg`).
- The dev environment's icon adds an orange ring, `oklch(0.72 0.17 55)`
  (`#f3821d`), so a dev tab never passes for production
  (`public/icon-dev.svg`).
- PNG sizes: 32 (favicon), 180 (Apple touch), 192 and 512 (manifest),
  1024 (macOS `.icns`).

## Palette

- Light theme (default):
  - Canvas: `#f4f5f7`
  - Surface: `#ffffff`
  - Elevated / subtle: `#eef0f3`
  - Border / hairline: `#cfd5de` (strong) / `#e1e5ec` (subtle)
  - Primary ink: `#161616`
  - Secondary ink: `#525866`
  - Accent (IBM Blue): `#0f62fe` (hover `#0353e9`)
  - Foreign Key link: `#0050e6`
  - Production alert: `#da1e28` (tint `#fff1f1`)
  - Write-armed warning: `#b25000` (tint `#fff4e5`)
  - Staged edit highlight: `#fff3cd` (border `#d97706`)
- Dark theme:
  - Canvas: `#111318`
  - Surface: `#181b22`
  - Elevated / subtle: `#222631`
  - Border / hairline: `#343a49` (strong) / `#262b37` (subtle)
  - Primary ink: `#eef1f6` (font weight 300 for body per dark-type rule)
  - Secondary ink: `#9aa3b2`
  - Accent: `#4589ff`
  - Production alert: `#fa4d56` (tint `#2d1216`)
  - Write-armed warning: `#ff832b` (tint `#2b1c0e`)

## Typography & Geometry

- UI font: `'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif`
- Data & SQL font: `'IBM Plex Mono', ui-monospace, 'SF Mono', monospace`
  with `font-variant-numeric: tabular-nums`.
- Shape family: sharp utilitarian (`2px` radius on buttons/inputs/cards,
  `0px` on grid cells; pills only for status badges).
- Focus: `:focus-visible` only, `2px solid var(--accent)` with
  `outline-offset: 1px`.
- Marks: crisp 16px stroke SVGs centered in their viewBox.
