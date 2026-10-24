# LibreDescarga

Gestor de descargas acelerado para Windows, al estilo de Internet Download Manager (IDM), hecho con **Electron** y **Node.js**.

- Descarga por **segmentos** (de 1 a 16 conexiones simultáneas con HTTP Range) y une las partes al terminar.
- **Pausar, reanudar y cancelar**, incluso después de cerrar y volver a abrir la app.
- **Cola** con límite de descargas simultáneas, **reintentos automáticos** con espera progresiva y **limitador de velocidad** global.
- **Categorías automáticas** (Videos, Música, Documentos, Programas, Comprimidos y Otros), cada una con su propia carpeta.
- **Historial** persistente con búsqueda y filtros, **programador** por hora y cambio de color de la interfaz.
- **Bandeja del sistema**, notificaciones, tema claro y oscuro, menú contextual y detección del portapapeles.
- **Vídeo y audio de YouTube, YouTube Music y cientos de sitios más**: elige la calidad (hasta 4K) o solo el audio en MP3, M4A u OPUS, y descarga **listas de reproducción** completas o solo los vídeos que marques.
- **Colores a elegir** para la interfaz (azul, verde, rojo, morado, naranja, rosa, turquesa y grafito), además del tema claro y oscuro.
- **Extensión para Chrome y Edge**: botón flotante en las páginas de vídeo, botón en el icono de la extensión y menú de clic derecho.

---

## 1. Requisitos

