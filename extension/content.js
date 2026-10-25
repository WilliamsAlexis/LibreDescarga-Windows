/**
 * content.js (extensión)
 * -----------------------------------------------------------------------------
 * Se inyecta en TODAS las páginas y añade botones de descarga al estilo de
 * Internet Download Manager:
 *
 *   1. Sobre cada VÍDEO (o canción con reproductor): al pasar el ratón o al
 *      empezar a reproducir aparece "⬇ Descargar" en la esquina del vídeo.
 *      Si la página tiene varios vídeos, el botón sigue al que tengas debajo
 *      del ratón: cada vídeo tiene su propio botón.
 *   2. Sobre cada MINIATURA de vídeo (YouTube, listas, resultados de búsqueda,
 *      TikTok, X...): un icono ⬇ en su esquina que descarga ESE vídeo.
 *   3. Un botón redondo flotante en las páginas de vídeo de sitios conocidos
 *      (útil, por ejemplo, en YouTube Music, donde no siempre se ve el vídeo).
 *
 * Al pulsar un botón se envía la dirección a la app, que se abre en una
 * ventana pequeña para analizarla y elegir calidad o formato. La app principal
 * puede seguir oculta en la bandeja.
 *
 * Detalles técnicos:
 *   - Los botones viven en un "shadow DOM": las páginas no los deforman.
 *   - Solo hay UN botón de vídeo/miniatura que se mueve al elemento con el ratón
 *     encima (más ligero que uno por vídeo y se adapta a páginas dinámicas).
 *   - common.js (cargado antes) aporta ldIsVideoPage().
 * -----------------------------------------------------------------------------
 */

