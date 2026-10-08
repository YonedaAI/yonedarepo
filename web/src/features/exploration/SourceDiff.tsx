export function SourceDiff({ diff }: { diff: string }) {
  const occurrences = new Map<string, number>();
  return (
    <pre className="source-diff">
      {diff
        ? diff.split('\n').map((line) => {
            const occurrence = (occurrences.get(line) ?? 0) + 1;
            occurrences.set(line, occurrence);
            const kind =
              line.startsWith('diff --git') || line.startsWith('@@') || line.startsWith('index ')
                ? 'diff-header'
                : line.startsWith('+') && !line.startsWith('+++')
                  ? 'diff-added'
                  : line.startsWith('-') && !line.startsWith('---')
                    ? 'diff-removed'
                    : 'diff-context';
            return (
              <span className={kind} key={`${line}:${occurrence}`}>
                {line || ' '}
              </span>
            );
          })
        : 'No source changes'}
    </pre>
  );
}
