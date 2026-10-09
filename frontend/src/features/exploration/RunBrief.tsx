export function RunBrief({ intent, criteria }: { intent: string; criteria?: string[] }) {
  return (
    <details className="run-brief">
      <summary>View run brief</summary>
      <p>{intent}</p>
      {!!criteria?.length && (
        <>
          <h3>Acceptance criteria</h3>
          <ul>
            {criteria.map((criterion, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Approved criteria are frozen and have no item state; repeated text is allowed.
              <li key={`${index}:${criterion}`}>{criterion}</li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
