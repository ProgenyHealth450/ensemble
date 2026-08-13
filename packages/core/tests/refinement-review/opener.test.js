/**
 * Unit tests for the refinement-review URL opener.
 *
 * The opener is a small fire-and-forget helper called by `startServer` when
 * `--collab` and `open: true` are both set. The tests pin down:
 *
 *   - per-platform argv shape (darwin / linux / win32)
 *   - `child.unref()` is always called on success
 *   - the spawn result is returned in a structured shape
 *   - ENOENT post-spawn is surfaced as `{ opened: false, reason: 'spawn-error' }`
 *   - empty URLs and unsupported platforms fail closed with structured reasons
 *
 * `spawn` is injected via the `opts.spawn` override so the tests do not
 * touch the real child process. The fake child is a thin EventEmitter;
 * `openUrl` listens for `'spawn'` and `'error'` events exactly as Node's
 * `child_process.spawn` delivers them.
 */
'use strict';

const { EventEmitter } = require('events');
const { openUrl, renderCommand } = require('../../lib/refinement-review/opener');

/**
 * Build a `spawn` spy whose return value emits `'spawn'` on the next tick.
 * Returns `{ spawn, childFor }` where `childFor` retrieves the EventEmitter
 * returned by the (single) spawn call so additional events can be driven.
 */
function succeedingSpawn() {
  let captured;
  const spawn = jest.fn(() => {
    const child = new EventEmitter();
    child.unref = jest.fn();
    process.nextTick(() => child.emit('spawn'));
    captured = child;
    return child;
  });
  return { spawn, getChild: () => captured };
}

/**
 * Build a `spawn` spy whose return value emits `'error'` on the next tick
 * with the given Error instance.
 */
function failingSpawn(err) {
  let captured;
  const spawn = jest.fn(() => {
    const child = new EventEmitter();
    child.unref = jest.fn();
    process.nextTick(() => child.emit('error', err));
    captured = child;
    return child;
  });
  return { spawn, getChild: () => captured };
}

