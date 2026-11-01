// The home page's Flight Path picture: one example Landing's words and the route's geometry.
// Everything here is a made-up example of the idea, not a real repository or a measurement.

/** A fix on the route, in flying order. `soon` marks what isn't on prod yet. */
export type Fix = {
  id: 'plan' | 'takeoff' | 'route' | 'instruments' | 'go-around' | 'cleared' | 'landed';
  name: string;
  detail: string;
  soon?: boolean;
};

export const LANDING = 'Landing 42: rate limit the API';

export const FIXES: Fix[] = [
  { id: 'plan', name: 'Flight plan', detail: 'Rate limit the API in src/api', soon: true },
  { id: 'takeoff', name: 'Takeoff', detail: 'Session starts with context' },
  { id: 'route', name: 'Route', detail: '4 commits, 3 memories used' },
  { id: 'instruments', name: 'Instruments', detail: 'Read on every push' },
  { id: 'go-around', name: 'Go-around', detail: 'Findings went back, the agent pushed again' },
  { id: 'cleared', name: 'Cleared to land', detail: 'Checks passed, approved' },
  { id: 'landed', name: 'Landed', detail: 'On main, in order' },
];

export type Dial = { id: 'risk' | 'slop' | 'drift'; name: string; value: string; detail: string };

export const DIALS: Dial[] = [
  { id: 'risk', name: 'Risk', value: 'Low', detail: 'Small logic change' },
  { id: 'slop', name: 'Slop', value: 'Low', detail: 'Down over 5 pushes' },
  { id: 'drift', name: 'Intent drift', value: 'On course', detail: 'Diff matches the plan' },
];

export const CHECKS = ['Tests', 'Code review', 'Security review'];

export const APPROVAL = '1 of 1';

export const AHEAD = 'Landing 41 went first';

export const BLACK_BOX = 'Black box: the session transcript and context are kept.';

/** One drawing of the route: the wide profile or the phone's rail. */
export type RouteShape = {
  taxi: string;
  main: string;
  loop: string;
  flown: string;
};

export const WIDE: RouteShape = {
  taxi: 'M0 270 L200 270',
  main: 'M200 270 C270 270 320 72 400 70 L600 70 C640 70 660 100 700 120 L1000 270 L1150 270',
  loop: 'M752 146 C800 150 850 120 836 88 C822 46 745 38 722 72 C712 86 706 104 712 126',
  flown:
    'M0 270 L200 270 C270 270 320 72 400 70 L600 70 C640 70 660 100 700 120 L752 146 C800 150 850 120 836 88 C822 46 745 38 722 72 C712 86 706 104 712 126 L1000 270 L1150 270',
};

/** Fixes on the wide profile: x is a column's left edge, so the labels hang from them. */
export const WIDE_FIXES = [
  { x: 0, y: 270 },
  { x: 200, y: 270 },
  { x: 400, y: 70 },
  { x: 600, y: 70 },
  { x: 800, y: 170 },
  { x: 1000, y: 270 },
];

/** The commits the example Landing made, the last one on the go-around. */
export const WIDE_COMMITS = [
  { x: 450, y: 70 },
  { x: 500, y: 70 },
  { x: 550, y: 70 },
  { x: 782, y: 51.5 },
];

export const TALL: RouteShape = {
  taxi: 'M10 14 L10 90',
  main: 'M10 90 C10 130 56 130 56 166 L56 242 C56 275 52 285 48.5 300 L10 470 L10 556',
  loop: 'M37 350 C42 372 80 364 78 322 C77 292 62 276 48.5 300',
  flown:
    'M10 14 L10 90 C10 130 56 130 56 166 L56 242 C56 275 52 285 48.5 300 L37 350 C42 372 80 364 78 322 C77 292 62 276 48.5 300 L10 470 L10 556',
};

export const TALL_FIXES = [
  { x: 10, y: 14 },
  { x: 10, y: 90 },
  { x: 56, y: 166 },
  { x: 56, y: 242 },
  { x: 28, y: 394 },
  { x: 10, y: 470 },
];

export const TALL_COMMITS = [
  { x: 56, y: 186 },
  { x: 56, y: 204 },
  { x: 56, y: 222 },
  { x: 75, y: 303 },
];
