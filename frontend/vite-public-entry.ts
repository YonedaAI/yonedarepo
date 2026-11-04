/** Build-known public client assets; app routes request none of them. */
export function publicEntryTemplates(template: string, script: string, styles: string[]) {
  const assets = [
    { rel: 'modulepreload', href: `/${script}` },
    ...styles.map((href) => ({ rel: 'stylesheet', href: `/${href}` })),
  ];
  const links = assets
    .map(({ rel, href }) => `<link rel="${rel}" crossorigin href="${href}">`)
    .join('');
  // Sign-in pages deliberately have no static markup, but need their code without an extra RTT.
  const head = `<script data-yoneda-public-entry>if(/^\\/(?:signin|signup)\\/?$/.test(location.pathname)){for(const a of ${JSON.stringify(assets)}){const l=document.createElement('link');l.rel=a.rel;l.href=a.href;l.crossOrigin='';document.head.append(l)}}</script>`;
  return {
    app: template.replace('</head>', `${head}</head>`),
    site: template.replace('</head>', `${links}</head>`),
  };
}

/** Reuse the early admission guard; this link fetches only immutable renderer code. */
export function overviewEntryTemplate(template: string, script: string, reserved: readonly string[], matcher: string) {
  const head = `<script data-yoneda-overview-code>if((${matcher})(location,${JSON.stringify(reserved)})){const l=document.createElement('link');l.rel='modulepreload';l.href=${JSON.stringify(`/${script}`)};l.crossOrigin='';document.head.append(l)}</script>`;
  return template.replace('</head>', `${head}</head>`);
}
