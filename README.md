# LibreDescarga

Gestor de descargas acelerado para Windows, al estilo de Internet Download Manager (IDM), hecho con **Electron** y **Node.js**.

- Descarga por **segmentos** (de 1 a 16 conexiones simultáneas con HTTP Range) y une las partes al terminar.
- **Pausar, reanudar y cancelar**, incluso después de cerrar y volver a abrir la app.
- **Cola** con límite de descargas simultáneas, **reintentos automáticos** con espera progresiva y **limitador de velocidad** global.
- **Categorías automáticas** (Videos, Música, Documentos, Programas, Comprimidos y Otros), cada una con su propia carpeta.
- **Historial** persistente con búsqueda y filtros, **programador** por hora y verificación **SHA-256** opcional.
- **Bandeja del sistema**, notificaciones, tema claro y oscuro, menú contextual y detección del portapapeles.
- **Extensión para Chrome y Edge** que envía los enlaces a la app.

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
│   │   ├── clipboardWatcher.js Detecta URLs copiadas al portapapeles
│   │   └── selfTest.js         Autoprueba de desarrollo (solo se activa con variables de entorno)
│   ├── preload/
│   │   └── preload.js      Puente seguro (contextBridge): expone window.api a la interfaz
│   ├── renderer/           INTERFAZ (HTML, CSS y JS, sin acceso a Node)
│   │   ├── index.html
│   │   ├── styles.css          Diseño, tema claro y oscuro, animaciones
│   │   └── js/                 app.js, ui.js, dialogs.js, state.js, format.js, icons.js
│   ├── services/           LÓGICA DE NEGOCIO (sin dependencias de la ventana)
│   │   ├── downloadTask.js     Motor: segmentos, Range, reintentos, pausa y reanudación, unión y hash
│   │   ├── downloadManager.js  Cola, límite de simultáneas, eventos y persistencia
│   │   ├── speedLimiter.js     Limitador global (token bucket) compartido por todas las conexiones
│   │   ├── scheduler.js        Programador de descargas por hora
│   │   ├── updater.js          Actualizaciones automáticas (electron-updater)
│   │   ├── settingsService.js  Valores por defecto y validación de la configuración
│   │   └── browserServer.js    Servidor HTTP local (127.0.0.1) para la extensión
│   └── utils/              Utilidades: categories, fileName, format, hash, http, sleep
├── extension/              Extensión de Chrome y Edge (Manifest V3)
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

## 5. Uso

### Agregar una descarga
- Pulsa **Agregar URL** (o `Ctrl+N`), pega el enlace y elige el número de conexiones, la carpeta, el hash SHA-256 (opcional) y la hora de inicio (opcional).
- **Portapapeles:** si copias una URL descargable, la app te ofrece añadirla. Se puede desactivar en Configuración.
- **Ctrl+V** fuera de un campo de texto, o **arrastrar y soltar** un enlace sobre la ventana, abre el mismo diálogo.

### Gestionar descargas
- Barra superior: iniciar, pausar, cancelar, eliminar, *iniciar todas*, *pausar todas* y *programar*.
- **Clic derecho** sobre una fila: abrir archivo, abrir carpeta, copiar la URL, pausar o reanudar, reintentar, eliminar…
- Selección múltiple con `Ctrl` y `Mayús`. `Ctrl+A` selecciona todo, `Supr` elimina y `Ctrl+F` busca.
- La barra lateral filtra por estado (En curso, Completadas, Sin terminar, Programadas) y por categoría.
- Cada fila muestra el nombre, el tamaño, el progreso, la velocidad, el tiempo restante y el estado.

### Reanudar después de cerrar
El progreso de cada segmento se guarda continuamente. Si cierras la app, o se va la luz, al volver a abrirla las descargas aparecen en **Sin terminar**. Al reanudarlas, siguen desde el último byte guardado, siempre que el servidor admita `Range`.

### Configuración (icono de engranaje)
Carpeta por defecto y carpeta por categoría, conexiones por descarga (1–16), descargas simultáneas, límite de velocidad (KB/s, 0 = sin límite), reintentos, tema (sistema, claro u oscuro), portapapeles, bandeja, notificaciones y el servidor para la extensión (puerto y token).

