/**
 * media.test.js
 * -----------------------------------------------------------------------------
 * Pruebas de la descarga de VÍDEO y AUDIO (YouTube y similares):
 *   - Análisis: interpretar la respuesta de yt-dlp (vídeo, lista, errores).
 *   - Argumentos que se le pasan a yt-dlp para cada opción elegida.
 *   - Pruebas REALES con YouTube: analizar, bajar MP4 y MP3, pausar,
 *     reanudar y cancelar (necesitan internet y las herramientas de tools/).
 *
 * Ejecutar con:  npm test
 * -----------------------------------------------------------------------------
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createManager, waitFor, isFinal, startTestServer, randomData } = require('./helpers');
const { MediaTools } = require('../src/services/mediaTools');
const { MediaService, normalizeInfo, friendlyMediaError, isMediaHost, looksLikeFile } = require('../src/services/mediaService');
const { buildDownloadArgs } = require('../src/services/mediaTask');
const { sanitizeSettings, createDefaultSettings } = require('../src/services/settingsService');

const tools = new MediaTools({
  bundledDir: path.join(__dirname, '..', 'tools'),
  userDir: path.join(require('node:os').tmpdir(), 'libredescarga-test-tools'),
});
const REAL = tools.available ? {} : { skip: 'Faltan las herramientas: ejecuta "npm run tools"' };

/** Vídeo corto y público de YouTube (el primero de la historia, 19 s). */
const SHORT_VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
/** Vídeo algo más largo, para poder pausarlo a mitad. */
const LONG_VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

/* ============================= Unitarias ============================= */

test('análisis: un vídeo da una opción por calidad, de mayor a menor, con tamaños', () => {
  const info = {
    title: 'Mi vídeo', uploader: 'Canal', duration: 100, thumbnail: 'https://i/x.jpg', webpage_url: 'https://www.youtube.com/watch?v=abc',
    formats: [
      { vcodec: 'avc1', acodec: 'none', height: 720, filesize: 10_000 },
      { vcodec: 'vp9', acodec: 'none', height: 720, filesize: 8_000 },
      { vcodec: 'avc1', acodec: 'none', height: 1080, filesize_approx: 30_000 },
      { vcodec: 'avc1', acodec: 'none', height: 360, filesize: 3_000 },
      { vcodec: 'none', acodec: 'mp4a', filesize: 1_000 },
      { vcodec: 'none', acodec: 'opus', filesize: 2_000 },
    ],
  };
  const r = normalizeInfo(info, { requestedUrl: 'x', hasPlaylist: true });
  assert.equal(r.kind, 'video');
  assert.deepEqual(r.heights.map((h) => h.height), [1080, 720, 360]);
  assert.equal(r.heights[1].approxBytes, 12_000, '720p = mayor vídeo (10000) + mejor audio (2000)');
  assert.equal(r.audioApproxBytes, 2_000);
  assert.equal(r.hasPlaylist, true);
  assert.equal(r.hasVideo, true);
});

test('análisis: una canción (solo audio) no ofrece calidades de vídeo', () => {
  const r = normalizeInfo({ title: 'Canción', formats: [{ vcodec: 'none', acodec: 'mp3', abr: 128 }] }, { requestedUrl: 'https://soundcloud.com/a/b' });
  assert.equal(r.kind, 'video');
  assert.equal(r.hasVideo, false);
  assert.deepEqual(r.heights, []);
});

test('análisis: una lista devuelve sus elementos con URL; descarta los que no tienen', () => {
  const r = normalizeInfo({
    _type: 'playlist', title: 'Mi lista', uploader: 'Yo',
    entries: [
      { id: 'a', title: 'Uno', url: 'https://www.youtube.com/watch?v=a', duration: 10 },
      { id: 'b', title: 'Dos', ie_key: 'Youtube' },
      { id: 'c', title: 'Tres' },
      null,
    ],
  }, { requestedUrl: 'https://www.youtube.com/playlist?list=PL1' });
  assert.equal(r.kind, 'playlist');
  assert.equal(r.count, 2);
  assert.equal(r.entries[1].url, 'https://www.youtube.com/watch?v=b');
});

test('análisis: directos y listas vacías dan errores claros', () => {
  assert.throws(() => normalizeInfo({ is_live: true, formats: [] }, { requestedUrl: 'x' }), /directo/);
  assert.throws(() => normalizeInfo({ _type: 'playlist', entries: [] }, { requestedUrl: 'x' }), /vacía/);
});

