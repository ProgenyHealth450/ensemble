'use strict';

// TRD-014-TEST: formalizes spec-writer.js's embedded require.main===module
// self-check into Jest, plus a bit more (see below). AC references:
//   - AC-006-1 (scaffold correctness) -- the foundation append builds on.
//   - AC-006-2 (append to the existing file covering the same REQ, not a
//     redundant new file) -- this file's main focus.

const {
  scaffoldNewSpecFile,
  appendTestMethod,
  writeOrAppendSpec,
  maskLiteralsAndComments,
  VALID_BASE_CLASSES,
} = require('../lib/spec-writer');

/** The class body's own closing brace, followed by the namespace's, at EOF. */
const closesCleanly = (content) => /\}\r?\n {4}\}\r?\n\}\r?\n?$/.test(content);
const testMethodCount = (content) => (content.match(/\[Test\]/g) || []).length;

describe('scaffoldNewSpecFile (AC-006-1: scaffold correctness)', () => {
  test.each(VALID_BASE_CLASSES)('accepts baseClass %s and extends it in the generated class', (baseClass) => {
    const result = scaffoldNewSpecFile({ className: 'LoginTests', baseClass, testName: 'Should_Load' });
    expect(result).toContain(`public class LoginTests : ${baseClass}`);
  });

  test.each([
    ['missing', undefined],
    ['empty string', ''],
    ['unsupported value', 'SomeOtherBase'],
    ['wrong case', 'pagetest'],
  ])('rejects an invalid baseClass (%s)', (_label, baseClass) => {
    expect(() => scaffoldNewSpecFile({ className: 'LoginTests', baseClass, testName: 'Should_Load' })).toThrow(
      /baseClass must be one of/
    );
  });

  test('carries [TestCategory("E2E")] on the class', () => {
    const result = scaffoldNewSpecFile({ className: 'LoginTests', baseClass: 'PageTest', testName: 'Should_Load' });
    expect(result).toContain('[TestCategory("E2E")]');
  });

  test('default test body uses TestConfiguration.* rather than a hardcoded URL literal', () => {
    const result = scaffoldNewSpecFile({ className: 'LoginTests', baseClass: 'PageTest', testName: 'Should_Load' });
    expect(result).toContain('TestConfiguration.QaBaseUrl');
    expect(result).not.toMatch(/https?:\/\//);
  });

  test('a caller-supplied testBody is used verbatim instead of the TestConfiguration.* default', () => {
    const result = scaffoldNewSpecFile({
      className: 'CaseSearchTests',
      baseClass: 'PageTest',
      testName: 'Should_Filter_By_CaseId',
      testBody: 'await Page.GotoAsync(TestConfiguration.QaBaseUrl + "/cases/" + TestConfiguration.SampleCaseId);',
    });
    expect(result).toContain('TestConfiguration.SampleCaseId');
    expect(result).not.toContain('await Page.GotoAsync(TestConfiguration.QaBaseUrl);\n');
  });

  test('invalid className throws instead of silently generating malformed C#', () => {
    expect(() =>
      scaffoldNewSpecFile({ className: '1Bad', baseClass: 'PageTest', testName: 'Should_Load' })
    ).toThrow(/className must be a non-empty, valid C# identifier/);
  });
});

describe('appendTestMethod (AC-006-2: append to the same file, no redundant new file)', () => {
  test('a second AC test appended to a scaffolded file lands in the same single class, both methods present in order, braces balanced', () => {
    const scaffolded = scaffoldNewSpecFile({
      className: 'LoginTests',
      baseClass: 'AuthenticatedPageTest',
      acId: 'AC-006-1',
      testName: 'Should_Redirect_To_Login_When_Unauthenticated',
    });

    const appended = appendTestMethod(scaffolded, {
      acId: 'AC-006-2',
      testName: 'Should_Show_Error_On_Bad_Password',
      testBody: 'await Page.FillAsync("#password", "wrong");',
    });

    // both methods present, in the order they were added
    expect(appended).toContain('Should_Redirect_To_Login_When_Unauthenticated');
    expect(appended).toContain('Should_Show_Error_On_Bad_Password');
    expect(appended.indexOf('Should_Redirect_To_Login_When_Unauthenticated')).toBeLessThan(
      appended.indexOf('Should_Show_Error_On_Bad_Password')
    );

    // exactly one class/namespace declaration -- append never creates a
    // redundant second file/class for the same REQ
    expect((appended.match(/public class LoginTests/g) || []).length).toBe(1);
    expect((appended.match(/namespace Application.E2E.Tests/g) || []).length).toBe(1);

    // structurally sound: braces balance, file still ends class-close then namespace-close
    expect((appended.match(/\{/g) || []).length).toBe((appended.match(/\}/g) || []).length);
    expect(closesCleanly(appended)).toBe(true);
    expect(testMethodCount(appended)).toBe(2);

    // a third AC under the same REQ composes the same way, not just two
    const appendedThrice = appendTestMethod(appended, {
      acId: 'AC-006-3',
      testName: 'Should_Lock_Account_After_Failed_Attempts',
    });

    expect(appendedThrice).toContain('Should_Redirect_To_Login_When_Unauthenticated');
    expect(appendedThrice).toContain('Should_Show_Error_On_Bad_Password');
    expect(appendedThrice).toContain('Should_Lock_Account_After_Failed_Attempts');
    expect(appendedThrice.indexOf('Should_Show_Error_On_Bad_Password')).toBeLessThan(
      appendedThrice.indexOf('Should_Lock_Account_After_Failed_Attempts')
    );
    expect((appendedThrice.match(/public class LoginTests/g) || []).length).toBe(1);
    expect((appendedThrice.match(/namespace Application.E2E.Tests/g) || []).length).toBe(1);
    expect((appendedThrice.match(/\{/g) || []).length).toBe((appendedThrice.match(/\}/g) || []).length);
    expect(closesCleanly(appendedThrice)).toBe(true);
    expect(testMethodCount(appendedThrice)).toBe(3);
  });

  test('rejects empty existingContent -- callers must use scaffoldNewSpecFile instead', () => {
    expect(() => appendTestMethod('', { testName: 'X' })).toThrow(/requires a non-empty existingContent/);
  });

  test('rejects content with no locatable class declaration', () => {
    expect(() => appendTestMethod('not csharp at all', { testName: 'X' })).toThrow(/Could not locate a "class/);
  });
});

describe('appendTestMethod (regression: brace-depth counting must ignore literals/comments)', () => {
  const scaffolded = scaffoldNewSpecFile({
    className: 'LoginTests',
    baseClass: 'AuthenticatedPageTest',
    testName: 'Should_Redirect_To_Login',
  });

  /**
   * Appends a trap-containing test body, then appends ONE MORE test on top --
   * forcing findClassBodyRange to re-scan the already-written trap text. A
   * corrupted splice would land the follow-on test inside the trap's own
   * literal/comment, mangle the trailing closing braces, and/or lose a method.
   */
  function assertTrapSurvivesAppend(trapText, trapTestName, followOnTestName) {
    const withTrap = appendTestMethod(scaffolded, { testName: trapTestName, testBody: trapText });
    expect(withTrap).toContain(trapText);

    const afterFollowOn = appendTestMethod(withTrap, { testName: followOnTestName });
    expect(afterFollowOn).toContain(trapText); // byte-for-byte survival, not mangled
    expect(afterFollowOn.indexOf(trapTestName)).toBeLessThan(afterFollowOn.indexOf(followOnTestName));
    expect((afterFollowOn.match(/public class LoginTests/g) || []).length).toBe(1);
    expect(testMethodCount(afterFollowOn)).toBe(3); // scaffolded's own + trap + follow-on, none lost
    expect(closesCleanly(afterFollowOn)).toBe(true);
    return afterFollowOn;
  }

  test('a string literal with an unbalanced brace (`var trap = "}}}";`) survives a following append untouched', () => {
    assertTrapSurvivesAppend(
      'var trap = "}}}"; // unbalanced braces live inside this string literal',
      'Should_Handle_Weird_String',
      'Should_Run_After_The_Trap'
    );
  });

  test('@$"..." (verbatim-interpolated, @ before $) with an embedded backslash survives a following append untouched', () => {
    assertTrapSurvivesAppend(
      'var trap = @$"C:\\Temp\\";',
      'Should_Handle_At_Dollar_Verbatim_Trap',
      'Should_Run_After_At_Dollar_Verbatim_Trap'
    );
  });

  test('$@"..." ($ before @) with an embedded backslash survives a following append untouched', () => {
    assertTrapSurvivesAppend(
      'var trap = $@"C:\\Temp\\";',
      'Should_Handle_Dollar_At_Verbatim_Trap',
      'Should_Run_After_Dollar_At_Verbatim_Trap'
    );
  });

  test('both verbatim-interpolated orderings can be appended back to back without corrupting each other', () => {
    const withFirst = appendTestMethod(scaffolded, {
      testName: 'Should_Handle_At_Dollar_Verbatim_Trap',
      testBody: 'var trap = @$"C:\\Temp\\";',
    });
    const withBoth = appendTestMethod(withFirst, {
      testName: 'Should_Handle_Dollar_At_Verbatim_Trap',
      testBody: 'var trap = $@"C:\\Temp\\";',
    });

    expect(withBoth).toContain('var trap = @$"C:\\Temp\\";');
    expect(withBoth).toContain('var trap = $@"C:\\Temp\\";');
    expect(testMethodCount(withBoth)).toBe(3);
    expect(closesCleanly(withBoth)).toBe(true);
  });
});

describe('maskLiteralsAndComments (direct coverage: the fix underlying the brace-depth regression)', () => {
  test('preserves overall length -- masking only replaces chars, never inserts/removes', () => {
    const content = 'class X { "a}b" }';
    expect(maskLiteralsAndComments(content).length).toBe(content.length);
  });

  test('masks braces inside string, char, line-comment, and block-comment bodies', () => {
    const content = [
      'var s = "}"; // a comment with a } brace',
      "var c = '}';",
      '/* block } comment */',
    ].join('\n');

    const masked = maskLiteralsAndComments(content);
    // every brace in the source was inside a literal/comment -- none should survive masking
    expect(masked).not.toMatch(/[{}]/);
  });

  test('does not mask braces that are real code (outside any literal/comment)', () => {
    const content = 'if (x) { return; }';
    const masked = maskLiteralsAndComments(content);
    expect(masked).toContain('{');
    expect(masked).toContain('}');
  });

  test('masks both @$"..." and $@"..." verbatim-interpolated string bodies, including embedded backslashes', () => {
    const atDollar = maskLiteralsAndComments('var t = @$"C:\\Temp\\{oops}";');
    const dollarAt = maskLiteralsAndComments('var t = $@"C:\\Temp\\{oops}";');

    expect(atDollar).not.toMatch(/[{}]/);
    expect(dollarAt).not.toMatch(/[{}]/);
  });
});

describe('writeOrAppendSpec (dispatch logic: AC-006-1 vs AC-006-2 routing)', () => {
  test.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace-only string', '   '],
  ])('%s existingContent scaffolds a brand-new file rather than throwing', (_label, existingContent) => {
    const result = writeOrAppendSpec(existingContent, {
      className: 'NewTests',
      baseClass: 'PageTest',
      testName: 'Should_Load_Home_Page',
    });

    expect(result).toContain('public class NewTests : PageTest');
    expect(testMethodCount(result)).toBe(1);
  });

  test('non-empty existingContent appends rather than re-scaffolding', () => {
    const fresh = writeOrAppendSpec(null, {
      className: 'NewTests',
      baseClass: 'PageTest',
      testName: 'Should_Load_Home_Page',
    });
    const grown = writeOrAppendSpec(fresh, { testName: 'Should_Show_Nav_Bar' });

    expect(grown).toContain('Should_Load_Home_Page');
    expect(grown).toContain('Should_Show_Nav_Bar');
    expect((grown.match(/public class NewTests/g) || []).length).toBe(1);
    expect(testMethodCount(grown)).toBe(2);
  });
});
