# Guía: Publicar en Facebook Marketplace con AutoCore P1

Cómo llevar un vehículo del inventario a una publicación viva en Facebook
Marketplace, y cómo responder a los compradores — todo desde AutoCore P1 con
la extensión de Chrome.

**Regla de oro:** el diseño es *humano-en-el-bucle*. La extensión **prepara**
publicaciones y **asiste** respuestas, pero **tú** haces clic en Publicar y en
Enviar. Esto es intencional (reduce el riesgo de bloqueo de Facebook).

---

## 0. Preparación (una sola vez)

1. **Instala la extensión** (si no lo has hecho):
   - Construye: en la carpeta del proyecto corre `npm run build:ext`.
   - Abre `chrome://extensions` → activa **Modo desarrollador** (arriba a la
     derecha) → **Cargar descomprimida** → elige la carpeta
     `autocore-p1-extension\dist`.
   - Fija el ícono de AutoCore P1 a la barra de Chrome (ícono de pieza de
     rompecabezas → chincheta).
2. **Inicia sesión en la extensión**: clic en el ícono → **Iniciar sesión** con
   tu cuenta de staff (la misma de autocore-p1.pages.dev). El popup debe mostrar
   "Sesión: tu-correo" y contadores.
3. **Interruptores** (en el popup): deja **"Extensión activa"** encendido y
   **"Kill switch"** apagado. Deja **"Auto-send"** APAGADO (recomendado).

---

## 1. Crear la publicación en AutoCore P1

Tienes dos caminos para crear el borrador:

### A) Desde el inventario importado (lo más rápido)
1. Ve a **Inventario → Importar del sitio web** (`/inventario/importar`).
2. En la fila del vehículo, clic en **"Crear borrador FB"**.
   - Esto crea un borrador en Marketplace con el título, precio y fotos ya
     copiados del sitio.

### B) Manual, desde el módulo Marketplace
1. Ve a **CRM → Marketplace** (`/crm/marketplace`).
2. Clic en **"Nueva publicación"**.
3. (Opcional) Elige una **unidad de inventario** para pre-llenar el título.
4. Escribe/ajusta **Título**, **Precio (USD)** y **Descripción**.
5. Guardar.

> Sobre las fotos: se guardan en el borrador como referencia, pero **Facebook
> exige adjuntarlas a mano** al publicar (la extensión no puede subir imágenes).

### Descargar TODAS las fotos a tu PC (sin capturas de pantalla)

```
powershell -ExecutionPolicy Bypass -File scripts\site-sync-local.ps1 -Fotos
```

- Baja la galería completa de **todos** los vehículos del sitio a
  `autocore-p1\fotos\`, **una carpeta por vehículo nombrada por número de
  stock** (ej. `D057217_2022-HYUNDAI-TUCSON\01.jpg, 02.jpg, ...`). El stock va
  primero: es la clave única del dealer (los títulos se repiten — hay tres
  "FORD TRANSIT 250 CARGO VAN" — los stocks no), así las carpetas quedan
  ordenadas por stock. Abre la carpeta al terminar. No necesita ninguna clave.
- Re-ejecutar solo baja lo nuevo (lo ya descargado se salta). Tarda unos
  minutos la primera vez.
- Al publicar en Facebook: botón de fotos → navega a la carpeta del vehículo
  (búscala por su número de stock) → selecciona todas → listo.
- **Si falta algún vehículo:** el sitio del dealer a veces responde con la
  pantalla "Just a moment..." de Cloudflare y ese vehículo se salta (verás
  `"failed"` en el resumen). No es un error tuyo — vuelve a correr el comando
  y lo toma; lo ya descargado no se vuelve a bajar.

### Generar la descripción (lista para pegar)

- **Automática:** al usar **"Crear borrador FB"** desde Importar, el borrador ya
  trae una descripción bilingüe (EN + ES) generada con los datos reales del
  vehículo (millas, motor, transmisión, VIN) y una llamada a la acción.
- **Manual:** en el modal de CRM → Marketplace, botón **"Generar descripción"**.
- **Tu WhatsApp en la descripción:** pon tu número en
  `app/tenant.config.ts` → `whatsappVentas` (solo dígitos, ej. `17865551234`)
  y reconstruye/redeploya. Con eso cada descripción incluye tu enlace
  `https://wa.me/...` para que el cliente te escriba directo. Sin número, la
  descripción invita a escribir por Messenger.

---

## 2. Marcar "Listo para publicar"

1. En **CRM → Marketplace**, encuentra tu borrador (estado **Borrador**).
2. Clic en **"Listo para publicar"**.
3. El estado cambia a **Listo p/ publicar** — ahora entra en la cola que lee la
   extensión.

Puedes tener varias en cola; la extensión toma la más antigua primero.

---

## 3. Publicar en Facebook (con la extensión)

1. Abre una pestaña en **https://www.facebook.com/marketplace/create/vehicle**
   (Marketplace → Crear → Vehículo).
2. Aparece el panel **"AutoCore P1 — Publicar"** (arriba a la derecha) con el
   siguiente vehículo de la cola.
