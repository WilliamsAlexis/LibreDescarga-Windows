/**
 * mediaTools.js
 * -----------------------------------------------------------------------------
 * Localiza y ejecuta las herramientas externas de vídeo/audio:
 *
 *   - yt-dlp.exe : saca de una página (YouTube, etc.) los enlaces reales de
 *                  vídeo y audio, y los descarga.
 *   - ffmpeg.exe : une vídeo+audio y convierte a MP3.
 *
 * ¿Dónde están?
 *   - App instalada:  <carpeta de la app>\resources\tools\
 *   - Desarrollo:     <proyecto>\tools\   (los prepara scripts/fetch-tools.js)
 *
 * yt-dlp necesita actualizarse a menudo (YouTube cambia con frecuencia), pero
 * la carpeta de la app instalada puede no ser escribible. Por eso, al arrancar
 * copiamos yt-dlp.exe a la carpeta de datos del usuario y ESA copia es la que
 * se ejecuta y se actualiza.
 * -----------------------------------------------------------------------------
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

/** Navegadores de los que yt-dlp puede leer las cookies. */
const COOKIE_BROWSERS = ['chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi'];

class MediaTools {
  /**
   * @param {object} options
   * @param {string} options.bundledDir - Carpeta con los programas incluidos con la app.
   * @param {string} options.userDir - Carpeta escribible donde vive la copia actualizable de yt-dlp.
   */
  constructor({ bundledDir, userDir }) {
    this.bundledDir = bundledDir;
    this.userDir = userDir;
  }

  /** @returns {string} Ruta de la copia de yt-dlp del usuario. */
  get userYtdlp() {
    return path.join(this.userDir, 'yt-dlp.exe');
  }

  /** @returns {string} Ruta de yt-dlp incluido con la app. */
  get bundledYtdlp() {
    return path.join(this.bundledDir, 'yt-dlp.exe');
  }

  /** @returns {string} Ruta de ffmpeg.exe. */
  get ffmpegPath() {
    return path.join(this.bundledDir, 'ffmpeg.exe');
  }

  /**
   * Prepara la copia de yt-dlp del usuario: la crea si no existe o la
   * reemplaza si la que viene con la app es más reciente (app actualizada).
   * No lanza errores: si falla, se usará la copia incluida con la app.
   * @returns {Promise<void>}
   */
  async prepare() {
    try {
      if (!fs.existsSync(this.bundledYtdlp)) return;
      await fsp.mkdir(this.userDir, { recursive: true });
      const bundled = await fsp.stat(this.bundledYtdlp);
      const user = await fsp.stat(this.userYtdlp).catch(() => null);
      if (!user || bundled.mtimeMs > user.mtimeMs) await fsp.copyFile(this.bundledYtdlp, this.userYtdlp);
    } catch (err) {
      console.error('No se pudo preparar yt-dlp:', err.message);
    }
  }

  /** @returns {string} yt-dlp que hay que ejecutar (la del usuario si existe). */
  get ytdlpPath() {
    if (fs.existsSync(this.userYtdlp)) return this.userYtdlp;
    return this.bundledYtdlp;
  }

  /** @returns {boolean} ¿Están disponibles los programas necesarios? */
  get available() {
    return fs.existsSync(this.ytdlpPath) && fs.existsSync(this.ffmpegPath);
  }

  /**
   * Argumentos que llevan todas las ejecuciones de yt-dlp.
   * @param {object} [options]
   * @param {string} [options.cookiesBrowser] - Navegador del que leer cookies ('' = ninguno).
   * @returns {string[]}
   */
  baseArgs({ cookiesBrowser = '' } = {}) {
    const args = ['--no-warnings', '--encoding', 'utf-8', '--ffmpeg-location', this.ffmpegPath, '--no-cache-dir'];
    if (COOKIE_BROWSERS.includes(cookiesBrowser)) args.push('--cookies-from-browser', cookiesBrowser);
    return args;
  }

