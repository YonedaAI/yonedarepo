// Start optional reads only when their content is close enough to be seen.
import { useEffect, useRef, useState } from 'react';

export function useNearViewport<T extends Element>() {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const target = ref.current;
    if (!target) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  return { ref, near };
}
