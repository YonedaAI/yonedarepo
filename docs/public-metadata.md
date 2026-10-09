# Public brand assets and link previews

The public app title is **YonedaRepo — Context for the agentic era**. Its description is **Build with multiple agents, preserve decisions and context, and choose what ships.** These describe the platform; no private repository, account, prompt, graph or screenshot is included in the public assets.

`frontend/index.html` contains Open Graph, Twitter large-card and canonical metadata before React starts. The platform Worker replaces `__YONEDA_PUBLIC_ORIGIN__` with the absolute public URL and `__YONEDA_SOCIAL_IMAGE_URL__` with the absolute `/brand/social-card.png` URL. It escapes HTML attribute values and leaves static assets available without a session. Local Vite alone serves the template placeholders; the platform Worker supplies deployment origins.

By default the public origin is the incoming request's origin. For a canonical custom domain, set `vars.PUBLIC_APP_ORIGIN` in your platform Wrangler config to an HTTPS origin such as `https://yoneda.example`, then redeploy. It must contain no credentials, query, fragment or path beyond `/`. HTTP is accepted only for `localhost`, `127.0.0.1` and `[::1]` development origins. Invalid configuration produces a controlled error without exposing its value.

Keep `assets.run_worker_first` set to `true`: serving HTML directly from Assets would bypass metadata substitution. Newly generated named deployment configs inherit this setting. Existing generated configs preserve local customizations; replace an older route list with `true` before deploying this upgrade. Rewritten HTML uses `Cache-Control: no-store` and removes static ETag, Last-Modified and Content-Length headers; its public URLs can vary by host. Other asset bodies and caching headers remain unchanged.

| Public path | Source / purpose |
| --- | --- |
| `/favicon.svg` | Editable 64-unit SVG, matching the existing blue italic y mark |
| `/favicon.ico` | 16, 32, 48 and 64 pixel fallback icon |
| `/apple-touch-icon.png` | 180 × 180 touch icon |
| `/brand/mark.svg` | Editable vector mark |
| `/brand/social-card.svg` | Editable 1200 × 630 source, with IBM Plex Sans and Mono typography |
| `/brand/social-card.png` | 1200 × 630 public sharing image |

The SVG sources use plain vector geometry and text. They were rendered locally with `rsvg-convert`; the favicon fallback was encoded with ImageMagick. Social typography uses the repository's pinned IBM Plex font packages. To rerender with matching typography, install IBM Plex Sans (400/600) and Mono (400) for your local SVG renderer, then run:

```sh
rsvg-convert -o frontend/public/brand/social-card.png frontend/public/brand/social-card.svg
rsvg-convert -w 180 -h 180 -o frontend/public/apple-touch-icon.png frontend/public/favicon.svg
rsvg-convert -w 256 -h 256 -o /tmp/yoneda-favicon.png frontend/public/favicon.svg
magick /tmp/yoneda-favicon.png -define icon:auto-resize=64,48,32,16 frontend/public/favicon.ico
```

Verify metadata on the initial HTML response and icon/card URLs while signed out. Browser rendering alone does not prove a social crawler can read metadata or public assets.
