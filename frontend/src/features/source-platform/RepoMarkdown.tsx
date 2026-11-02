// A repository's Markdown: the file view's Preview and the README under a folder share this, so
// they read alike and a README's relative images show in both.
import { useEffect, useState } from 'react';
import { readQuery } from './codeData';
import { type ImageResolver, Markdown } from './markdown';
import { imageType, MAX_IMAGE_BYTES, repoImagePath } from './repoImage';
import { sourceApi } from './sourceApi';

type Place = { repo: string; ref: string; path: string; at?: number };

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

/** An image of this repository, or its words while it loads and if it can't be shown. */
function RepoImage({ place, path, alt }: { place: Place; path: string; alt: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let made: string | undefined;
    const query = readQuery(place.ref, path, place.at);
    sourceApi<{ encoding: string; content: string; size: number }>(
      `/repos/${place.repo}/blob?${query}`,
      { signal: controller.signal },
    )
      .then((file) => {
        if (file.encoding !== 'base64' || file.size > MAX_IMAGE_BYTES) return;
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
  }, [place.repo, place.ref, place.at, path]);
  return url ? <img src={url} alt={alt} /> : alt;
}

export function RepoMarkdown({ source, place }: { source: string; place: Place }) {
  const image: ImageResolver = (src, alt, key) => {
    const path = repoImagePath(place.path, src);
    return path ? <RepoImage key={key} place={place} path={path} alt={alt} /> : undefined;
  };
  return (
    <div className="readme-body">
      <Markdown source={source} image={image} />
    </div>
  );
}
