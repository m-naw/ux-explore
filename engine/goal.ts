// engine/goal.ts
// Objective goal criteria and persona-believes-done hysteresis.

import type { Bucket, PersonaProfile } from './types';

/**
 * Confusion at or above which the persona is treated as confused: the step is flagged
 * `confused`, and a leave taken at this level is exhaustion rather than a free choice.
 */
export const CONFUSED_AT = 3;

/** No-progress steps after which a leave reads as exhaustion, by persona patience. */
export const PATIENCE_NO_PROGRESS: Record<'low' | 'medium' | 'high', number> = {
  low: 3,
  medium: 4,
  high: 6,
};

/**
 * `leave` is the only exit the persona is ever offered, because leaving is the act a real
 * person performs. A leave taken while confused, or after a patience-length run of no
 * progress, is exhaustion rather than a free choice, so the journey reports it as `gaveUp`
 * as well as `left`.
 */
export function leftInExhaustion(ctx: {
  left: boolean;
  confusion: number;
  noProgressSteps: number;
  patience: PersonaProfile['patience'];
}): boolean {
  if (!ctx.left) return false;
  return ctx.confusion >= CONFUSED_AT || ctx.noProgressSteps >= PATIENCE_NO_PROGRESS[ctx.patience];
}

/** Jev goalMet level that counts as "the persona believes they are done". */
export const BELIEVES_DONE_THRESHOLD = 0.8;

/** Criteria matched while goalMet is below this gives `unrecognized-success`. */
export const UNRECOGNIZED_SUCCESS_BELOW = 0.5;

export interface GoalCriteria {
  successUrl?: RegExp;
  successText?: string;
}

export function criteriaConfigured(criteria: GoalCriteria): boolean {
  return criteria.successUrl !== undefined || criteria.successText !== undefined;
}

/** Any configured criterion matching is enough: success has more than one shape per site. */
export function criteriaMet(criteria: GoalCriteria, url: string, visibleText: string): boolean {
  if (!criteriaConfigured(criteria)) return false;
  if (criteria.successUrl && criteria.successUrl.test(url)) return true;
  if (criteria.successText && visibleText.includes(criteria.successText)) return true;
  return false;
}

/** Fires when goalMet is at or above 0.8 on two consecutive steps. */
export class BelievesDoneTracker {
  private run = 0;
  private everFired = false;

  push(goalMet: number): boolean {
    this.run = goalMet >= BELIEVES_DONE_THRESHOLD ? this.run + 1 : 0;
    const firing = this.run >= 2;
    if (firing) this.everFired = true;
    return firing;
  }

  get fired(): boolean {
    return this.everFired;
  }
}

export interface ResolveOutcomeInput {
  criteria: GoalCriteria;
  criteriaMatched: boolean;
  /** The believes-done tracker fired on the step that ended the journey. */
  believesDoneFired: boolean;
  gaveUp: boolean;
  /** The persona chose `leave` on the step that ended the journey. */
  left: boolean;
  lastGoalMet: number;
  maxStepsReached: boolean;
  looped: boolean;
}

export interface ResolvedOutcome {
  needMet: boolean | null;
  reason: string;
  bucketHint?: Bucket;
  findings: string[];
}

/**
 * Map the end-of-journey signals to an outcome.
 *
 * Precedence, highest first: a matched criterion, then a leave, then belief, then exhaustion,
 * a loop and the step budget. A leave outranks belief because a persona who thought they were
 * finished and then walked away has bounced; calling that a `false-completion` would blame the
 * site for a journey the persona ended itself.
 */
export function resolveOutcome(input: ResolveOutcomeInput): ResolvedOutcome {
  const findings: string[] = [];

  if (input.criteriaMatched) {
    if (input.lastGoalMet < UNRECOGNIZED_SUCCESS_BELOW) findings.push('unrecognized-success');
    return { needMet: true, reason: 'criteria matched', findings };
  }

  // A bounce, not a tool failure and not exhaustion: the persona was free to go and went.
  if (input.left)
    return { needMet: false, reason: 'left the site', bucketHint: 'bounce', findings: [] };

  if (input.believesDoneFired) {
    if (criteriaConfigured(input.criteria)) {
      return {
        needMet: false,
        reason: 'persona believed the goal was met',
        bucketHint: 'ux',
        findings: ['false-completion'],
      };
    }
    return { needMet: null, reason: 'unverified', findings };
  }

  if (input.gaveUp) return { needMet: false, reason: 'gave up', findings };
  if (input.looped) return { needMet: false, reason: 'loop detected', findings };
  if (input.maxStepsReached) return { needMet: false, reason: 'step budget exhausted', findings };
  return { needMet: false, reason: 'journey ended', findings };
}
