/**
 * fetch-tools.js
 * -----------------------------------------------------------------------------
 * Prepara la carpeta "tools/" con los dos programas externos que usa la app
 * para descargar VÍDEO y AUDIO de páginas como YouTube:
 *
 *   - yt-dlp.exe : analiza la página y descarga los flujos de vídeo/audio.
 *                  Se baja de su repositorio oficial en GitHub.
 *   - ffmpeg.exe : une vídeo y audio y convierte a MP3. Viene en el paquete
 *                  npm "ffmpeg-static", así que solo lo copiamos.
 *
 * Se ejecuta solo antes de "npm start", "npm run dist" y "npm run pack".
 * Si los archivos ya existen no hace nada, así que es rápido.
 *
 * Uso manual:  npm run tools          (añade --force para volver a descargar)
 * -----------------------------------------------------------------------------
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const TOOLS_DIR = path.join(__dirname, '..', 'tools');
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const force = process.argv.includes('--force');

/**
 * Descarga un archivo (siguiendo redirecciones) y lo guarda de forma segura:
 * primero en un archivo temporal y, solo si todo va bien, lo renombra.
 * @param {string} url - Dirección del archivo.
 * @param {string} destination - Ruta final.
 * @returns {Promise<void>}
 */
async function download(url, destination) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`El servidor respondió ${res.status} al bajar ${url}`);
  const data = Buffer.from(await res.arrayBuffer());
  // Un ejecutable de Windows empieza por "MZ": así detectamos páginas de error guardadas por accidente.
  if (data.length < 1_000_000 || data.toString('latin1', 0, 2) !== 'MZ') throw new Error('El archivo descargado no parece un programa válido.');
  const temp = `${destination}.tmp`;
  await fsp.writeFile(temp, data);
  await fsp.rename(temp, destination);
}

/**
 * Punto de entrada: deja yt-dlp.exe y ffmpeg.exe en tools/.
 * @returns {Promise<void>}
 */
async function main() {
  await fsp.mkdir(TOOLS_DIR, { recursive: true });

  const ytdlp = path.join(TOOLS_DIR, 'yt-dlp.exe');
  if (force || !fs.existsSync(ytdlp)) {
    console.log('[tools] Descargando yt-dlp.exe…');
    await download(YTDLP_URL, ytdlp);
  }

  const ffmpeg = path.join(TOOLS_DIR, 'ffmpeg.exe');
  if (force || !fs.existsSync(ffmpeg)) {
    const source = require('ffmpeg-static'); // Ruta del ffmpeg.exe que instala npm.
    if (!source || !fs.existsSync(source)) throw new Error('No se encontró ffmpeg-static. Ejecuta "npm install".');
    console.log('[tools] Copiando ffmpeg.exe…');
    await fsp.copyFile(source, ffmpeg);
  }
  console.log('[tools] Listo: yt-dlp.exe y ffmpeg.exe en tools/');
}

main().catch((err) => {
  // No hacemos fallar "npm start": la app funciona sin vídeo, solo avisará al usarlo.
  console.error('[tools] No se pudieron preparar las herramientas de vídeo:', err.message);
  process.exitCode = process.argv.includes('--strict') ? 1 : 0;
});
