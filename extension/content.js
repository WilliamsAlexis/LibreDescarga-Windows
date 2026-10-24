/**
 * content.js (extensión)
 * -----------------------------------------------------------------------------
 * Se inyecta en las páginas de YouTube, Vimeo, TikTok, etc. y muestra un
 * botón flotante "Descargar" cuando la página actual es un vídeo, una canción
 * o una lista. Al pulsarlo, envía la dirección de la página a la app, que la
 * analiza y deja elegir calidad, formato (vídeo/MP3) o los vídeos de una lista.
 *
 * Detalles importantes:
 *   - Webs como YouTube cambian de "página" sin recargar (SPA), por eso se
 *     vigila la dirección con un temporizador y se muestra u oculta el botón.
 *   - El botón vive dentro de un "shadow DOM": así los estilos de la web no
 *     lo deforman, ni los nuestros afectan a la web.
 *   - common.js (cargado antes) aporta ldIsVideoPage().
 * -----------------------------------------------------------------------------
 */

(() => {
  if (window.top !== window) return; // Solo en la página principal, no en iframes.

  let host = null; // Elemento contenedor del botón (null = no mostrado)
  let lastHref = '';

  /**
   * Crea el botón flotante dentro de un shadow DOM.
   * @returns {HTMLElement} Contenedor que se añade a la página.
   */
  function createButton() {
    const el = document.createElement('div');
    el.style.cssText = 'all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647;';
    const root = el.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        button {
          font: 600 13px/1 system-ui, 'Segoe UI', sans-serif; color: #fff; cursor: pointer;
          background: #4f46e5; border: 0; border-radius: 999px; padding: 11px 16px;
          box-shadow: 0 4px 14px rgba(0, 0, 0, .35); display: flex; align-items: center; gap: 8px;
        }
        button:hover { filter: brightness(1.1); }
        button:disabled { opacity: .8; cursor: default; }
        .x { background: none; border: 0; padding: 0 0 0 4px; box-shadow: none; opacity: .7; font-size: 15px; }
      </style>
      <button id="go" title="Enviar a LibreDescarga para elegir calidad o formato">⬇ Descargar con LibreDescarga <span class="x" id="close" title="Ocultar">✕</span></button>`;

    const go = root.getElementById('go');
    root.getElementById('close').addEventListener('click', (event) => {
      event.stopPropagation();
      hide(true);
    });
    go.addEventListener('click', async () => {
      go.disabled = true;
      go.textContent = 'Enviando…';
      try {
        const res = await chrome.runtime.sendMessage({ type: 'send', data: { url: location.href, referrer: location.href, page: true } });
        go.textContent = res?.ok ? '✓ Mira la app para elegir' : `⚠ ${res?.error || 'No se pudo enviar'}`;
      } catch {
        go.textContent = '⚠ No se pudo enviar';
      }
      setTimeout(() => {
        go.disabled = false;
        go.textContent = '⬇ Descargar con LibreDescarga';
      }, 3500);
    });
    return el;
  }

  /**
   * Oculta el botón.
   * @param {boolean} [forThisPage=false] - true = no volver a mostrarlo en esta página.
   * @returns {void}
   */
  function hide(forThisPage = false) {
    host?.remove();
    host = null;
    if (forThisPage) dismissedFor = location.href;
  }
  let dismissedFor = '';

  /**
   * Muestra u oculta el botón según la página actual.
   * @returns {void}
   */
  function refresh() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const show = ldIsVideoPage(location.href) && dismissedFor !== location.href;
    if (show && !host) {
      host = createButton();
      document.documentElement.appendChild(host);
    } else if (!show) {
      hide();
    }
  }

  refresh();
  setInterval(refresh, 1000);
})();