3. Clic en **"Prellenar formulario"**. La extensión llena **título, precio y
   descripción** en el formulario de Facebook.
   - Verás un resumen: "Prellenado: título, precio, descripción."
   - Si dice que no encontró campos, asegúrate de estar en la página de
     *crear vehículo* y de haber elegido "Vehículo" como tipo.
4. **Adjunta las fotos a mano** (botón de fotos de Facebook) y **revisa** todos
   los campos (año, kilometraje, ubicación, etc. — completa lo que Facebook pida
   y la extensión no llenó).
5. Cuando esté correcto, **haz clic en Publicar** (el botón de Facebook — tú, no
   la extensión).
6. Copia la **URL de la publicación** ya viva.
7. En el panel, clic en **"Marcar publicado"** → pega la URL cuando la pida.
   - El estado en AutoCore pasa a **Publicado** y guarda el enlace.
   - Si quieres saltar este vehículo, usa **"Saltar (siguiente)"**.

---

## 4. Responder a los compradores

Cuando alguien escribe por la publicación:

1. **Se sincroniza solo.** Con Facebook Marketplace abierto (bandeja de
   entrada / conversación), el lector de la extensión copia la conversación a
   AutoCore P1 → **CRM → Chats**, canal **Facebook Marketplace** (chip azul
   "FB"). Es solo lectura, automático.
2. **Respondes desde AutoCore.** En **CRM → Chats**, abre la conversación FB y
   escribe tu respuesta. En canal FB, tu respuesta **se pone en cola** (no se
   envía sola).
3. **Envías en Facebook (asistido).** Vuelve a la conversación en Facebook: el
   panel **"AutoCore P1 — Respuestas"** (abajo a la derecha) lista tus respuestas
   en cola.
   - Clic en **"Insertar"** → la extensión escribe el texto en la caja de
     Facebook. **Tú haces clic en Enviar** en Facebook.
   - Luego clic en **"Marcar enviado"** (o "Marcar fallido" si algo salió mal).

> **Auto-send (opcional, riesgoso):** en el popup puedes activar "Auto-send".
> Entonces la extensión escribe *y envía* con retrasos tipo humano, respetando
> "Máx. envíos por hora" y el "Horario permitido". Déjalo apagado salvo que
> sepas lo que haces — enviar solo aumenta el riesgo de bloqueo de Facebook.

---

## 5. Estados de una publicación

| Estado | Significado |
|---|---|
| Borrador | Creada en AutoCore, aún no en cola |
| Listo p/ publicar | En cola; la extensión la tomará |
| Publicado | Viva en Facebook (guarda la URL) |
| Pausado | Retirada temporalmente |
| Vendido | Se vendió (márcala así al cerrar) |
| Removido | Ya no se ofrece |

Cambia estados desde **CRM → Marketplace** con los botones de cada fila.

---

## 6. Buenas prácticas

- **Título claro:** Año + Marca + Modelo + detalle clave (ej. "2021 Ford Transit
  250 Cargo Van — Alta, 3.5L"). Para comerciales, di si es cargo/pasajeros.
- **Precio realista:** el del sitio del dealer, en USD.
- **Descripción:** condición, kilometraje, VIN, extras, y una llamada a la
  acción ("Escríbeme para agendar una prueba"). No prometas financiamiento
  específico sin confirmarlo.
- **Fotos:** varias, buena luz, exterior + interior + motor/carga. Facebook
  favorece publicaciones con muchas fotos.
- **No publiques en ráfaga:** publicar muchas de golpe es señal de bot. Espacia.
- **Responde rápido:** los leads de Marketplace se enfrían en minutos.

---

## 7. Problemas comunes

- **"Facebook cambió su interfaz — extensión pausada"** (popup): Facebook
  actualizó su HTML y los selectores fallaron 3 veces. No es un error tuyo. La
  extensión se pausa sola para no equivocarse. Avísame y actualizo el archivo
  de selectores (`autocore-p1-extension/src/selectors.ts`); reconstruyo con
  `npm run build:ext` y recargas la extensión.
- **El panel no aparece:** confirma que estás logueado en la extensión (popup) y
  que "Extensión activa" está encendido y "Kill switch" apagado. Recarga la
  página de Facebook.
- **"Prellenar" no llena campos:** verifica que estás en
  `facebook.com/marketplace/create/vehicle` y tipo "Vehículo".
- **No veo la conversación en AutoCore:** ten abierta la bandeja de Marketplace
  en Facebook unos segundos para que el lector la capture; revisa el contador
  "Conversaciones sincronizadas" en el popup.
- **Botón de emergencia:** el **Kill switch** del popup detiene TODO al instante.

---

## Resumen del flujo

```
Inventario ─▶ CRM/Marketplace (borrador) ─▶ "Listo para publicar"
   └▶ extensión prellena create/vehicle ─▶ TÚ adjuntas fotos + Publicas ─▶ "Marcar publicado"

Comprador escribe ─▶ se sincroniza a CRM/Chats (canal FB)
   └▶ TÚ respondes en AutoCore (se encola) ─▶ extensión "Insertar" ─▶ TÚ Envías en Facebook
```