### Bandeja del sistema
Al cerrar la ventana, la app se minimiza a la bandeja y sigue descargando. Haz clic en el icono para volver a abrirla. Para cerrarla del todo, usa **Salir** en el menú del icono.

## 6. Extensión del navegador (Chrome y Edge)

1. Abre LibreDescarga → **Configuración** → sección *Navegador*. Copia el **token** y anota el **puerto** (6801 por defecto). El botón *Abrir carpeta de la extensión* te lleva a ella.
2. En el navegador, ve a `chrome://extensions` (o `edge://extensions`) y activa el **Modo de desarrollador**.
3. Pulsa **Cargar descomprimida** y elige la carpeta `extension/` del proyecto. En la app instalada está en `resources\extension`, dentro de la carpeta de instalación.
4. Abre las **opciones** de la extensión, pega el token, comprueba el puerto y pulsa *Probar conexión*.

Funciones de la extensión:
- Menú de clic derecho **"Descargar con LibreDescarga"** sobre enlaces, imágenes, vídeos y audios.
- La ventana emergente lista los enlaces descargables de la página.
- Opcionalmente, **intercepta** las descargas del navegador. Si la app no está abierta, deja que el navegador descargue con normalidad.

Seguridad: el servidor solo escucha en `127.0.0.1`, exige la cabecera `X-LibreDescarga-Token`, compara el token en tiempo constante y valida las URLs. Si regeneras el token en la app, actualízalo también en la extensión.

## 7. Pruebas automáticas

```powershell
npm test
```

Son 23 pruebas (5 son del actualizador, con un servidor de actualizaciones simulado): reparto de segmentos, descarga con 8 conexiones con bytes idénticos al original, servidor sin `Range`, tamaño desconocido, reintentos, pausa con cierre y reanudación, cancelación, SHA-256, error 404, cola, limitador de velocidad, validación de la configuración, historial persistente, programador, servidor de la extensión, el flujo del actualizador y una **descarga real** de 10 MB desde internet.

## 8. Empaquetado (instalador .exe)

```powershell
npm run dist     # Genera el instalador:  dist\LibreDescarga-Setup-1.0.0.exe
npm run pack     # Solo la carpeta portable: dist\win-unpacked\LibreDescarga.exe (más rápido, útil para probar)
npm run icons    # (Opcional) Vuelve a dibujar los iconos
```

El instalador permite elegir la carpeta de instalación y crea accesos directos en el escritorio y en el menú Inicio. No está firmado digitalmente, así que Windows SmartScreen puede mostrar un aviso: pulsa *Más información → Ejecutar de todas formas*.


## 9. Actualizaciones automáticas

La app instalada busca versiones nuevas en **GitHub Releases** del repositorio `WilliamsAlexis/LibreDescarga-Windows` (configurado en `package.json`, apartado `build.publish`). Busca 15 segundos después de abrirse; se puede desactivar o lanzar a mano en **Configuración → Actualizaciones**. Nunca descarga ni instala nada sin que lo pidas, y al instalar guarda antes el progreso de las descargas en curso. En modo desarrollo (`npm start`) esta función está desactivada.

**Cómo publicar una versión nueva:**
1. Sube el número de `version` en `package.json` (por ejemplo, de `1.0.0` a `1.1.0`).
2. Ejecuta `npm run dist`.
3. En GitHub, crea un **Release** con la etiqueta `v1.1.0` y sube a él **estos tres archivos** de la carpeta `dist`:
   - `LibreDescarga-Setup-1.1.0.exe`
   - `LibreDescarga-Setup-1.1.0.exe.blockmap`
   - `latest.yml`
4. Publica el Release (no como borrador ni como pre-lanzamiento). Los usuarios con una versión anterior verán el aviso.

Importante: `latest.yml` apunta al instalador por su nombre exacto, así que no renombres los archivos. El repositorio debe ser **público**; si es privado, la app no podrá consultar las versiones.

## 10. Dónde se guardan los datos

- Configuración e historial: `%APPDATA%\libredescarga\` (`settings.json` y `downloads.json`).
- Descargas: `Descargas\LibreDescarga\<Categoría>\` por defecto.
- Partes temporales de una descarga en curso: en la carpeta `<archivo>.ldtmp`, junto al archivo final. Se borran al terminar o al cancelar.

## Licencia

MIT © 2026 Williams Alexis Lopez Coronado
