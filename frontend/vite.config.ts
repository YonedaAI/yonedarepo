import {defineConfig,loadEnv} from 'vite';
import react from '@vitejs/plugin-react';
import {shortCssNames} from './vite-css-names';
import {shortJsxCalls} from './vite-jsx-calls';
import {prerenderSite} from './vite-prerender';
import {staticAssetHeaders} from './vite-static-cache';
import {earlyReads} from './vite-early-reads';
export default defineConfig(({mode})=>({plugins:[react(),earlyReads(loadEnv(mode,'.','VITE_').VITE_EARLY_READS==='on'),shortJsxCalls(),prerenderSite(),staticAssetHeaders(loadEnv(mode,'.','VITE_').VITE_STATIC_ASSET_CACHE==='on'),shortCssNames()],server:{proxy:{'/api':{target:'http://127.0.0.1:8787',ws:true},'/health':'http://127.0.0.1:8787'}}}));