(() => {
  if (window.__libreDescargaContent) return; // Evita duplicados si el script se inyecta dos veces.
  window.__libreDescargaContent = true;

  const MIN_VIDEO = { w: 200, h: 110 }; // Vídeos más pequeños (anuncios, iconos) se ignoran.
  const MIN_THUMB = { w: 100, h: 56 }; // Tamaño mínimo para considerar una miniatura.
  const HIDE_DELAY = 1800; // ms que el botón sigue visible tras quitar el ratón.

  /** Opciones elegidas en la página de opciones de la extensión. */
  const options = { overlay: true, floating: true };

  /* ---------------------------------------------------------------------- */
  /* Botón que se mueve (vídeos y miniaturas)                                */
  /* ---------------------------------------------------------------------- */

  let host = null; // Elemento contenedor (shadow DOM)
  let button = null; // El <button> dentro del shadow DOM
  let current = null; // Candidato actual: { kind: 'video'|'thumb', el, url? }
  let hideTimer = null;
  let overButton = false;
  let busy = false; // true mientras se muestra "Enviado"

  const ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/></svg>';

  /**
   * Crea (una sola vez) el contenedor con el botón.
   * @returns {void}
   */
  function ensureButton() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;z-index:2147483647;display:none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        button {
          all: initial; box-sizing: border-box; display: flex; align-items: center; gap: 6px; cursor: pointer;
          font: 600 12px/1 system-ui, 'Segoe UI', sans-serif; color: #fff; white-space: nowrap;
          background: linear-gradient(135deg, #0a8f80, #006a60); padding: 8px 12px; border-radius: 7px;
          box-shadow: 0 2px 10px rgba(0, 0, 0, .45); border: 1px solid rgba(255, 255, 255, .25);
        }
        button:hover { filter: brightness(1.15); }
        button.thumb { padding: 7px; border-radius: 50%; }
        button.thumb span { display: none; }
        button.ok { background: #16a34a; }
        button.err { background: #dc2626; }
      </style>
      <button type="button">${ICON}<span>Descargar</span></button>`;
    button = root.querySelector('button');
    button.addEventListener('mouseenter', () => { overButton = true; clearTimeout(hideTimer); });
    button.addEventListener('mouseleave', () => { overButton = false; scheduleHide(); });
    button.addEventListener('click', onClick);
    // Evitamos que el clic llegue a la página (por ejemplo, que abra el vídeo de la miniatura).
    for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick']) {
      button.addEventListener(type, (event) => event.stopPropagation());
    }
  }

  /**
   * Coloca el contenedor dentro del elemento a pantalla completa (si lo hay):
   * si no, el navegador lo ocultaría detrás del vídeo.
   * @returns {void}
   */
  function mountHost() {
    const parent = document.fullscreenElement && document.fullscreenElement.tagName !== 'VIDEO' ? document.fullscreenElement : document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
  }

  /**
   * Parte visible (dentro de la ventana) de un elemento.
   * @param {Element} el
   * @returns {DOMRect|null} null si no se ve.
   */
  function visibleRect(el) {
    const r = el.getBoundingClientRect();
    const left = Math.max(r.left, 0);
    const top = Math.max(r.top, 0);
    const right = Math.min(r.right, window.innerWidth);
    const bottom = Math.min(r.bottom, window.innerHeight);
    if (right - left < 40 || bottom - top < 30) return null;
    return new DOMRect(left, top, right - left, bottom - top);
  }

  /**
   * Muestra el botón sobre un candidato.
   * @param {{kind:string, el:Element, url?:string}} candidate
   * @returns {void}
   */
  function show(candidate) {
    if (!options.overlay) return;
    ensureButton();
    const changed = !current || current.el !== candidate.el;
    current = candidate;
    clearTimeout(hideTimer);
    if (changed && !busy) {
      button.className = candidate.kind === 'thumb' ? 'thumb' : '';
      button.title = candidate.kind === 'thumb' ? 'Descargar este vídeo con LibreDescarga' : 'Descargar este vídeo con LibreDescarga';
      button.lastChild.textContent = 'Descargar';
    }
    mountHost();
    host.style.display = 'block';
    reposition();
    if (!overButton) scheduleHide();
  }

  /**
   * Pone el botón en la esquina superior derecha del candidato.
   * @returns {void}
   */
  function reposition() {
    if (!current || !host) return;
    const rect = visibleRect(current.el);
    if (!rect) return hide();
    const width = button.offsetWidth || 110;
    host.style.left = `${Math.round(rect.right - width - 10)}px`;
    host.style.top = `${Math.round(rect.top + 10)}px`;
  }

  /** Oculta el botón. */
  function hide() {
    clearTimeout(hideTimer);
    if (host) host.style.display = 'none';
    current = null;
    overButton = false;
  }

  /** Programa ocultar el botón dentro de un rato. */
  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!overButton && !busy) hide();
    }, HIDE_DELAY);
  }

  /* ---------------------------------------------------------------------- */
  /* Qué descargar                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * En una página con muchos vídeos (X, TikTok, Facebook...), busca el enlace
   * del vídeo concreto subiendo por los elementos que lo contienen.
   * @param {Element} el - El <video>.
   * @returns {string|null}
   */
  function nearbyVideoLink(el) {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 9; depth++, node = node.parentElement) {
      const own = node.tagName === 'A' ? node : null;
      if (own && ldIsVideoPage(own.href)) return own.href;
      for (const a of node.querySelectorAll('a[href]')) {
        if (ldIsVideoPage(a.href)) return a.href;
      }
    }
    return null;
  }

  /**
   * Datos que se envían a la app para el candidato actual.
   * @param {{kind:string, el:Element, url?:string}} c
   * @returns {{url:string, page:boolean, referrer:string}}
   */
  function targetFor(c) {
    const referrer = location.href;
    if (c.kind === 'thumb') return { url: c.url, page: true, referrer };

    const video = c.el;
    const src = video.currentSrc || video.src || '';
    const onVideoPage = ldIsVideoPage(location.href);
    // Un archivo de vídeo directo (mp4...) se descarga tal cual. Los flujos por trozos
    // (blob:, m3u8, mpd) no son un archivo: hay que analizar la página.
    const isDirectFile = /^https?:/i.test(src) && !/\.(m3u8|mpd)(\?|#|$)/i.test(src);
    if (isDirectFile && !onVideoPage) return { url: src, page: false, referrer };
    if (onVideoPage) return { url: location.href, page: true, referrer };
    return { url: nearbyVideoLink(video) || location.href, page: true, referrer };
  }

  /**
   * Envía el candidato actual a la app y muestra el resultado en el propio botón.
   * @returns {Promise<void>}
   */
  async function onClick() {
    if (!current || busy) return;
    const label = button.lastChild;
    const compact = button.classList.contains('thumb');
    busy = true;
    label.textContent = 'Enviando…';
    let message = '';
    let ok = false;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'send', data: targetFor(current) });
      ok = Boolean(res?.ok);
      message = ok ? 'Enviado' : res?.error || 'No se pudo enviar';
    } catch {
      message = 'Recarga la página (la extensión se actualizó)';
    }
    button.className = `${compact ? 'thumb ' : ''}${ok ? 'ok' : 'err'}`;
    label.textContent = ok ? '✓ Enviado' : '⚠ Error';
    button.title = message;
    if (compact) label.style.display = 'none';
    setTimeout(() => {
      busy = false;
      button.className = compact ? 'thumb' : '';
      label.textContent = 'Descargar';
      label.style.display = '';
      scheduleHide();
    }, 2200);
  }

  /* ---------------------------------------------------------------------- */
  /* Detección: ¿qué hay bajo el ratón?                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Busca el vídeo (o miniatura de vídeo) que hay en un punto de la pantalla.
   * @param {number} x
   * @param {number} y
   * @returns {{kind:string, el:Element, url?:string}|null}
   */
  function candidateAt(x, y) {
    // 1) Un <video> cuyo recuadro contenga el punto (el más pequeño si hay varios anidados).
    let best = null;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (r.width < MIN_VIDEO.w || r.height < MIN_VIDEO.h) continue;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      if (getComputedStyle(v).visibility === 'hidden') continue;
      if (!best || r.width * r.height < best.area) best = { kind: 'video', el: v, area: r.width * r.height };
    }
    if (best) return best;

    // 2) Una miniatura: enlace a la página de un vídeo con tamaño de imagen (no un enlace de texto).
    for (const el of document.elementsFromPoint(x, y)) {
      const a = el.tagName === 'A' ? el : el.closest?.('a[href]');
      if (!a || !a.href || !ldIsVideoPage(a.href)) continue;
      const r = a.getBoundingClientRect();
      if (r.width >= MIN_THUMB.w && r.height >= MIN_THUMB.h && r.width / r.height > 1.2 && (a.querySelector('img, picture, canvas') || getComputedStyle(a).backgroundImage !== 'none')) {
        return { kind: 'thumb', el: a, url: a.href };
      }
    }
    return null;
  }

  let pointer = null;
  let pointerScheduled = false;

  /**
   * Se llama con cada movimiento del ratón (como mucho una vez por fotograma).
   * @returns {void}
   */
  function onPointer() {
    pointerScheduled = false;
    if (!options.overlay || !pointer || overButton) return;
    const candidate = candidateAt(pointer.x, pointer.y);
    if (candidate) show(candidate);
    else if (current) scheduleHide();
  }

  document.addEventListener(
    'mousemove',
    (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      if (!pointerScheduled) {
        pointerScheduled = true;
        requestAnimationFrame(onPointer);
      }
    },
    { capture: true, passive: true },
  );

  // Al empezar a reproducir, mostramos el botón unos segundos aunque no se mueva el ratón.
  document.addEventListener(
    'play',
    (event) => {
      const v = event.target;
      if (!options.overlay || v.tagName !== 'VIDEO') return;
      const r = v.getBoundingClientRect();
      if (r.width < MIN_VIDEO.w || r.height < MIN_VIDEO.h) return;
      show({ kind: 'video', el: v });
    },
    true,
  );

  // Mantiene el botón pegado a su vídeo al hacer scroll o cambiar el tamaño.
  window.addEventListener('scroll', () => current && reposition(), { capture: true, passive: true });
  window.addEventListener('resize', () => current && reposition(), { passive: true });
  document.addEventListener('fullscreenchange', () => {
    if (host) mountHost();
  });
  setInterval(() => current && reposition(), 400);

  /* ---------------------------------------------------------------------- */
  /* Botón redondo flotante (páginas de vídeo de sitios conocidos)           */
  /* ---------------------------------------------------------------------- */

  let fab = null;
  let fabDismissedFor = '';
  let lastHref = '';

  /**
   * Crea el botón redondo flotante.
   * @returns {HTMLElement}
   */
  function createFab() {
    const el = document.createElement('div');
    el.style.cssText = 'all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647;';
    const root = el.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .wrap { position: relative; }
        button.go {
          all: initial; box-sizing: border-box; width: 44px; height: 44px; border-radius: 50%; cursor: pointer; color: #fff;
          background: linear-gradient(135deg, #0a8f80, #006a60); display: flex; align-items: center; justify-content: center;
          box-shadow: 0 4px 14px rgba(0, 0, 0, .4); border: 1px solid rgba(255, 255, 255, .25); font: 600 18px system-ui;
        }
        button.go:hover { filter: brightness(1.15); }
        button.go.ok { background: #16a34a; }
        button.go.err { background: #dc2626; }
        button.x {
          all: initial; position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%;
          background: #1f2937; color: #fff; font: 11px/18px system-ui; text-align: center; cursor: pointer; display: none;
        }
        .wrap:hover button.x { display: block; }
      </style>
      <div class="wrap">
        <button class="go" type="button" title="Descargar este vídeo o música con LibreDescarga">${ICON}</button>
        <button class="x" type="button" title="Ocultar en esta página">✕</button>
      </div>`;
    const go = root.querySelector('.go');
    root.querySelector('.x').addEventListener('click', () => {
      fabDismissedFor = location.href;
      fab?.remove();
      fab = null;
    });
    go.addEventListener('click', async () => {
      go.disabled = true;
      let ok = false;
      try {
        const res = await chrome.runtime.sendMessage({ type: 'send', data: { url: location.href, referrer: location.href, page: true } });
        ok = Boolean(res?.ok);
        go.title = ok ? 'Enviado: míralo en la ventana de LibreDescarga' : res?.error || 'No se pudo enviar';
      } catch {
        go.title = 'Recarga la página (la extensión se actualizó)';
      }
      go.className = `go ${ok ? 'ok' : 'err'}`;
      go.textContent = ok ? '✓' : '!';
      setTimeout(() => {
        go.disabled = false;
        go.className = 'go';
        go.innerHTML = ICON;
      }, 2500);
    });
    return el;
  }

  /**
   * Muestra u oculta el botón redondo según la página (YouTube cambia de
   * página sin recargar, por eso se vigila la dirección).
   * @returns {void}
   */
  function refreshFab() {
    const mustShow = options.floating && window.top === window && ldIsVideoPage(location.href) && fabDismissedFor !== location.href;
    if (mustShow && !fab) {
      fab = createFab();
      document.documentElement.appendChild(fab);
    } else if (!mustShow && fab) {
      fab.remove();
      fab = null;
    }
    lastHref = location.href;
  }
  setInterval(() => {
    if (location.href !== lastHref || (options.floating && !fab) || (!options.floating && fab)) refreshFab();
  }, 1000);

  /* ---------------------------------------------------------------------- */
  /* Opciones                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Lee las opciones y reacciona cuando el usuario las cambia.
   * @returns {void}
   */
  function loadOptions() {
    try {
      chrome.storage.local.get({ overlay: true, floating: true }, (stored) => {
        options.overlay = stored.overlay !== false;
        options.floating = stored.floating !== false;
        if (!options.overlay) hide();
        refreshFab();
      });
      chrome.storage.onChanged.addListener((changes) => {
        if ('overlay' in changes) options.overlay = changes.overlay.newValue !== false;
        if ('floating' in changes) options.floating = changes.floating.newValue !== false;
        if (!options.overlay) hide();
        refreshFab();
      });
    } catch {
      // La extensión se actualizó mientras la página seguía abierta: no hacemos nada.
    }
  }
  loadOptions();
})();
