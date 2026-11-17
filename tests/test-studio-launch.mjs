// Studio launch: per-platform browser command and the plain, linkable URL line.
import assert from 'node:assert/strict';
import { browserCommand, launchLines } from '../dist/commands/db.js';

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const URL_KEYED = 'http://127.0.0.1:4983/?key=abc123=xyz';

test('win32 uses cmd start with quoted title and URL', () => {
  const c = browserCommand(URL_KEYED, 'win32');
  assert.equal(c.command, 'cmd');
  assert.deepEqual(c.args, ['/c', 'start', '""', `"${URL_KEYED}"`]);
});

test('win32 keeps ? and = intact in the arguments', () => {
  const c = browserCommand(URL_KEYED, 'win32');
  assert.ok(c.args[3].includes('?key=abc123=xyz'));
});

test('win32 options set windowsVerbatimArguments and hide the window', () => {
  const { options } = browserCommand(URL_KEYED, 'win32');
  assert.equal(options.windowsVerbatimArguments, true);
  assert.equal(options.windowsHide, true);
  assert.equal(options.detached, true);
  assert.equal(options.stdio, 'ignore');
});

test('darwin uses open with the bare URL', () => {
  const c = browserCommand(URL_KEYED, 'darwin');
  assert.equal(c.command, 'open');
  assert.deepEqual(c.args, [URL_KEYED]);
});

test('linux uses xdg-open with the bare URL', () => {
  const c = browserCommand(URL_KEYED, 'linux');
  assert.equal(c.command, 'xdg-open');
  assert.deepEqual(c.args, [URL_KEYED]);
});

test('non-win32 options do not set windowsVerbatimArguments', () => {
  assert.notEqual(browserCommand(URL_KEYED, 'linux').options.windowsVerbatimArguments, true);
});

test('URL line has no ANSI escape and nothing after the URL', () => {
  const lines = launchLines(URL_KEYED, true);
  assert.equal(lines[0], '  Open the Studio:');
  assert.equal(lines[1], URL_KEYED);
  assert.equal(lines.length, 2);
  assert.ok(!/\u001b/.test(lines[1]));
});

test('headless start adds the note line after the URL', () => {
  const lines = launchLines('http://127.0.0.1:4983/', false);
  assert.equal(lines[1], 'http://127.0.0.1:4983/');
  assert.equal(lines.length, 3);
  assert.match(lines[2], /Headless start/);
});

if (failures) {
  console.log(`\n${failures} studio-launch test(s) failed.`);
  process.exit(1);
}
console.log('\nstudio-launch: all tests passed.');