  /**
   * Lanza yt-dlp. Se puede reemplazar en las pruebas por un falso.
   * @param {string[]} args - Argumentos.
   * @returns {import('node:child_process').ChildProcessWithoutNullStreams}
   * @throws {Error} Si falta el programa.
   */
  spawnYtdlp(args) {
    if (!this.available) {
      throw new Error('Faltan las herramientas de vídeo (yt-dlp o ffmpeg). Ejecuta "npm run tools" o reinstala la aplicación.');
    }
    return spawn(this.ytdlpPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /**
   * Ejecuta yt-dlp y devuelve toda su salida cuando termina.
   * @param {string[]} args
   * @param {object} [options]
   * @param {AbortSignal} [options.signal] - Para cancelar.
   * @param {number} [options.timeoutMs=60000] - Tiempo máximo.
   * @returns {Promise<{code:number, stdout:string, stderr:string}>}
   */
  run(args, { signal, timeoutMs = 60000 } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnYtdlp(args);
      } catch (err) {
        reject(err);
        return;
      }
      const out = [];
      const err = [];
      let finished = false;
      const finish = (fn, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onAbort = () => {
        MediaTools.killTree(child);
        finish(reject, new Error('Operación cancelada'));
      };
      const timer = setTimeout(() => {
        MediaTools.killTree(child);
        finish(reject, new Error('El análisis tardó demasiado. Inténtalo de nuevo.'));
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (d) => out.push(d));
      child.stderr.on('data', (d) => err.push(d));
      child.on('error', (e) => finish(reject, e));
      child.on('close', (code) => {
        finish(resolve, { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
      });
    });
  }

  /**
   * Actualiza yt-dlp en segundo plano, como mucho una vez cada `minIntervalMs`.
   * Se anota la fecha del último intento en un archivo para no repetir en cada arranque.
   * Nunca lanza errores (sin internet, sin permisos...): es un extra silencioso.
   * @param {number} [minIntervalMs=3 días]
   * @returns {Promise<boolean>} true si se actualizó a una versión nueva.
   */
  async autoUpdate(minIntervalMs = 3 * 24 * 3600 * 1000) {
    const marker = path.join(this.userDir, 'last-update-check');
    try {
      await fsp.mkdir(this.userDir, { recursive: true });
      const last = await fsp.stat(marker).then((s) => s.mtimeMs, () => 0);
      if (Date.now() - last < minIntervalMs) return false;
      await fsp.writeFile(marker, new Date().toISOString());
      const result = await this.update();
      return result.updated;
    } catch (err) {
      console.error('Actualización automática de yt-dlp:', err.message);
      return false;
    }
  }

  /**
   * Termina un proceso Y todos sus hijos. yt-dlp.exe lanza un proceso hijo
   * (y ffmpeg otro), y en Windows child.kill() solo mata al primero.
   * @param {import('node:child_process').ChildProcess} child
   * @returns {void}
   */
  static killTree(child) {
    if (!child || child.exitCode !== null || !child.pid) return;
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      child.kill('SIGKILL');
    }
  }

  /**
   * Versión instalada de yt-dlp.
   * @returns {Promise<string>} Por ejemplo "2026.10.21", o '' si no se pudo.
   */
  async version() {
    try {
      const { stdout } = await this.run(['--version'], { timeoutMs: 15000 });
      return stdout.trim();
    } catch {
      return '';
    }
  }

  /**
   * Actualiza yt-dlp a la última versión (descarga oficial de GitHub).
   * @returns {Promise<{updated:boolean, version:string, message:string}>}
   * @throws {Error} Si no hay conexión o no se puede escribir el archivo.
   */
  async update() {
    await this.prepare();
    const before = await this.version();
    const { code, stdout, stderr } = await this.run(['-U'], { timeoutMs: 120000 });
    if (code !== 0) {
      const detail = (stderr || stdout).split('\n').find((l) => /error/i.test(l)) || 'No se pudo actualizar.';
      throw new Error(detail.replace(/^ERROR:\s*/i, '').trim());
    }
    const after = await this.version();
    return {
      updated: Boolean(after) && after !== before,
      version: after,
      message: after !== before ? `Actualizado a ${after}` : `Ya tienes la última versión (${after})`,
    };
  }
}

module.exports = { MediaTools, COOKIE_BROWSERS };
