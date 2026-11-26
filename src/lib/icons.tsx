// Crisp 16px utilitarian SVG icons centered in their viewBox, plus the DataDip mark.

const BRAND_GRID = [
	'....X.....X',
	'....X.....X',
	'....X.....X',
	'.XXXX..XXXX',
	'X...X.X...X',
	'X...X.X...X',
	'X...X.X...X',
	'.XXXX..XXXX',
]

const BRAND_CELLS = BRAND_GRID.flatMap((row, r) =>
	[...row]
		.map((ch, c) =>
			ch === 'X'
				? {
						x: +(3.75 + c * 1.5 + 0.11).toFixed(2),
						y: +(6 + r * 1.5 + 0.11).toFixed(2),
						fill: r <= 4 ? '#1c74ff' : '#032987',
					}
				: null,
		)
		.filter((v): v is { x: number; y: number; fill: string } => v !== null),
)

export function IconBrand() {
	return (
		<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
			<rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="#f7f9fc" stroke="#cfd7e3" stroke-width="1" />
			{BRAND_CELLS.map((cell) => (
				<rect x={cell.x} y={cell.y} width="1.28" height="1.28" rx="0.28" fill={cell.fill} />
			))}
		</svg>
	)
}

export function IconBack() {
	return (
		<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path d="M9.5 3.5L5 8l4.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" />
		</svg>
	)
}

export function IconForward() {
	return (
		<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path d="M6.5 3.5L11 8l-4.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" />
		</svg>
	)
}

export function IconLock() {
	return (
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<rect x="3" y="7" width="10" height="7" stroke="currentColor" stroke-width="1.5" />
			<path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" stroke-width="1.5" />
		</svg>
	)
}

export function IconUnlock() {
	return (
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<rect x="3" y="7" width="10" height="7" stroke="currentColor" stroke-width="1.5" />
			<path d="M5.5 7V5a2.5 2.5 0 0 1 4.8-1" stroke="currentColor" stroke-width="1.5" />
		</svg>
	)
}

export function IconAlert() {
	return (
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path d="M8 2L14.5 13.5H1.5L8 2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="miter" />
			<path d="M8 6.2V9.5" stroke="currentColor" stroke-width="1.6" />
			<circle cx="8" cy="11.6" r="0.8" fill="currentColor" />
		</svg>
	)
}

export function IconTable() {
	return (
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<rect x="2" y="2.5" width="12" height="11" stroke="currentColor" stroke-width="1.4" />
			<path d="M2 6h12M6 6v7.5" stroke="currentColor" stroke-width="1.3" />
		</svg>
	)
}

export function IconView() {
	return (
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4Z" stroke="currentColor" stroke-width="1.4" />
			<circle cx="8" cy="8" r="1.8" stroke="currentColor" stroke-width="1.4" />
		</svg>
	)
}

export function IconSql() {
	return (
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path d="M3 4.5L6.5 8 3 11.5M8 11.5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" />
		</svg>
	)
}

export function IconSearch() {
	return (
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5" />
			<path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" />
		</svg>
	)
}

export function IconRefresh() {
	return (
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path d="M13 8a5 5 0 1 1-1.3-3.4" stroke="currentColor" stroke-width="1.5" />
			<path d="M13 2.5v2.8h-2.8" stroke="currentColor" stroke-width="1.5" />
		</svg>
	)
}

export function IconPlus() {
	return (
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" />
		</svg>
	)
}

export function IconClose() {
	return (
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" />
		</svg>
	)
}

export function IconCopy() {
	return (
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<rect x="5.5" y="5.5" width="8" height="8" stroke="currentColor" stroke-width="1.4" />
			<path d="M10.5 5.5V3h-8v8h2.5" stroke="currentColor" stroke-width="1.4" />
		</svg>
	)
}

export function IconPlay() {
	return (
		<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
			<path d="M4 2.5l9.5 5.5L4 13.5V2.5Z" />
		</svg>
	)
}

export function IconColumns() {
	return (
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<rect x="2" y="2.5" width="12" height="11" stroke="currentColor" stroke-width="1.4" />
			<path d="M6 2.5v11M10 2.5v11" stroke="currentColor" stroke-width="1.3" />
		</svg>
	)
}

export function IconSidebar() {
	return (
		<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<rect x="2" y="2.5" width="12" height="11" stroke="currentColor" stroke-width="1.4" />
			<path d="M6 2.5v11" stroke="currentColor" stroke-width="1.4" />
		</svg>
	)
}

export function IconTheme(props: { dark: boolean }) {
	return props.dark ? (
		<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.5" />
			<path
				d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"
				stroke="currentColor"
				stroke-width="1.4"
			/>
		</svg>
	) : (
		<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path d="M12.8 9.8A5.2 5.2 0 1 1 6.2 3.2a4.2 4.2 0 0 0 6.6 6.6Z" stroke="currentColor" stroke-width="1.5" />
		</svg>
	)
}

export function IconTrash() {
	return (
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path d="M2.5 4.5h11M6 4.5V3h4v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" stroke="currentColor" stroke-width="1.4" />
		</svg>
	)
}

export function IconServer() {
	return (
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<rect x="2" y="2.5" width="12" height="4.5" stroke="currentColor" stroke-width="1.4" />
			<rect x="2" y="9" width="12" height="4.5" stroke="currentColor" stroke-width="1.4" />
			<circle cx="4.5" cy="4.75" r="0.8" fill="currentColor" />
			<circle cx="4.5" cy="11.25" r="0.8" fill="currentColor" />
		</svg>
	)
}

export function IconDisk() {
	return (
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<ellipse cx="8" cy="4" rx="5.5" ry="2" stroke="currentColor" stroke-width="1.4" />
			<path d="M2.5 4v8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4" stroke="currentColor" stroke-width="1.4" />
			<path d="M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" stroke="currentColor" stroke-width="1.3" />
		</svg>
	)
}

export function IconArrowRight() {
	return (
		<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" />
		</svg>
	)
}

export function IconCompass() {
	return (
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4" />
			<path d="M10.5 5.5L9 9l-3.5 1.5L7 7l3.5-1.5Z" stroke="currentColor" stroke-width="1.3" />
		</svg>
	)
}

export function IconLink() {
	return (
		<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path
				d="M6.8 9.2L9.2 6.8M5.8 6.4L4.2 8a2.5 2.5 0 0 0 3.5 3.5l1.6-1.6M10.2 9.6l1.6-1.6a2.5 2.5 0 0 0-3.5-3.5L6.7 6.1"
				stroke="currentColor"
				stroke-width="1.4"
				stroke-linecap="round"
			/>
		</svg>
	)
}
