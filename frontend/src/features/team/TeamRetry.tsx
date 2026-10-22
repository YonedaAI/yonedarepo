/** Owner retry for a failed team task. Only a real, named limit replaces the button. */
export function TeamRetry({
  blocker,
  resumes,
  disabled,
  onRetry,
}: {
  blocker?: string;
  resumes: boolean;
  disabled: boolean;
  onRetry: () => void;
}) {
  if (blocker) return <p>{blocker}</p>;
  return (
    <div className="team-task-retry">
      <button type="button" className="quiet" disabled={disabled} onClick={onRetry}>
        Retry task
      </button>
      {resumes && (
        <p>
          Retry continues from the files this attempt already wrote. No settings need to change.
        </p>
      )}
    </div>
  );
}
