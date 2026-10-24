/**
 * background.test.js
 * -----------------------------------------------------------------------------
 * Pruebas de lo que hace la app en SEGUNDO PLANO:
 *   - Detectar enlaces copiados al portapapeles (para avisar con una notificación).
 *   - El ajuste "abrir con Windows".
 *
 * Ejecutar con:  npm test
 * -----------------------------------------------------------------------------
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { ClipboardWatcher } = require('../src/main/clipboardWatcher');
const { createDefaultSettings, sanitizeSettings } = require('../src/services/settingsService');

/** Vigilante con un portapapeles falso: `clip.text` es lo que "hay copiado". */
function fakeWatcher(onUrl) {
  const clip = { text: '' };
  const watcher = new ClipboardWatcher(onUrl, 10);
  watcher.read = async () => clip.text;
  return { watcher, clip };
}

test('portapapeles: avisa de enlaces de archivo y de vídeo, y solo una vez cada uno', async () => {
  const found = [];
  const { watcher, clip } = fakeWatcher((url) => found.push(url));

  clip.text = 'https://youtu.be/ya-estaba-copiado'; // Ya copiado antes de empezar: no se avisa.
  watcher.start();
  await watcher.check();

  const copy = async (text) => {
    clip.text = text;
    await watcher.check();
    await watcher.check(); // Mirar dos veces el mismo texto no debe avisar dos veces.
  };
  await copy('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await copy('hola, esto no es un enlace');
  await copy('https://www.youtube.com/'); // Portada: no es un vídeo.
  await copy('https://ejemplo.com/programa.zip');
  await copy('  https://vimeo.com/12345  '); // Con espacios alrededor.
  watcher.stop();

  assert.deepEqual(found, [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://ejemplo.com/programa.zip',
    'https://vimeo.com/12345',
  ]);
});

test('portapapeles: ignore() evita avisar de lo que copió la propia app', async () => {
  const found = [];
  const { watcher, clip } = fakeWatcher((url) => found.push(url));
  watcher.start();
  await watcher.check();
  watcher.ignore('https://ejemplo.com/a.zip');
  clip.text = 'https://ejemplo.com/a.zip';
  await watcher.check();
  watcher.stop();
  assert.deepEqual(found, []);
});

test('ajustes: abrir con Windows está activado por defecto y se puede desactivar', () => {
  const current = createDefaultSettings('C:/Descargas');
  assert.equal(current.launchAtStartup, true);
  assert.equal(sanitizeSettings({ launchAtStartup: false }, current).launchAtStartup, false);
  assert.equal(sanitizeSettings({ launchAtStartup: 'no' }, current).launchAtStartup, true, 'un valor que no es booleano se ignora');
});
