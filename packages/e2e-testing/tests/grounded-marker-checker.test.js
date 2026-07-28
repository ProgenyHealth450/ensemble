'use strict';

const { extractGroundedMarkers, buildEnvironmentMismatchHint } = require('../lib/grounded-marker-checker');

describe('extractGroundedMarkers', () => {
  test('extracts a single-class attribute value (the exact CRIBs-incident shape)', () => {
    const diff = [
      'diff --git a/src/Nav.jsx b/src/Nav.jsx',
      '@@ -1,3 +1,3 @@',
      '-    <a className="nav-legacy">Work Items</a>',
      '+    <a className="nav-icon-stack">Work Items</a>',
    ].join('\n');
    expect(extractGroundedMarkers(diff)).toEqual(expect.arrayContaining(['nav-icon-stack']));
    // the removed (-) line's old class must never be treated as a marker
    expect(extractGroundedMarkers(diff)).not.toEqual(expect.arrayContaining(['nav-legacy']));
  });

  test('tokenizes a multi-class attribute value into individually-checkable markers', () => {
    const diff = '+    <a class="nav-icon-stack legacy-nav highlighted">Work Items</a>';
    const markers = extractGroundedMarkers(diff);
    expect(markers).toEqual(expect.arrayContaining(['nav-icon-stack', 'legacy-nav', 'highlighted']));
    // the whole value is also a candidate (e.g. an exact-match attribute check)
    expect(markers).toEqual(expect.arrayContaining(['nav-icon-stack legacy-nav highlighted']));
  });

  test('extracts data-testid values and quoted text -- no framework assumption', () => {
    const diff = [
      "+  <button data-testid='submit-claim-button'>Submit Claim</button>",
      '+  const label = "Your claim has been submitted";',
    ].join('\n');
    const markers = extractGroundedMarkers(diff);
    expect(markers).toEqual(expect.arrayContaining(['submit-claim-button', 'Submit Claim', 'Your claim has been submitted']));
  });

  test('extracts plain tag-inner text that never appears inside quotes at all', () => {
    const diff = '+  <button data-testid="submit-claim-button">Submit Claim</button>';
    expect(extractGroundedMarkers(diff)).toEqual(expect.arrayContaining(['Submit Claim']));
  });

  test('a JSX expression slot ({someVar}) is never mistaken for literal tag text', () => {
    const diff = '+  <span>{claimStatusLabel}</span>';
    expect(extractGroundedMarkers(diff)).not.toEqual(expect.arrayContaining(['{claimStatusLabel}']));
  });

  test('generic noise words are never returned as markers', () => {
    const diff = '+  if (isValid === true) { return null; }';
    expect(extractGroundedMarkers(diff)).toEqual([]);
  });

  test('too-short or punctuation-only captures are excluded, without misaligning on the next string', () => {
    const diff = '+  const x = "a"; const y = "()"; const z = "12345";';
    // "12345" has no letters -> excluded; "a" is under MARKER_MIN_LENGTH; "()" has no letters.
    // A too-short match must still consume its own closing quote correctly, or "a"'s closer
    // gets misread as the opener of a bogus match spanning into "; const y = ".
    expect(extractGroundedMarkers(diff)).toEqual([]);
  });

  test('duplicate markers across multiple added lines are deduplicated', () => {
    const diff = ['+ const a = "shared-marker";', '+ const b = "shared-marker";'].join('\n');
    expect(extractGroundedMarkers(diff)).toEqual(['shared-marker']);
  });

  test('a "+++ b/file" diff header line is never mistaken for an added line', () => {
    const diff = ['--- a/src/Nav.jsx', '+++ b/src/Nav.jsx', '+  <a className="real-marker">x</a>'].join('\n');
    expect(extractGroundedMarkers(diff)).toEqual(['real-marker']);
  });

  test('non-string/empty input -> empty array, never throws', () => {
    expect(extractGroundedMarkers(null)).toEqual([]);
    expect(extractGroundedMarkers(undefined)).toEqual([]);
    expect(extractGroundedMarkers('')).toEqual([]);
  });
});

describe('buildEnvironmentMismatchHint', () => {
  test('no markers found among those checked -> leads with the environment-mismatch hypothesis', () => {
    const hint = buildEnvironmentMismatchHint({ markersChecked: ['nav-icon-stack'], markersFound: [] });
    expect(hint).toMatch(/may mean the QA\/staging environment is not running the branch/i);
    expect(hint).toMatch(/nav-icon-stack/);
    // Hedged, not asserted as fact either way -- "may mean", never a bare claim.
    expect(hint).toMatch(/may mean/i);
  });

  test('at least one marker found -> null, no mismatch signal', () => {
    expect(buildEnvironmentMismatchHint({ markersChecked: ['a', 'b'], markersFound: ['a'] })).toBeNull();
  });

  test('nothing was checked at all -> null (no signal either way, never a false alarm)', () => {
    expect(buildEnvironmentMismatchHint({ markersChecked: [], markersFound: [] })).toBeNull();
    expect(buildEnvironmentMismatchHint()).toBeNull();
  });
});
