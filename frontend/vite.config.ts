import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {shortCssNames} from './vite-css-names';
import {shortJsxCalls} from './vite-jsx-calls';
import {prerenderSite} from './vite-prerender';
export default defineConfig({plugins:[react(),shortJsxCalls(),prerenderSite(),shortCssNames()],server:{proxy:{'/api':{target:'http://127.0.0.1:8787',ws:true},'/health':'http://127.0.0.1:8787'}}});
