// Client interactions for DataDip marketing site: theme toggle, hero demo switcher, changelog filter, copy buttons, and screenshot lightbox.

const themeBtn = document.getElementById('theme-toggle')
if (themeBtn) {
	themeBtn.addEventListener('click', () => {
		const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
		const next = cur === 'dark' ? 'light' : 'dark'
		document.documentElement.setAttribute('data-theme', next)
		try {
			localStorage.setItem('datadip-site:theme', next)
		} catch {}
	})
}

const heroVideo = document.getElementById('hero-video')
const heroImage = document.getElementById('hero-image')
const stageTitle = document.getElementById('stage-title')
const videoToggle = document.getElementById('video-toggle')
const zoomBtn = document.getElementById('zoom-btn')
const stageTabs = document.querySelectorAll('.stage-tab')

for (const tab of stageTabs) {
	tab.addEventListener('click', () => {
		for (const t of stageTabs) {
			t.classList.remove('active')
			t.setAttribute('aria-selected', 'false')
		}
		tab.classList.add('active')
		tab.setAttribute('aria-selected', 'true')

		const kind = tab.getAttribute('data-kind')
		const src = tab.getAttribute('data-src') || ''
		const title = tab.getAttribute('data-title') || 'DataDip'
		if (stageTitle) stageTitle.textContent = title

		if (kind === 'video') {
			if (heroImage) heroImage.hidden = true
			if (heroVideo) {
				heroVideo.hidden = false
				heroVideo.play().catch(() => {})
			}
			if (videoToggle) {
				videoToggle.hidden = false
				videoToggle.textContent = 'Pause'
			}
			if (zoomBtn) zoomBtn.hidden = true
		} else {
			if (heroVideo) {
				heroVideo.pause()
				heroVideo.hidden = true
			}
			if (heroImage) {
				heroImage.src = src
				heroImage.alt = title
				heroImage.hidden = false
			}
			if (videoToggle) videoToggle.hidden = true
			if (zoomBtn) zoomBtn.hidden = false
		}
	})
}

if (videoToggle && heroVideo) {
	videoToggle.addEventListener('click', () => {
		if (heroVideo.paused) {
			heroVideo.play().catch(() => {})
			videoToggle.textContent = 'Pause'
			videoToggle.setAttribute('aria-label', 'Pause demo video')
		} else {
			heroVideo.pause()
			videoToggle.textContent = 'Play'
			videoToggle.setAttribute('aria-label', 'Play demo video')
		}
	})
}

// Changelog category filter
const clFilters = document.querySelectorAll('.cl-filter')
const clItems = document.querySelectorAll('.cl-item')
for (const btn of clFilters) {
	btn.addEventListener('click', () => {
		const cat = btn.getAttribute('data-filter') || 'all'
		for (const b of clFilters) {
			b.classList.toggle('active', b === btn)
			b.setAttribute('aria-pressed', b === btn ? 'true' : 'false')
		}
		for (const item of clItems) {
			const tag = item.getAttribute('data-tag') || ''
			item.hidden = cat !== 'all' && tag !== cat
		}
	})
}

// Lightbox for full-res screenshots
const lightbox = document.getElementById('lightbox')
const lightboxImg = document.getElementById('lightbox-img')
const lightboxCaption = document.getElementById('lightbox-caption')
const lightboxClose = document.getElementById('lightbox-close')

function openLightbox(src, caption) {
	if (!lightbox || !lightboxImg) return
	lightboxImg.src = src
	lightboxImg.alt = caption
	if (lightboxCaption) lightboxCaption.textContent = caption
	lightbox.showModal()
}

if (zoomBtn && heroImage) {
	zoomBtn.addEventListener('click', () => openLightbox(heroImage.src, heroImage.alt))
	heroImage.style.cursor = 'zoom-in'
	heroImage.addEventListener('click', () => openLightbox(heroImage.src, heroImage.alt))
}

for (const img of document.querySelectorAll('img.zoomable')) {
	img.addEventListener('click', () => openLightbox(img.getAttribute('src') || '', img.getAttribute('alt') || 'DataDip'))
}

if (lightboxClose && lightbox) {
	lightboxClose.addEventListener('click', () => lightbox.close())
	lightbox.addEventListener('click', (e) => {
		if (e.target === lightbox) lightbox.close()
	})
}

// Copy buttons
for (const btn of document.querySelectorAll('.copy-btn')) {
	btn.addEventListener('click', async () => {
		const text = btn.getAttribute('data-copy') || ''
		try {
			await navigator.clipboard.writeText(text)
			const prev = btn.textContent
			btn.textContent = 'Copied!'
			setTimeout(() => {
				btn.textContent = prev
			}, 1400)
		} catch {}
	})
}