test('sitios: reconoce páginas de vídeo y archivos directos', () => {
  assert.ok(isMediaHost('www.youtube.com') && isMediaHost('music.youtube.com') && isMediaHost('youtu.be'));
  assert.ok(!isMediaHost('ejemplo.com'));
  assert.ok(looksLikeFile(new URL('https://x.com/a/b.zip')));
  assert.ok(!looksLikeFile(new URL('https://www.youtube.com/watch?v=1')));
});

test('errores de yt-dlp: se traducen a mensajes claros', () => {
  assert.match(friendlyMediaError("ERROR: [youtube] x: Sign in to confirm you're not a bot"), /robot/);
  assert.match(friendlyMediaError('ERROR: [youtube] x: Private video. Sign in'), /privado/);
  assert.match(friendlyMediaError('ERROR: [youtube] x: Video unavailable'), /no está disponible/);
  assert.match(friendlyMediaError('ERROR: Unsupported URL: https://a.com'), /no es compatible/);
  assert.match(friendlyMediaError('ERROR: [generic] algo raro: fallo inesperado'), /fallo inesperado/);
});

test('argumentos de yt-dlp: vídeo con altura máxima y audio MP3', () => {
  const settings = { connections: 8, speedLimitKBps: 500 };
  const base = { outputBase: 'C:\\Videos\\100% Mío', settings, baseArgs: ['--base'] };
  const video = buildDownloadArgs({ url: 'https://y/v', connections: 6, media: { mode: 'video', height: 720 } }, base);
  assert.ok(video.includes('bv*[height<=720]+ba/b[height<=720]'));
  assert.ok(video.includes('mp4') && video.includes('--merge-output-format'));
  assert.equal(video[video.indexOf('-N') + 1], '6');
  assert.equal(video[video.indexOf('--limit-rate') + 1], '500K');
  assert.equal(video[video.indexOf('-o') + 1], 'C:\\Videos\\100%% Mío.%(ext)s', '"%" se escapa');
  assert.equal(video.at(-1), 'https://y/v');
  assert.ok(!video.includes('-x'));

  const best = buildDownloadArgs({ url: 'u', media: { mode: 'video', height: null } }, base);
  assert.ok(best.includes('bv*+ba/b'));

  const audio = buildDownloadArgs({ url: 'u', media: { mode: 'audio', audioFormat: 'mp3', audioQuality: 192 } }, base);
  assert.ok(audio.includes('-x') && audio.includes('--audio-format'));
  assert.equal(audio[audio.indexOf('--audio-quality') + 1], '192K');
  assert.ok(!audio.includes('--merge-output-format'));
  assert.ok(!buildDownloadArgs({ url: 'u', media: { mode: 'audio', audioFormat: 'opus' } }, base).includes('--audio-quality'));
});

test('configuración: solo se admiten navegadores conocidos para las cookies', () => {
  const current = createDefaultSettings('C:\\Descargas');
  assert.equal(sanitizeSettings({ cookiesBrowser: 'firefox' }, current).cookiesBrowser, 'firefox');
  assert.equal(sanitizeSettings({ cookiesBrowser: 'netscape; rm -rf' }, current).cookiesBrowser, '');
});

test('configuración: solo se admiten colores de la lista', () => {
  const current = createDefaultSettings('C:\Descargas');
  assert.equal(current.accent, 'blue');
  assert.equal(sanitizeSettings({ accent: 'green' }, current).accent, 'green');
  assert.equal(sanitizeSettings({ accent: 'rojo-neon; x' }, current).accent, 'blue');
});

test('manager: sin herramientas de vídeo, addMedia falla con un mensaje claro', () => {
  const { manager } = createManager();
  assert.throws(() => manager.addMedia({ url: 'https://www.youtube.com/watch?v=x', title: 'x', mode: 'video' }), /herramientas de vídeo/);
});

/* =========================== Pruebas reales =========================== */

test('REAL: resolve() distingue vídeo de YouTube, lista y archivo directo', REAL, async () => {
  const media = new MediaService({ tools, getSettings: () => ({ cookiesBrowser: '' }) });

  const video = await media.resolve(`${LONG_VIDEO}&list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI`);
  assert.equal(video.kind, 'video');
  assert.match(video.title, /Never Gonna Give You Up/);
  assert.ok(video.heights.length >= 5 && video.heights[0].height >= 1080, 'ofrece varias calidades');
  assert.equal(video.hasPlaylist, true, 'avisa de que el enlace también trae una lista');

  const list = await media.resolve('https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI');
  assert.equal(list.kind, 'playlist');
  assert.ok(list.count > 10 && list.entries[0].url.startsWith('https://'));

  const data = randomData(50_000);
  const server = await startTestServer(data);
  try {
    const direct = await media.resolve(`${server.url}/archivo.zip`);
    assert.equal(direct.kind, 'direct');
    assert.equal(direct.totalBytes, 50_000);
  } finally {
    await server.close();
  }
});

