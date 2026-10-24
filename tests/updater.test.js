/**
 * updater.test.js
 * -----------------------------------------------------------------------------
 * Pruebas del servicio de actualizaciones con un "autoUpdater" FALSO, para no
 * necesitar internet ni una versión publicada en GitHub.
 * -----------------------------------------------------------------------------
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Updater } = require('../src/services/updater');

/** Crea un autoUpdater falso que se comporta según el guion recibido. */
function fakeAutoUpdater({ available = true, failWith = null } = {}) {
  const au = new EventEmitter();
  au.calls = [];
  au.checkForUpdates = async () => {
    au.calls.push('check');
    au.emit('checking-for-update');
    if (failWith) { au.emit('error', new Error(failWith)); throw new Error(failWith); }
    if (available) au.emit('update-available', { version: '1.1.0', releaseNotes: 'Mejoras' });
    else au.emit('update-not-available', {});
  };
  au.downloadUpdate = async () => {
    au.calls.push('download');
    au.emit('download-progress', { percent: 50 });
    au.emit('update-downloaded', { version: '1.1.0' });
  };
  au.quitAndInstall = (...args) => au.calls.push(['install', ...args]);
  return au;
}

test('actualizador: en desarrollo queda "unavailable" y no hace nada', async () => {
  const u = new Updater({ enabled: false, currentVersion: '1.0.0' });
  assert.equal(u.state.status, 'unavailable');
  assert.equal((await u.check()).status, 'unavailable');
  assert.equal(u.install(), false);
});

test('actualizador: flujo completo buscar -> descargar -> instalar', async () => {
  const au = fakeAutoUpdater();
  const u = new Updater({ enabled: true, currentVersion: '1.0.0', autoUpdater: au });
  assert.equal(au.autoDownload, false, 'nunca descarga sin permiso');

  const seen = [];
  u.on('status', (s) => seen.push(s.status));

  assert.equal(u.install(), false, 'no se puede instalar antes de descargar');
  await u.check();
  assert.equal(u.state.status, 'available');
  assert.equal(u.state.version, '1.1.0');
  assert.ok(!au.calls.includes('download'), 'encontrar una versión no la descarga');

  await u.download();
  assert.equal(u.state.status, 'downloaded');
  assert.equal(u.state.percent, 100);

  assert.equal(u.install(), true);
  assert.deepEqual(au.calls.at(-1), ['install', false, true]);
  assert.deepEqual(seen, ['checking', 'available', 'downloading', 'downloading', 'downloaded']);
});

test('actualizador: sin versión nueva queda en "none"', async () => {
  const u = new Updater({ enabled: true, currentVersion: '1.0.0', autoUpdater: fakeAutoUpdater({ available: false }) });
  await u.check();
  assert.equal(u.state.status, 'none');
});

test('actualizador: los errores no lanzan y se traducen a mensajes claros', async () => {
  const u404 = new Updater({ enabled: true, currentVersion: '1.0.0', autoUpdater: fakeAutoUpdater({ failWith: 'Cannot find latest.yml (404)' }) });
  await u404.check();
  assert.equal(u404.state.status, 'error');
  assert.match(u404.state.error, /Todavía no hay versiones/);

  const uNet = new Updater({ enabled: true, currentVersion: '1.0.0', autoUpdater: fakeAutoUpdater({ failWith: 'getaddrinfo ENOTFOUND github.com' }) });
  await uNet.check();
  assert.match(uNet.state.error, /conexión/);
});

test('actualizador: no descarga si no hay versión disponible', async () => {
  const au = fakeAutoUpdater({ available: false });
  const u = new Updater({ enabled: true, currentVersion: '1.0.0', autoUpdater: au });
  await u.check();
  await u.download();
  assert.ok(!au.calls.includes('download'));
});
