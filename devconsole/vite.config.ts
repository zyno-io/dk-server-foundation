import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
    plugins: [vue()],
    base: '/_devconsole/',
    build: {
        outDir: '../dist/devconsole',
        emptyOutDir: true
    },
    server: {
        proxy: {
            '/_devconsole/api': 'http://localhost:3000',
            '/_devconsole/openapi.json': 'http://localhost:3000',
            '/_devconsole/ws': {
                target: 'ws://localhost:3000',
                ws: true
            }
        }
    }
});
