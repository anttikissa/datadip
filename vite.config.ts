// Vite configuration for the DataDip web client with Solid 2 HMR and API proxy.
import solid from '@solidjs/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [solid()],
	server: {
		port: 4748,
		strictPort: false,
		proxy: {
			'/api': {
				target: 'http://127.0.0.1:4747',
				changeOrigin: false,
			},
		},
	},
	build: {
		outDir: 'dist',
		emptyOutDir: true,
		target: 'esnext',
	},
})