describe('openUrl', () => {
  test('darwin: argv shape and options', async () => {
    const { spawn, getChild } = succeedingSpawn();
    const result = await openUrl('http://127.0.0.1:51294/?token=abc', {
      platform: 'darwin',
      spawn,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      'open',
      ['http://127.0.0.1:51294/?token=abc'],
      { detached: true, stdio: 'ignore' },
    );
    expect(result).toEqual({
      opened: true,
      command: 'open http://127.0.0.1:51294/?token=abc',
    });
    expect(getChild().unref).toHaveBeenCalledTimes(1);
  });

  test('linux: spawns xdg-open with detached stdio:ignore', async () => {
    const { spawn, getChild } = succeedingSpawn();
    const result = await openUrl('https://example.com/?x=1', {
      platform: 'linux',
      spawn,
    });
    expect(spawn).toHaveBeenCalledWith(
      'xdg-open',
      ['https://example.com/?x=1'],
      { detached: true, stdio: 'ignore' },
    );
    expect(result.command).toBe('xdg-open https://example.com/?x=1');
    expect(getChild().unref).toHaveBeenCalledTimes(1);
  });

  test('win32: spawns rundll32 url.dll,FileProtocolHandler <url>', async () => {
    // cmd.exe /c start "" MUST NOT be used: cmd.exe interprets %2F / %26 / %3F
    // as environment-variable references and corrupts the encoded bearer
    // token. rundll32 is a binary that hands the URL straight to the
    // URL protocol handler via url.dll's FileProtocolHandler entry point.
    const { spawn, getChild } = succeedingSpawn();
    const result = await openUrl('https://example.com/path', {
      platform: 'win32',
      spawn,
    });
    expect(spawn).toHaveBeenCalledWith(
      'rundll32.exe',
      ['url.dll,FileProtocolHandler', 'https://example.com/path'],
      { detached: true, stdio: 'ignore' },
    );
    expect(result.opened).toBe(true);
    expect(result.command).toBe(
      'rundll32.exe url.dll,FileProtocolHandler https://example.com/path',
    );
    expect(getChild().unref).toHaveBeenCalledTimes(1);
  });

  test('win32: encoded URL containing %2F %26 %3F %3D is passed unchanged (cmd.exe would corrupt)', async () => {
    // Regression: the opener must accept percent-encoded URLs that would be
    // interpreted as env-var expansions if a shell were involved. This is
    // the exact token shape used by the smoke test and the share URL.
    const url = 'http://127.0.0.1:51294/?token=abc%2F%26%3Ftoken%3Dx';
    const { spawn } = succeedingSpawn();
    await openUrl(url, { platform: 'win32', spawn });
    expect(spawn).toHaveBeenCalledWith(
      'rundll32.exe',
      ['url.dll,FileProtocolHandler', url],
      { detached: true, stdio: 'ignore' },
    );
  });

  test('returns { opened:false, reason:"invalid-url" } for empty URL', async () => {
    const spawn = jest.fn();
    const result = await openUrl('', { platform: 'darwin', spawn });
    expect(spawn).not.toHaveBeenCalled();
    expect(result).toEqual({ opened: false, reason: 'invalid-url' });
  });

  test('returns { opened:false, reason:"invalid-url" } for non-string URL', async () => {
    const spawn = jest.fn();
    const result = await openUrl(null, { platform: 'darwin', spawn });
    expect(result).toEqual({ opened: false, reason: 'invalid-url' });
  });

  test('returns { opened:false, reason:"unsupported-platform" } for freebsd', async () => {
    const spawn = jest.fn();
    const result = await openUrl('http://x', { platform: 'freebsd', spawn });
    expect(spawn).not.toHaveBeenCalled();
    expect(result).toEqual({ opened: false, reason: 'unsupported-platform' });
  });

  test('surfaces post-spawn ENOENT as { opened:false, reason:"spawn-error" }', async () => {
    const err = new Error('spawn xdg-open ENOENT');
    err.code = 'ENOENT';
    const { spawn } = failingSpawn(err);
    const result = await openUrl('http://127.0.0.1:51294', {
      platform: 'linux',
      spawn,
    });
    expect(result.opened).toBe(false);
    expect(result.reason).toBe('spawn-error');
    expect(result.error).toMatch(/ENOENT/);
  });

  test('synchronous spawn throw is captured as { opened:false, reason:"spawn-error" }', async () => {
    const spawn = jest.fn(() => {
      throw new Error('sync boom');
    });
    const result = await openUrl('http://x', { platform: 'darwin', spawn });
    expect(result).toEqual({
      opened: false,
      reason: 'spawn-error',
      error: 'sync boom',
    });
  });

  test('returns { opened:false, reason:"spawn-no-handle" } if spawn returns null', async () => {
    const spawn = jest.fn(() => null);
    const result = await openUrl('http://x', { platform: 'darwin', spawn });
    expect(result).toEqual({ opened: false, reason: 'spawn-no-handle' });
  });

  test('falls through to { opened:true } if neither spawn nor error fires within 250ms', async () => {
    jest.useFakeTimers();
    try {
      let captured;
      const spawn = jest.fn(() => {
        const child = new EventEmitter();
        child.unref = jest.fn();
        // Emit neither 'spawn' nor 'error' — simulates a Node version that
        // does not fire 'spawn' for detached children.
        captured = child;
        return child;
      });
      const promise = openUrl('http://x', { platform: 'darwin', spawn });
      // Allow microtasks to flush so the Promise constructor body runs.
      await Promise.resolve();
      jest.advanceTimersByTime(300);
      const result = await promise;
      expect(result.opened).toBe(true);
      expect(captured.unref).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('renderCommand', () => {
  test('passes through simple args', () => {
    expect(renderCommand('open', ['http://x'])).toBe('open http://x');
  });

  test('quotes args with whitespace', () => {
    expect(renderCommand('cmd', ['/c', 'start', '""', 'has space']))
      .toBe('cmd /c start """" "has space"');
  });

  test('quotes args with shell metacharacters', () => {
    expect(renderCommand('open', ['a&b|c'])).toBe('open "a&b|c"');
  });
});
