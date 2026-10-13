import { useId, useRef, useState } from 'react';

export function IntentQuestion({
  run,
  reviewer,
  busy,
  onAnswer,
}: {
  run: Record<string, any>;
  reviewer: boolean;
  busy: boolean;
  onAnswer?: (question: string, answer: string) => Promise<boolean>;
}) {
  const [answer, setAnswer] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const label = useId();
  const question = run.intent_question;
  if (!question || question.run_id !== run.id || typeof question.question !== 'string') return null;
  const pending = question.status === 'pending' && run.status === 'awaiting_intent';
  async function submit() {
    if (!pending || !onAnswer || !answer.trim() || busy || reviewer || submitting.current) return;
    submitting.current = true;
    setSending(true);
    setError('');
    try {
      if (!(await onAnswer?.(question.id, answer.trim())))
        setError('The answer was not recorded. Refresh and try again.');
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      submitting.current = false;
      setSending(false);
    }
  }
  return (
    <aside className="intent-question" aria-labelledby={label}>
      <h3 id={label}>
        {pending ? 'Agents need your intent answer' : 'Recorded intent clarification'}
      </h3>
      <p>{question.question}</p>
      {question.status === 'answered' && (
        <p>
          <strong>Recorded answer:</strong> {question.answer}
        </p>
      )}
      {pending && (
        <>
          <p>
            Coordinating work is waiting for this answer. Captured results remain available for
            inspection.
          </p>
          {reviewer ? (
            <p>Only the project owner can record this answer.</p>
          ) : (
            <form
              aria-label="Answer product intent"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <div className="intent-answer-options">
                {(Array.isArray(question.options) ? question.options : [])
                  .filter((value: unknown): value is string => typeof value === 'string')
                  .map((option: string) => (
                    <button
                      key={option}
                      type="button"
                      className="quiet"
                      disabled={busy || sending}
                      onClick={() => setAnswer(option)}
                    >
                      {option}
                    </button>
                  ))}
              </div>
              <label>
                Your answer
                <textarea
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  required
                  maxLength={4096}
                  disabled={busy || sending}
                />
              </label>
              <button type="submit" disabled={busy || sending || !answer.trim() || !onAnswer}>
                {sending ? 'Recording answer…' : 'Record intent answer'}
              </button>
              {error && <p role="alert">{error}</p>}
            </form>
          )}
        </>
      )}
    </aside>
  );
}
