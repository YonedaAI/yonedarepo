// A repository's Markdown: the file view's Preview and the README under a folder share this, so
// they read alike and a README's relative images show in both.
import { useEffect, useState } from 'react';
import { useNearViewport } from '../../hooks/useNearViewport';
import { readQuery } from './codeData';
import type { ImageResolver } from './markdown';
import { RichMarkdown } from './RichMarkdown';
import { imageType, MAX_IMAGE_BYTES, repoImagePath } from './repoImage';
import { sourceApi } from './sourceApi';

type Place = { repo: string; ref: string; path: string; at?: number };

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

/** An image of this repository, or its words while it loads and if it can't be shown. */
function RepoImage({ place, path, alt }: { place: Place; path: string; alt: string }) {
  const [url, setUrl] = useState<string>();
  const { ref, near } = useNearViewport<HTMLSpanElement>('0px');
  useEffect(() => {
    setUrl(undefined);
    if (!near) return;
    const controller = new AbortController();
    let made: string | undefined;
    const query = new URLSearchParams(readQuery(place.ref, path, place.at));
    query.set('revalidate', 'image');
    sourceApi<{ encoding: string; content: string; size: number }>(
      `/repos/${place.repo}/blob?${query}`,
      { signal: controller.signal },
    )
      .then((file) => {
        if (controller.signal.aborted || file.encoding !== 'base64' || file.size > MAX_IMAGE_BYTES)
          return;
        const bytes = bytesOf(file.content);
        const type = imageType(bytes);
        if (!type) return;
        made = URL.createObjectURL(new Blob([bytes], { type }));
        setUrl(made);
      })
      .catch(() => {});
    return () => {
      controller.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [near, place.repo, place.ref, place.at, path]);
  return (
    <span ref={ref} className="repo-image">
      {url ? <img src={url} alt={alt} loading="lazy" decoding="async" /> : alt}
    </span>
  );
}

export function RepoMarkdown({ source, place }: { source: string; place: Place }) {
  const image: ImageResolver = (src, alt, key) => {
    const path = repoImagePath(place.path, src);
    return path ? <RepoImage key={key} place={place} path={path} alt={alt} /> : undefined;
  };
  return (
    <div className="readme-body">
      <RichMarkdown source={source} image={image} anchors />
    </div>
  );
}
