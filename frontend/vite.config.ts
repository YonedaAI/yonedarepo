import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {prerenderSite} from './vite-prerender';
export default defineConfig({plugins:[react(),prerenderSite()],server:{proxy:{'/api':{target:'http://127.0.0.1:8787',ws:true},'/health':'http://127.0.0.1:8787'}}});