| Herramienta | Versión | Para qué |
|---|---|---|
| Windows 10 u 11 (64 bits) | — | Sistema donde se ejecuta y se empaqueta |
| [Node.js](https://nodejs.org) | 20 o superior (probado con 24) | Ejecutar `npm` y las pruebas |
| Conexión a internet | — | La primera vez, para que `npm install` descargue Electron |

## 2. Instalación y ejecución (modo desarrollo)

```powershell
cd "D:\APLICACIONES ANDROID\LibreDescarga\windows"
npm install
npm start
```

> **Nota:** si `npm start` se cierra al instante o muestra `Cannot read properties of undefined (reading 'setPath')`,
> la variable de entorno `ELECTRON_RUN_AS_NODE` está activa. Esto pasa, por ejemplo, en la terminal integrada de
> algunas extensiones de VS Code. Esa variable hace que Electron funcione como Node puro. Desactívala y vuelve a probar:
>
> ```powershell
> Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
> npm start
> ```

## 3. Estructura del proyecto

```
windows/
├── package.json            Dependencias, scripts y configuración de electron-builder
├── assets/                 Iconos de la app (icon.png) y de la bandeja (tray.png)
├── scripts/
│   └── generate-icons.js   Dibuja los iconos PNG sin librerías externas (npm run icons)
├── src/
│   ├── main/               PROCESO PRINCIPAL (Node.js con acceso al sistema)
│   │   ├── main.js             Punto de entrada: ventana, servicios y ciclo de vida
│   │   ├── ipc.js              Canales ipcMain que la interfaz puede invocar
│   │   ├── stores.js           Persistencia con electron-store (settings.json y downloads.json)
│   │   ├── tray.js             Icono y menú de la bandeja del sistema
│   │   ├── notifications.js    Notificaciones nativas de Windows
│   │   └── clipboardWatcher.js Detecta URLs copiadas al portapapeles
│   ├── preload/
│   │   └── preload.js      Puente seguro (contextBridge): expone window.api a la interfaz
│   ├── renderer/           INTERFAZ (HTML, CSS y JS, sin acceso a Node)
│   │   ├── index.html
│   │   ├── styles.css          Diseño, tema claro y oscuro, animaciones
│   │   └── js/                 app.js, ui.js, dialogs.js, state.js, format.js, icons.js
│   ├── services/           LÓGICA DE NEGOCIO (sin dependencias de la ventana)
│   │   ├── downloadTask.js     Motor: segmentos, Range, reintentos, pausa y reanudación y unión de partes
│   │   ├── downloadManager.js  Cola, límite de simultáneas, eventos y persistencia
│   │   ├── speedLimiter.js     Limitador global (token bucket) compartido por todas las conexiones
│   │   ├── mediaTask.js        Descarga de vídeo/audio con yt-dlp (misma forma que downloadTask)
│   │   ├── mediaService.js     Analiza un enlace: ¿archivo, vídeo o lista? Calidades y elementos
│   │   ├── mediaTools.js       Localiza, ejecuta y actualiza yt-dlp y ffmpeg
│   │   ├── scheduler.js        Programador de descargas por hora
│   │   ├── updater.js          Actualizaciones automáticas (electron-updater)
│   │   ├── settingsService.js  Valores por defecto y validación de la configuración
│   │   └── browserServer.js    Servidor HTTP local (127.0.0.1) para la extensión
│   └── utils/              Utilidades: categories, fileName, format, http, sleep
├── extension/              Extensión de Chrome y Edge (Manifest V3)
├── tools/                  yt-dlp.exe y ffmpeg.exe (los prepara scripts/fetch-tools.js; no se suben a git)
└── tests/                  Pruebas automáticas (node --test) con un servidor HTTP de prueba
```

## 4. Librerías utilizadas

| Librería | Por qué |
|---|---|
| **electron** | Crear la app de escritorio con HTML, CSS y JS, con acceso a archivos y red mediante Node.js. |
| **electron-store** | Guarda la configuración y el historial en JSON con escritura atómica (un corte de luz no corrompe el archivo). Se eligió en lugar de SQLite porque no necesita compilar módulos nativos, lo que simplifica la instalación y el empaquetado. |
| **lucide** | Iconos SVG modernos y ligeros para la interfaz. |
| **electron-updater** | Busca, descarga e instala versiones nuevas desde GitHub Releases, comprobando su huella SHA-512. Es la pareja oficial de electron-builder. |
| **electron-builder** *(desarrollo)* | Genera el instalador `.exe` (NSIS) para Windows. |

Las descargas usan solo los módulos nativos `http` y `https` de Node.js. Así se controlan las cabeceras `Range`, los reintentos y la velocidad. El diseño está hecho con CSS propio basado en variables, para los temas, sin depender de Tailwind.

Para descargar vídeo y audio se usan dos programas externos, que se incluyen en el instalador:

| Programa | Por qué |
|---|---|
| **yt-dlp** | El proyecto de código abierto de referencia para extraer vídeo y audio de YouTube y cientos de sitios. Se actualiza solo (como mucho cada 3 días) porque YouTube cambia a menudo. |
| **ffmpeg** *(paquete `ffmpeg-static`)* | Une el vídeo con el audio y convierte a MP3. |

`npm start`, `npm run dist` y `npm run pack` los descargan solos en la carpeta `tools/` la primera vez. Para volver a bajarlos: `npm run tools`.

## 5. Uso

### Agregar una descarga
- Pulsa **Agregar URL** (o `Ctrl+N`), pega el enlace y la app lo **analiza** para saber si es un archivo, un vídeo o una lista. Puedes elegir la carpeta y la hora de inicio (opcional).
- **Portapapeles:** si copias una URL descargable, la app te ofrece añadirla. Se puede desactivar en Configuración.
- **Ctrl+V** fuera de un campo de texto, o **arrastrar y soltar** un enlace sobre la ventana, abre el mismo diálogo.

### Vídeos, música y listas
Si el enlace es de YouTube, YouTube Music, Vimeo, TikTok, etc., el diálogo muestra la miniatura y el título, y te deja elegir con botones de opción:
- **Vídeo (MP4)** y su **calidad** (2160p, 1080p, 720p…, con el tamaño aproximado de cada una).
- **Solo audio**: formato (MP3, M4A u OPUS) y calidad (320, 256, 192, 128 kbps o la mejor).
- Si el enlace es de un vídeo que está dentro de una lista, aparece **Ver la lista completa**. En una lista marcas los vídeos que quieras (o *Todos* / *Ninguno*) y cada uno entra en la cola como una descarga más.

Los vídeos usan la misma cola, pausa, reanudación, cancelación, programador y límite de velocidad que el resto. Los MP4 van a *Videos* y el audio a *Música*.

Si YouTube pide "confirmar que no eres un robot" o el vídeo tiene restricción de edad, ve a **Configuración → Vídeo y audio** y elige tu navegador para usar sus cookies (con la sesión iniciada en él). Si una descarga falla de repente, pulsa ahí **Actualizar el motor**.

> Descarga solo contenido que tengas derecho a descargar. Algunos sitios lo prohíben en sus condiciones de uso.

### Gestionar descargas
- Barra superior: iniciar, pausar, cancelar, eliminar, *iniciar todas*, *pausar todas* y *programar*.
- **Clic derecho** sobre una fila: abrir archivo, abrir carpeta, copiar la URL, pausar o reanudar, reintentar, eliminar…
- Selección múltiple con `Ctrl` y `Mayús`. `Ctrl+A` selecciona todo, `Supr` elimina y `Ctrl+F` busca.
- La barra lateral filtra por estado (En curso, Completadas, Sin terminar, Programadas) y por categoría.
- Cada fila muestra el nombre, el tamaño, el progreso, la velocidad, el tiempo restante y el estado.

### Reanudar después de cerrar
El progreso de cada segmento se guarda continuamente. Si cierras la app, o se va la luz, al volver a abrirla las descargas aparecen en **Sin terminar**. Al reanudarlas, siguen desde el último byte guardado, siempre que el servidor admita `Range`.

### Configuración (icono de engranaje)
Carpeta por defecto y carpeta por categoría, conexiones por descarga (1–16), descargas simultáneas, límite de velocidad (KB/s, 0 = sin límite), reintentos, tema (sistema, claro u oscuro), **color de la aplicación**, navegador para las cookies y actualización del motor de vídeo, portapapeles, bandeja, notificaciones y el servidor para la extensión (puerto y token).

### Bandeja del sistema
Al cerrar la ventana, la app se minimiza a la bandeja y sigue descargando. Haz clic en el icono para volver a abrirla. Para cerrarla del todo, usa **Salir** en el menú del icono.

### Segundo plano: abrir con Windows y avisos de enlaces
- **Abrir con Windows** (Configuración → Apariencia, activado por defecto): al iniciar sesión, LibreDescarga arranca **sin ventana**, directamente en la bandeja. Así la extensión del navegador y los avisos siempre funcionan, sin que tengas que abrir la app.
- **Avisos de enlaces copiados:** mientras la app está en segundo plano (oculta, minimizada o detrás de otra ventana), si copias un enlace de un archivo o de un vídeo (YouTube, Vimeo, TikTok…) sale una **notificación de Windows**. Al pulsarla, la app se abre con el enlace ya analizado para que elijas calidad o formato. Si estás usando la ventana, el aviso sale dentro de la app. Se puede desactivar en Configuración con *Detectar automáticamente enlaces copiados*.
- Solo funciona en la app **instalada** (no con `npm start`).

## 6. Extensión del navegador (Chrome y Edge)

1. Abre LibreDescarga → **Configuración** → sección *Navegador*. Copia el **token** y anota el **puerto** (6801 por defecto). El botón *Abrir carpeta de la extensión* te lleva a ella.
2. En el navegador, ve a `chrome://extensions` (o `edge://extensions`) y activa el **Modo de desarrollador**.
3. Pulsa **Cargar descomprimida** y elige la carpeta `extension/` del proyecto. En la app instalada está en `resources\extension`, dentro de la carpeta de instalación.
4. Abre las **opciones** de la extensión, pega el token, comprueba el puerto y pulsa *Probar conexión*.

Funciones de la extensión:
- **Botón "Descargar" sobre cada vídeo, como en Internet Download Manager**, en cualquier página: aparece en la esquina del vídeo al pasar el ratón o al empezar a reproducirlo. Si la página tiene varios vídeos, el botón sigue al que tengas debajo del ratón, así que cada vídeo tiene el suyo.
- **Icono sobre cada miniatura** de vídeo (YouTube, resultados de búsqueda, listas, TikTok, X…): descarga **ese** vídeo sin tener que abrirlo.
- **Botón redondo flotante** en las páginas de vídeo de YouTube, YouTube Music, Vimeo, TikTok, SoundCloud, etc. (útil en YouTube Music, donde no siempre se ve el vídeo).
- **Ventana pequeña:** al pulsar cualquiera de esos botones se abre solo el diálogo "Agregar descarga" en una ventana pequeña, sin mostrar la aplicación entera, para que elijas calidad o formato. Al descargar, la ventana se cierra y la app sigue en la bandeja; al empezar te avisa con una notificación y otra al terminar.
- En **Opciones de la extensión** puedes desactivar el botón sobre los vídeos y el botón redondo.
- Botón **"Descargar vídeo o audio de esta página"** en la ventana del icono de la extensión.
- Menú de clic derecho: **"Descargar vídeo o audio de esta página"** (en cualquier página) y **"Descargar con LibreDescarga"** sobre enlaces, imágenes, vídeos y audios.
- La ventana emergente lista además los enlaces a archivos de la página.
- Opcionalmente, **intercepta** las descargas del navegador. Si la app no está abierta, deja que el navegador descargue con normalidad.

Seguridad: el servidor solo escucha en `127.0.0.1`, exige la cabecera `X-LibreDescarga-Token`, compara el token en tiempo constante y valida las URLs. Si regeneras el token en la app, actualízalo también en la extensión.

## 7. Pruebas automáticas

```powershell
npm test
```

Son 41 pruebas (16 de vídeo y audio, con descargas reales de YouTube en MP4 y MP3, pausa, reanudación y cancelación; 3 de segundo plano y portapapeles; 5 del actualizador, con un servidor simulado): reparto de segmentos, descarga con 8 conexiones con bytes idénticos al original, servidor sin `Range`, tamaño desconocido, reintentos, pausa con cierre y reanudación, cancelación, error 404, cola, limitador de velocidad, validación de la configuración, historial persistente, programador, servidor de la extensión, el flujo del actualizador y una **descarga real** de 10 MB desde internet.

## 8. Empaquetado (instalador .exe)

```powershell
npm run dist     # Genera el instalador:  dist\LibreDescarga-Setup-1.2.0.exe
npm run pack     # Solo la carpeta portable: dist\win-unpacked\LibreDescarga.exe (más rápido, útil para probar)
npm run icons    # (Opcional) Vuelve a dibujar los iconos
```

El instalador permite elegir la carpeta de instalación y crea accesos directos en el escritorio y en el menú Inicio. No está firmado digitalmente, así que Windows SmartScreen puede mostrar un aviso: pulsa *Más información → Ejecutar de todas formas*.


## 9. Actualizaciones automáticas

La app instalada busca versiones nuevas en **GitHub Releases** del repositorio `WilliamsAlexis/LibreDescarga-Windows` (configurado en `package.json`, apartado `build.publish`). Busca 15 segundos después de abrirse; se puede desactivar o lanzar a mano en **Configuración → Actualizaciones**. Nunca descarga ni instala nada sin que lo pidas, y al instalar guarda antes el progreso de las descargas en curso. En modo desarrollo (`npm start`) esta función está desactivada.

**Cómo publicar una versión nueva:**
1. Sube el número de `version` en `package.json` (por ejemplo, de `1.2.0` a `1.3.0`).
2. Ejecuta `npm run dist`.
3. En GitHub, crea un **Release** con la etiqueta `v1.3.0` y **márcalo como borrador (Draft)**. Sube a él **estos tres archivos** de la carpeta `dist`:
   - `LibreDescarga-Setup-1.3.0.exe`
   - `LibreDescarga-Setup-1.3.0.exe.blockmap`
   - `latest.yml`
4. Cuando estén **los tres** subidos, pulsa **Publish release**. Los usuarios con una versión anterior verán el aviso.

Importante:
- **Nunca publiques el Release antes de subir los tres archivos.** Mientras falte `latest.yml`, GitHub lo considera "la última versión" y la actualización de todos falla con "todavía no hay versiones publicadas".
- `latest.yml` apunta al instalador por su nombre exacto, así que no renombres los archivos.
- El repositorio debe ser **público**; si es privado, la app no podrá consultar las versiones.
- Si instalaste la app "para todos los usuarios", Windows pedirá permiso de administrador al actualizar.

## 10. Dónde se guardan los datos

- Configuración e historial: `%APPDATA%\libredescarga\` (`settings.json` y `downloads.json`).
- Descargas: `Descargas\LibreDescarga\<Categoría>\` por defecto.
- Partes temporales de una descarga en curso: en la carpeta `<archivo>.ldtmp`, junto al archivo final. Se borran al terminar o al cancelar.

## Licencia

MIT © 2026 Williams Alexis Lopez Coronado
