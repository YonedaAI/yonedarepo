import { type CSSProperties, type ReactNode, useId, useState } from 'react';

/** Whether text is long enough to preview: more lines, or more characters than the measure fits. */
export function needsPreview(text: string, lines: number, characters: number) {
  return text.length > characters || text.split('\n').length > lines;
}

/** The full text stays in the DOM; collapsing only clamps it visually and fades the last line. */
export function ClampedText({
  text,
  lines,
  characters,
  className,
  prefix,
  showLabel,
  hideLabel,
  toggleClassName,
}: {
  text: string;
  lines: number;
  /** Roughly how many characters fit in `lines` at this element's measure. */
  characters: number;
  className: string;
  prefix?: ReactNode;
  showLabel: string;
  hideLabel: string;
  toggleClassName?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const preview = needsPreview(text, lines, characters);
  return (
    <>
      <p
        id={id}
        className={`${className}${preview && !expanded ? ' collapsed' : ''}`}
        data-clamp=""
        style={{ '--clamp-lines': lines } as CSSProperties}
      >
        {prefix}
        {text}
      </p>
      {preview && (
        <button
          type="button"
          className={`text-button clamp-toggle${toggleClassName ? ` ${toggleClassName}` : ''}`}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? hideLabel : showLabel}
        </button>
      )}
    </>
  );
}
