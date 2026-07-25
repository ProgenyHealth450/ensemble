'use strict';

// AC-005-1 (pass/fail shown to Sonia before the next AC) is intentionally not
// covered here: resolveRunConfig only maps mode -> launch/auth config, it has
// no runResult/display data. That's orchestrator/agent behavior, not this
// module's concern.

const { resolveRunConfig, VALID_MODES } = require('../lib/test-runner-mode');

describe('resolveRunConfig (AC-013-3: headed uses Sonia\'s interactive Entra login)', () => {
  test('headed mode always resolves to interactive-entra-login with no auth state, regardless of authStatePath', () => {
    expect(resolveRunConfig('headed')).toEqual({
      mode: 'headed',
      headless: false,
      auth: { strategy: 'interactive-entra-login', authStatePath: null },
    });

    // Even if a caller mistakenly threads an authStatePath through for headed,
    // it must be ignored -- headed never depends on stored auth.
    expect(resolveRunConfig('headed', '/secure/cribs-e2e-auth-state.json')).toEqual({
      mode: 'headed',
      headless: false,
      auth: { strategy: 'interactive-entra-login', authStatePath: null },
    });
  });
});

describe('resolveRunConfig (AC-013-4: headless authenticates via cribs-e2e-auth-state.json)', () => {
  test('headless mode with a valid authStatePath preserves the exact path, same mechanism as the nightly suite', () => {
    const authStatePath = '/secure/cribs-e2e-auth-state.json';

    expect(resolveRunConfig('headless', authStatePath)).toEqual({
      mode: 'headless',
      headless: true,
      auth: { strategy: 'stored-storage-state', authStatePath },
    });
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace-only string', '   '],
  ])('headless mode with %s authStatePath throws a clear error, not a silent fallback to headed', (_label, value) => {
    expect(() => resolveRunConfig('headless', value)).toThrow(/requires authStatePath/);
  });

  test.each([
    ['number', 42],
    ['object', { path: '/secure/cribs-e2e-auth-state.json' }],
    ['array', ['/secure/cribs-e2e-auth-state.json']],
  ])('headless mode with a non-string authStatePath (%s) throws', (_label, value) => {
    expect(() => resolveRunConfig('headless', value)).toThrow(/requires authStatePath/);
  });
});

describe('resolveRunConfig (invalid mode -> throws, no silent default)', () => {
  test.each([
    ['typo', 'haedless'],
    ['case variant', 'Headed'],
    ['case variant', 'HEADLESS'],
    ['non-string (number)', 1],
    ['non-string (object)', { mode: 'headed' }],
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
  ])('mode = %s (%p) throws', (_label, value) => {
    expect(() => resolveRunConfig(value)).toThrow();
  });

  test('error message names the invalid value and the valid options', () => {
    expect(() => resolveRunConfig('slow')).toThrow(/Invalid mode 'slow'/);
    expect(() => resolveRunConfig('slow')).toThrow(/headed/);
    expect(() => resolveRunConfig('slow')).toThrow(/headless/);
  });
});

describe('resolveRunConfig (VALID_MODES export)', () => {
  test('exposes exactly the two supported modes', () => {
    expect(VALID_MODES).toEqual(['headed', 'headless']);
  });
});

describe('resolveRunConfig (purity: no key leakage, no shared mutated references)', () => {
  test('same inputs produce equal but independent objects across repeated calls', () => {
    const first = resolveRunConfig('headed');
    const second = resolveRunConfig('headed');
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.auth).not.toBe(first.auth);

    first.auth.strategy = 'mutated';
    expect(resolveRunConfig('headed').auth.strategy).toBe('interactive-entra-login');
  });

  test('headless results for different authStatePaths do not share the auth object', () => {
    const a = resolveRunConfig('headless', '/path/a.json');
    const b = resolveRunConfig('headless', '/path/b.json');

    expect(a.auth).not.toBe(b.auth);
    expect(a.auth.authStatePath).toBe('/path/a.json');
    expect(b.auth.authStatePath).toBe('/path/b.json');
  });

  test('result shape has exactly the documented keys, no leakage', () => {
    const headed = resolveRunConfig('headed');
    expect(Object.keys(headed).sort()).toEqual(['auth', 'headless', 'mode']);
    expect(Object.keys(headed.auth).sort()).toEqual(['authStatePath', 'strategy']);

    const headless = resolveRunConfig('headless', '/path/a.json');
    expect(Object.keys(headless).sort()).toEqual(['auth', 'headless', 'mode']);
    expect(Object.keys(headless.auth).sort()).toEqual(['authStatePath', 'strategy']);
  });
});