test('REAL: un enlace de YouTube inexistente da un error claro', REAL, async () => {
  const media = new MediaService({ tools, getSettings: () => ({ cookiesBrowser: '' }) });
  await assert.rejects(() => media.resolve('https://www.youtube.com/watch?v=00000000000'), /no está disponible|no se pudo/i);
});

test('REAL: descarga un vídeo de YouTube en MP4 con la cola normal', REAL, async () => {
  const { manager, dir } = createManager({}, undefined, { mediaTools: tools });
  const item = manager.addMedia({ url: SHORT_VIDEO, title: 'Me at the zoo', mode: 'video', height: 360 });
  assert.equal(item.kind, 'media');
  const done = await waitFor(manager, item.id, isFinal, 120000);
  assert.equal(done.status, 'completed', done.error || '');
  assert.ok(done.savePath.endsWith('.mp4'));
  assert.ok(done.savePath.startsWith(path.join(dir, 'Videos')), 'va a la carpeta de su categoría');
  const stat = fs.statSync(done.savePath);
  assert.ok(stat.size > 100_000);
  assert.equal(stat.size, done.totalBytes);
  const head = fs.readFileSync(done.savePath).subarray(4, 8).toString();
  assert.equal(head, 'ftyp', 'es un MP4 real');
  assert.equal(fs.readdirSync(path.dirname(done.savePath)).length, 1, 'no quedan archivos temporales');
});

test('REAL: descarga solo el audio en MP3 y no repite nombres', REAL, async () => {
  const { manager, dir } = createManager({}, undefined, { mediaTools: tools });
  const one = manager.addMedia({ url: SHORT_VIDEO, title: 'Canción', mode: 'audio', audioFormat: 'mp3', audioQuality: 128 });
  const two = manager.addMedia({ url: SHORT_VIDEO, title: 'Canción', mode: 'audio', audioFormat: 'mp3', audioQuality: 128 });
  const a = await waitFor(manager, one.id, isFinal, 120000);
  const b = await waitFor(manager, two.id, isFinal, 120000);
  assert.equal(a.status, 'completed', a.error || '');
  assert.equal(b.status, 'completed', b.error || '');
  assert.ok(a.savePath.endsWith('.mp3') && b.savePath.endsWith('.mp3'));
  assert.notEqual(a.savePath, b.savePath);
  assert.ok(a.savePath.startsWith(path.join(dir, 'Música')));
  const id3 = fs.readFileSync(a.savePath).subarray(0, 3).toString();
  assert.ok(id3 === 'ID3' || fs.statSync(a.savePath).size > 10_000, 'es un MP3 real');
});

test('REAL: pausar y reanudar un vídeo continúa y termina bien', REAL, async () => {
  const { manager } = createManager({}, undefined, { mediaTools: tools });
  const item = manager.addMedia({ url: LONG_VIDEO, title: 'Pausa', mode: 'video', height: 720 });
  await waitFor(manager, item.id, (i) => i.status === 'downloading' && i.downloadedBytes > 200_000, 90000);
  manager.pause(item.id);
  const paused = await waitFor(manager, item.id, (i) => i.status === 'paused', 20000);
  assert.ok(paused.downloadedBytes > 0);
  await new Promise((r) => setTimeout(r, 300)); // El gestor libera el hueco justo después del aviso.
  assert.equal(manager.tasks.size, 0, 'libera el hueco de la cola');

  manager.resume(item.id);
  const done = await waitFor(manager, item.id, (i) => i.status === 'completed' || i.status === 'error', 180000);
  assert.equal(done.status, 'completed', done.error || '');
  assert.ok(fs.statSync(done.savePath).size > 1_000_000);
});

test('REAL: cancelar borra los archivos temporales y no toca los demás', REAL, async () => {
  const { manager, dir } = createManager({}, undefined, { mediaTools: tools });
  const folder = path.join(dir, 'Videos');
  fs.mkdirSync(folder, { recursive: true });
  const bystander = path.join(folder, 'Cancelar.otro.txt');
  fs.writeFileSync(bystander, 'no me borres');

  const item = manager.addMedia({ url: LONG_VIDEO, title: 'Cancelar', mode: 'video', height: 1080 });
  await waitFor(manager, item.id, (i) => i.status === 'downloading' && i.downloadedBytes > 100_000, 90000);
  await manager.cancel(item.id);
  assert.equal(manager.get(item.id).status, 'canceled');
  assert.deepEqual(fs.readdirSync(folder), ['Cancelar.otro.txt'], 'solo queda el archivo ajeno');
  assert.equal(fs.readFileSync(bystander, 'utf8'), 'no me borres');
});
