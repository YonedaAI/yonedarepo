// The blog: an index (the newest post featured, the next three as cards, then every post
// with a category filter kept in the hash, `/blog#research`) and one post per page (hero
// image, byline, reading time, body with figures, and more posts to read next).
import { Fragment, type MouseEvent, useEffect, useState } from 'react';
import type { Navigate } from '../shell/useRoute';
import { inline, Markdown } from '../source-platform/markdown';
import {
  bodyParts,
  categoryFromHash,
  categorySlug,
  filterPosts,
  morePosts,
  readingMinutes,
  usedCategories,
} from './blog';
import { BLOG_POSTS, type Post } from './content';
import { siteLink } from './SiteLayout';
import { contentLinks } from './SitePages';

const shortDate = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

function Meta({ post, minutes }: { post: Post; minutes?: number }) {
  return (
    <p className="blog-meta">
      <time dateTime={post.date}>{shortDate(post.date)}</time> · {post.author}
      {minutes !== undefined && <> · {minutes} min read</>}
    </p>
  );
}

const Tag = ({ post }: { post: Post }) => <span className="blog-tag">{post.category}</span>;

// Figures taken from the papers are black line art on white; dark mode inverts them.
const imageClass = (src: string) => (src.includes('/figure-') ? 'blog-image is-art' : 'blog-image');

/** A card's image; the card's title link covers it (see `.blog-card`), so it is no link itself. */
function PostImage({ post, eager }: { post: Post; eager?: boolean }) {
  if (!post.image) return null;
  return (
    <div className="blog-media">
      <img
        className={imageClass(post.image)}
        src={post.image}
        alt=""
        width={1600}
        height={900}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
      />
    </div>
  );
}

function PostLink({ post, navigate }: { post: Post; navigate: Navigate }) {
  return (
    <a className="blog-title-link" {...siteLink({ page: 'post', slug: post.slug }, navigate)}>
      {post.title}
    </a>
  );
}

/** A post as a card: image, byline, title, excerpt and category. */
function Card({ post, navigate }: { post: Post; navigate: Navigate }) {
  return (
    <li className="blog-card">
      <PostImage post={post} />
      <Meta post={post} />
      <h3>
        <PostLink post={post} navigate={navigate} />
      </h3>
      <p className="blog-excerpt">{inline(post.summary, post.slug)}</p>
      <Tag post={post} />
    </li>
  );
}

const fromHash = () =>
  typeof window === 'undefined' ? undefined : categoryFromHash(window.location.hash);

/** The category the address names, followed through back and forward. */
function useCategory(initial?: string): [string | undefined, (next?: string) => void] {
  const [category, setCategory] = useState<string | undefined>(() => initial ?? fromHash());
  useEffect(() => {
    const sync = () => setCategory(fromHash());
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);
  const choose = (next?: string) => {
    window.history.pushState(null, '', next ? `/blog#${categorySlug(next)}` : '/blog');
    setCategory(next);
  };
  return [category, choose];
}

function BlogIndex({ navigate, category: initial }: { navigate: Navigate; category?: string }) {
  const [category, choose] = useCategory(initial);
  const [featured, ...rest] = BLOG_POSTS;
  const chips: (string | undefined)[] = [undefined, ...usedCategories(BLOG_POSTS)];
  const pick = (next?: string) => (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    choose(next);
  };
  return (
    <div className="blog">
      <header className="blog-head">
        <h1>Blog</h1>
        <p className="site-lead">
          Notes and research from building YonedaRepo, with the numbers we measured.
        </p>
      </header>
      {featured && (
        <article className="blog-featured">
          <PostImage post={featured} eager />
          <div className="blog-featured-text">
            <Meta post={featured} />
            <h2>
              <PostLink post={featured} navigate={navigate} />
            </h2>
            <p className="blog-excerpt">{inline(featured.summary, featured.slug)}</p>
            <Tag post={featured} />
          </div>
        </article>
      )}
      <ul className="blog-row" aria-label="Latest posts">
        {rest.slice(0, 3).map((post) => (
          <Card key={post.slug} post={post} navigate={navigate} />
        ))}
      </ul>
      <section className="blog-all" aria-labelledby="blog-all-heading">
        <h2 id="blog-all-heading">All articles</h2>
        <nav aria-label="Categories">
          <ul className="blog-chips">
            {chips.map((chip) => (
              <li key={chip ?? 'all'}>
                <a
                  className="blog-chip"
                  href={chip ? `/blog#${categorySlug(chip)}` : '/blog'}
                  onClick={pick(chip)}
                  aria-current={chip === category ? 'true' : undefined}
                >
                  {chip ?? 'All articles'}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <ul className="blog-list">
          {filterPosts(BLOG_POSTS, category).map((post) => (
            <li key={post.slug}>
              <Meta post={post} />
              <div>
                <h3>
                  <PostLink post={post} navigate={navigate} />
                </h3>
                <p className="blog-excerpt">{inline(post.summary, post.slug)}</p>
              </div>
              <Tag post={post} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function BlogPost({ post, navigate }: { post: Post; navigate: Navigate }) {
  return (
    <article className="blog blog-post">
      <p className="blog-back">
        <a {...siteLink({ page: 'blog' }, navigate)}>← Blog</a>
      </p>
      <header className="blog-post-head">
        <Tag post={post} />
        <h1>{post.title}</h1>
        <Meta post={post} minutes={readingMinutes(post.body)} />
      </header>
      {post.image && (
        <figure className="blog-hero">
          <img
            className={imageClass(post.image)}
            src={post.image}
            alt={post.imageAlt}
            width={1600}
            height={900}
            decoding="async"
          />
          {post.caption && <figcaption>{post.caption}</figcaption>}
        </figure>
      )}
      <div className="site-prose blog-body">
        {bodyParts(post.body).map((part, n) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional parts of one body.
          <Fragment key={n}>
            {part.kind === 'figure' ? (
              <figure className="blog-figure">
                <img
                  className={imageClass(part.src)}
                  src={part.src}
                  alt={part.alt}
                  loading="lazy"
                  decoding="async"
                />
                {part.caption && <figcaption>{part.caption}</figcaption>}
              </figure>
            ) : (
              <Markdown source={part.source} shift={0} link={contentLinks(navigate)} anchors />
            )}
          </Fragment>
        ))}
      </div>
      <section className="blog-more" aria-labelledby="blog-more-heading">
        <h2 id="blog-more-heading">More posts</h2>
        <ul className="blog-row">
          {morePosts(BLOG_POSTS, post).map((other) => (
            <Card key={other.slug} post={other} navigate={navigate} />
          ))}
        </ul>
      </section>
    </article>
  );
}

/** The blog index, or one post when `slug` is given; `category` presets the index filter. */
export function SiteBlog({
  slug,
  navigate,
  category,
}: {
  slug?: string;
  navigate: Navigate;
  category?: string;
}) {
  if (slug === undefined) return <BlogIndex navigate={navigate} category={category} />;
  const post = BLOG_POSTS.find((p) => p.slug === slug);
  if (post) return <BlogPost key={post.slug} post={post} navigate={navigate} />;
  return (
    <article className="site-prose site-post">
      <p>
        <a {...siteLink({ page: 'blog' }, navigate)}>← Blog</a>
      </p>
      <h1>Post not found</h1>
      <p>There is no post at this address.</p>
    </article>
  );
}
