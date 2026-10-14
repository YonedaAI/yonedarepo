import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GuidedSession } from '../../../../shared/guided-runs';
import { GuidedEvidenceList } from './GuidedEvidenceList';
import { GuidedProgress } from './GuidedProgress';
import {
  designChoiceText,
  evidenceInspectKind,
  evidenceLabel,
  guidedProgress,
} from './guidedEvidenceView';
import { sessionFixture } from './guidedFixture';

const label = (kind: string, server = 'Server wording') => evidenceLabel({ kind, label: server });

describe('guided evidence wording', () => {
  it('maps recorded kinds to plain labels and keeps the server label for unknown kinds', () => {
    expect(label('checked_source')).toBe('Passed independent checks');
    expect(label('shared_contract')).toBe('Agents agreed on a shared contract');
    expect(label('collaboration')).toBe('Agents worked in parallel');
    expect(label('design_choice')).toBe('Design decision recorded');
    expect(label('context_continuation')).toBe('Reused the earlier decision');
    expect(label('context_opened')).toBe('Reused the earlier decision');
    expect(label('publication_readback')).toBe('Published by you');
    expect(label('future_kind', 'A new server proof')).toBe('A new server proof');
  });

  it('keeps the existing inspect targets', () => {
    expect(evidenceInspectKind({ kind: 'design_choice', verified: true })).toBe('context');
    expect(evidenceInspectKind({ kind: 'context_continuation', verified: false })).toBe('context');
    expect(evidenceInspectKind({ kind: 'scoped_resolution', verified: true })).toBe('conflict');
    expect(evidenceInspectKind({ kind: 'scoped_resolution', verified: false })).toBe(
      'scoped_resolution',
    );
    expect(
      designChoiceText({ kind: 'design_choice', label: 'Recorded design choice: Keep IDs stable' }),
    ).toBe('Keep IDs stable');
  });

  it('renders a status icon, accessible status text, one Details link and a clamped decision', () => {
    const decision = `Keep task IDs stable. ${'Replacing IDs during edits would lose bookmark references. '.repeat(5)}`;
    const html = renderToStaticMarkup(
      createElement(GuidedEvidenceList, {
        stepId: 'build',
        busy: false,
        onInspect: () => {},
        fallbackRun: 'run-1',
        evidence: [
          {
            kind: 'checked_source',
            label: 'Captured source independently checked for this phase',
            verified: true,
            candidate_id: 'c1',
          },
          { kind: 'collaboration', label: 'Captured specialists', verified: false },
          { kind: 'design_choice', label: `Recorded design choice: ${decision}`, verified: true },
        ],
      }),
    );
    expect(html).toContain('Passed independent checks');
    expect(html).toContain('title="Captured source independently checked for this phase"');
    expect(html).toContain('guided-evidence-icon verified');
    expect(html).toContain('guided-evidence-icon pending');
    expect(html).toContain('(Not yet verified)');
    expect(html.match(/>Details</g)).toHaveLength(3);
    expect(html).toContain('aria-label="Details: Passed independent checks"');
    expect(html).toContain('class="guided-decision collapsed"');
    expect(html).toContain('Show decision');
    expect(html).toContain('aria-expanded="false"');
  });
});

describe('guided progress header', () => {
  const session = (
    statuses: GuidedSession['steps'][number]['status'][],
    next: GuidedSession['next_step'],
  ) => {
    const value = sessionFixture();
    value.next_step = next;
    value.steps = value.steps.map((step, index) => ({ ...step, status: statuses[index] }));
    return value;
  };

  it('derives done, current and locked steps from server status and next_step', () => {
    const progress = guidedProgress(
      session(['complete', 'complete', 'running', 'locked'], 'concurrent'),
    );
    expect(progress.complete).toBe(2);
    expect(progress.steps.map((step) => step.state)).toEqual([
      'done',
      'done',
      'current',
      'upcoming',
    ]);
    expect(
      guidedProgress(session(['complete', 'needs_attention', 'locked', 'locked'], 'extend'))
        .steps[1].state,
    ).toBe('attention');
  });

  it('is an ordered list with one aria-current step and a completion count', () => {
    const html = renderToStaticMarkup(
      createElement(GuidedProgress, {
        session: session(['complete', 'complete', 'running', 'locked'], 'concurrent'),
      }),
    );
    expect(html).toContain('2 of 4 complete');
    expect(html).toContain('<ol aria-label="Guided demo progress">');
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toMatch(
      /aria-current="step"><span[^>]*>.*?<\/span><span>Reconcile changes<\/span>/,
    );
    expect(html).toContain('Review &amp; publish</span><span class="sr-only">, locked</span>');
  });
});
