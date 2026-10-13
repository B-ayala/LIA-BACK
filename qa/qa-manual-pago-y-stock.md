# QA manual — Proceso de pago y stock por talle (Damiana Bella)

Guía para probar a mano, de punta a punta, el proceso de compra: Mercado Pago, transferencia, stock por talle, vencimiento de reservas, pagos en proceso y el panel de administración. Cada caso dice qué hacer, qué tiene que pasar y dónde anotar el resultado.

> Este documento no reemplaza `qa/test-plan.md` (plan técnico con IDs TC-xxx). Es la guía operativa para quien ejecuta las pruebas.

---

## 1. Qué se cambió y por qué se prueba

| Tema | Qué cambió | Riesgo si falla |
|---|---|---|
| Stock por talle | El servidor ahora valida y descuenta el stock de cada talle, no solo el total. Al cancelar o vencer, el talle recupera su stock. | Vender dos veces el mismo talle. |
| Volver con "Atrás" | Se cancela la reserva anterior, pero antes se le pregunta a Mercado Pago si hay un pago en curso o aprobado. | Cobrar dos veces o liberar stock de una compra que sí se pagó. |
| Vencimiento | A los 15 min una compra sin pagar vence y devuelve el stock. Un pago en proceso retiene el stock hasta 24 h. | Stock bloqueado o liberado de más. |
| Medios diferidos | Rapipago, Pago Fácil y cajeros ya no se ofrecen. | Stock retenido días por pagos que no llegan. |
| Avisos al comprador | Hora límite de pago, aviso de plazo vencido, "pago en proceso", "pago ya acreditado". | Comprador confundido que paga dos veces. |
| Carrito | Se actualiza precio y talles al entrar al checkout; se sincroniza entre pestañas. | Cobrar un precio distinto al mostrado. |
| Panel admin | Etiquetas de revisión, "Pago en proceso", botón "Confirmar pago tardío", edición de productos sin pisar stock. | Stock en 0 o inflado por error. |

---

## 2. Antes de empezar

### 2.1 Entorno
- [ ] URL del sitio a probar: ______________________
- [ ] Versión (commit o fecha de despliegue) del backend: ______ y del front: ______
- [ ] Confirmar con el responsable técnico que **ya se desplegaron backend y front nuevos** y que se aplicó la migración de base de datos del 2026-10-14. Si falta alguno, no empieces.

### 2.2 Cuentas (pedírselas al responsable)
- **Comprador A** — usuario del sitio con email confirmado (navegador normal).
- **Comprador B** — otro usuario del sitio (navegador en incógnito o distinto).
- **Admin** — usuario con rol administrador.
- **Comprador de prueba de Mercado Pago** — se usa para loguearse en la pantalla de pago de Mercado Pago (sandbox). No uses cuentas reales.

### 2.3 Tarjetas de prueba de Mercado Pago (Argentina)
El **nombre del titular** decide el resultado:

| Titular | Resultado |
|---|---|
| `APRO` | Pago aprobado |
| `OTHE` | Rechazado |
| `CONT` | Queda pendiente (pago en proceso) |

Datos de la tarjeta: Mastercard `5031 7557 3453 0604` o Visa `4509 9535 6623 3704`; vencimiento cualquiera futuro (ej. `11/30`); CVV `123`; DNI `12345678`.

### 2.4 Producto de prueba — REGLA DE SEGURIDAD
**Usá únicamente el producto "Prueba".** El sitio apunta a datos reales: no compres, edites ni canceles ningún otro producto.

Preparación (la hace el Admin desde el panel → Productos → editar "Prueba"):
- Talle **M = 1 unidad**
- Talle **L = 3 unidades**
- (total 4)
- Anotá el stock inicial exacto: M = ___, L = ___.

Para los casos de "producto sin talles" (sección 9) el responsable técnico te indicará qué producto usar; no uses uno real sin confirmarlo.

### 2.5 Herramientas
- Dos navegadores o uno normal + uno en incógnito (comprador A y B).
- Un teléfono (Android y/o iPhone) para la sección 11.
- Un reloj: varios casos requieren esperar **16 minutos**. Conviene lanzarlos primero (B4 / PAG-05 y PEN-01) y hacer el resto mientras tanto.
- Capturas de pantalla para cada falla.

### 2.6 Cómo ver el stock sin acceso a la base
Panel Admin → **Stock** (`/admin/stock`) o Productos → editar "Prueba" (muestra el stock por talle). Si tenés acceso de solo lectura a la base, mirá el Apéndice A.

### 2.7 Cómo registrar el resultado
Por cada caso marcá `ok`, `fail` o `no probado`. En un `fail`: captura, URL, hora, usuario, y qué se esperaba vs. qué pasó. Plantilla en el Apéndice B.

---

## 3. Pago con Mercado Pago (flujo principal)

> **Orden recomendado:** PAG-01 primero (si falla, todo lo demás pierde sentido). Lanzá PAG-05 y PEN-01 enseguida porque esperan 16 min.

### PAG-01 — Pago aprobado (el caso más importante)
- **Tipo:** happy path / regresión
- **Pre-condición:** stock inicial anotado. Comprador A logueado.
- **Pasos:**
  1. Entrá a "Prueba", elegí talle **L**, cantidad 1, agregá al carrito o "Comprar".
  2. Andá a `/checkout`. Elegí "Retiro en local" y "Pagar con Mercado Pago".
  3. Apretá "Continuar al pago". En el aviso, leé el texto y apretá "Ir a Mercado Pago".
  4. En Mercado Pago logueate con el comprador de prueba y pagá con tarjeta, titular **APRO**.
  5. Volvé al sitio (botón de Mercado Pago o redirección automática).
- **Esperado:**
  - Pantalla "¡Pago aprobado!" (puede mostrar antes "Confirmando tu pago…").
  - La compra aparece en "Mis compras" del comprador A.
  - Stock: total −1 y talle L −1 (una sola vez, no dos).
  - El carrito de A quedó sin ese producto.
  - En Admin → Ventas la venta figura **Pagado**, sin etiqueta roja.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### PAG-02 — Pago rechazado
- **Pasos:** igual que PAG-01 pero titular **OTHE**.
- **Esperado:** mensaje de que el pago no se pudo completar; la orden queda **Cancelada** en Ventas; el stock vuelve a su valor inicial (total y talle).
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### PAG-03 — Aviso previo a Mercado Pago
- **Pasos:** llegar al aviso de PAG-01 paso 3 y **no** confirmar.
- **Esperado:** el aviso indica el plazo de 15 minutos con la **hora límite** (HH:MM = hora actual + 15 min). "Volver" cierra el aviso sin crear ninguna orden. Escape también cierra.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### PAG-04 — Medios de pago diferidos no disponibles
- **Pasos:** en la pantalla de Mercado Pago, abrí "Elegir otro medio de pago".
- **Esperado:** **no** aparecen Rapipago, Pago Fácil ni cajero/ticket. Sí tarjetas y dinero en cuenta.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### PAG-05 — Abandono: ir a Mercado Pago y no pagar (espera 16 min)
- **Pre-condición:** stock inicial anotado.
- **Pasos:**
  1. Comprador A: producto "Prueba", talle **L**, 1 unidad → "Ir a Mercado Pago".
  2. En Mercado Pago **no pagues**; cerrá la pestaña.
  3. Revisá el stock inmediatamente: debe estar descontado (total −1, L −1).
  4. Esperá **16 minutos** y revisá de nuevo.
- **Esperado:** inmediatamente descontado; a los ~16 min la orden queda **Expirada** y el stock vuelve al valor inicial (total y talle).
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### PAG-06 — Pago aprobado con la pantalla de resultado recargada
- **Pasos:** después de PAG-01, en `/checkout/result?...` apretá F5 varias veces.
- **Esperado:** no se duplica nada (misma compra, un solo descuento de stock); el carrito **no pierde** productos ajenos a la compra.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### PAG-07 — Mercado Pago sin respuesta o error de creación
- **Pasos (con el responsable técnico, desconectando temporalmente el token de MP en un entorno de prueba — no en producción):** intentar pagar.
- **Esperado:** mensaje claro ("no se pudo conectar…, intentá de nuevo o elegí transferencia"); no se redirige a una página rara (`about:undefined`); el stock no queda descontado.
- **Resultado:** ☐ ok ☐ fail ☐ no probado ☐ requiere dev

---

## 4. Stock por talle

> Estado inicial: M = 1, L = 3.

### STK-01 — Compra descuenta el total y el talle
- **Pasos:** comprar 1 unidad de **M** y pagar con APRO.
- **Esperado:** total −1 y **M = 0**, L sin cambios. En la ficha, M aparece agotado.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### STK-02 — Dos compradores, un talle con 1 unidad (caso clave)
- **Pre-condición:** M = 1. A y B, cada uno en su navegador, con **1 unidad de M** en el carrito y parados en el paso de pago (todavía sin apretar "Continuar al pago").
- **Pasos:**
  1. A: "Continuar al pago" → "Ir a Mercado Pago" (sin pagar).
  2. B: "Continuar al pago".
- **Esperado:** B ve un mensaje legible tipo **"No hay stock suficiente del talle M de Prueba"** y no avanza a Mercado Pago. No se crea ninguna venta para B. M = 0 por la reserva de A.
- **Verificar además:** B tiene una forma de salir (cambiar talle, quitar el producto o volver al producto) y no queda trabado.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### STK-03 — Se libera la reserva y B puede comprar
- **Pasos (sigue a STK-02):** A vuelve con "Atrás" desde Mercado Pago a `/checkout`. B reintenta "Continuar al pago".
- **Esperado:** la orden de A queda **Cancelada**; M vuelve a 1; B ahora sí llega a Mercado Pago.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### STK-04 — Compra de talles distintos en el mismo pedido
- **Pasos:** 1 unidad de M y 1 de L en el mismo carrito → pagar con APRO.
- **Esperado:** M −1 y L −1 por separado; total −2.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### STK-05 — Cancelar devuelve el talle
- **Pasos:** crear una compra (llegar a Mercado Pago) y luego cancelarla volviendo con "Atrás".
- **Esperado:** stock total **y** el talle comprado vuelven al valor inicial (no solo el total).
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### STK-06 — Pedir más unidades que las disponibles de un talle
- **Pasos:** intentar agregar 2 unidades de M (con M = 1), desde la ficha y desde el carrito (botón "+").
- **Esperado:** el sitio no deja pasar de 1; el botón "+" se deshabilita o avisa. No se puede llegar a pagar.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### STK-07 — Carrito desactualizado (talle que se agotó mientras estaba en el carrito)
- **Pasos:** A deja M en el carrito sin pagar; B compra el último M y paga (APRO). A recarga `/checkout`.
- **Esperado:** A ve un aviso de que ese talle ya no está disponible, con opción de cambiar el talle o quitar el producto; el botón de pagar no avanza con una línea inválida.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### STK-08 — Cambio de precio mientras está en el carrito
- **Pasos:** el Admin cambia el precio de "Prueba". A (con el producto en el carrito) entra a `/checkout`.
- **Esperado:** A ve un aviso de que el precio cambió y el resumen muestra el precio nuevo; el monto en Mercado Pago coincide con el resumen. (Restaurar el precio original al terminar.)
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### STK-09 — Producto sin selección de talle
- **Pasos:** intentar comprar "Prueba" sin elegir talle.
- **Esperado:** el sitio exige elegir talle antes de agregar al carrito o comprar (mensaje claro).
- **Resultado:** ☐ ok ☐ fail ☐ no probado

---

## 5. Volver con "Atrás" y vencimiento

### ATR-01 — Volver con "Atrás" sin pagar (antes de 15 min)
- **Pasos:** llegar a Mercado Pago y volver con el botón Atrás del navegador a `/checkout`.
- **Esperado:** breve leyenda "Liberando tu reserva anterior…" con el botón de pago deshabilitado; después se habilita; la orden anterior queda **Cancelada** y el stock vuelve. Podés reintentar y se crea una orden nueva sin error de stock (aunque quede 1 sola unidad).
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### ATR-02 — Volver con "Atrás" después de 15 min
- **Pasos:** llegar a Mercado Pago, esperar más de 15 min, volver con Atrás.
- **Esperado:** mismo resultado que ATR-01 y además un aviso rojo **"Se venció el tiempo para pagar…"** (solo si realmente se liberó). La pantalla de Mercado Pago, mientras tanto, muestra su propio error de "ya no se encuentra disponible": es normal y no se puede cambiar.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### ATR-03 — Pagar y volver con "Atrás" antes de que te devuelvan al sitio (CLAVE: evita cobro doble)
- **Pasos:** pagar con APRO y, **antes** de volver al sitio, apretar Atrás hasta llegar a `/checkout`.
- **Esperado:** el sitio muestra **"Tu pago ya fue acreditado"** (o similar) con enlace a "Mis compras"; el carrito ya no tiene ese producto; no hay invitación a pagar de nuevo. La venta queda **Pagada** y el stock descontado **una sola vez**.
- **Si en cambio ves el carrito lleno y el botón de pagar sin ningún aviso: es un fallo grave.**
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### ATR-04 — Atrás con pago en proceso (tarjeta CONT)
- **Pasos:** pagar con titular **CONT**; si Mercado Pago te permite volver a la tienda con Atrás, hacerlo hacia `/checkout`.
- **Esperado:** aviso **"Tu pago todavía se está procesando… no vuelvas a pagar"**; el botón de pagar queda bloqueado; la orden **no** se cancela y el stock sigue retenido.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### ATR-05 — Atrás rápido y reintento inmediato (última unidad)
- **Pre-condición:** M = 1.
- **Pasos:** ir a Mercado Pago con M, volver con Atrás y apretar enseguida "Continuar al pago".
- **Esperado:** no aparece "No hay stock suficiente" contra la propia reserva anterior: el sitio espera a liberarla antes de dejarte avanzar.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### ATR-06 — Botón "Volver al sitio" de Mercado Pago sin pagar
- **Pasos:** en Mercado Pago apretar "Volver a la tienda" sin pagar.
- **Esperado:** pantalla de resultado indicando que el pago no se completó; orden **Cancelada**; stock restaurado.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### ATR-07 — Pantalla de Mercado Pago de "link vencido"
- **Pasos:** abrir el link de pago de PAG-05 pasados los 15 min (en la pestaña que quedó abierta o en el historial).
- **Esperado:** Mercado Pago muestra su mensaje ("ya no se encuentra disponible") y **no deja pagar**. Es un mensaje de Mercado Pago y no se puede personalizar. Volviendo al sitio, el comprador ve el aviso de plazo vencido.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

---

## 6. Pagos en proceso y vencimientos del sistema

### PEN-01 — Pago pendiente (CONT) retiene la reserva (espera 16 min)
- **Pasos:** Comprador B: "Prueba" talle **L**, 1 unidad → Mercado Pago → pagar con titular **CONT** → volver al sitio. Esperar **16 min**.
- **Esperado:** pantalla de "pago en proceso". Pasados los 16 min la venta **sigue pendiente** (en Ventas aparece **"Pago en proceso"**, no "Expirado") y el stock sigue retenido (total −1, L −1). El carrito de B no conserva ese producto.
- **Limpieza:** esta orden puede quedar retenida hasta **24 horas**. Pedile al responsable técnico que la libere al terminar.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### PEN-02 — Un pago en proceso que luego se aprueba
- **Pasos:** si Mercado Pago permite aprobar el pago CONT en el sandbox, aprobarlo (con el responsable técnico).
- **Esperado:** la venta pasa a **Pagada** sin que el comprador haga nada (webhook o conciliación); aparece en "Mis compras"; el stock queda descontado una sola vez.
- **Resultado:** ☐ ok ☐ fail ☐ no probado ☐ requiere dev

### PEN-03 — Transferencia vence a las 5 h
- **Pre-condición:** una orden de transferencia sin confirmar (no hace falta esperar: acordar con el responsable técnico cómo simular el paso del tiempo).
- **Esperado:** la orden pasa a **Expirada** y el stock vuelve (total y talle).
- **Resultado:** ☐ ok ☐ fail ☐ no probado ☐ requiere dev

---

## 7. Transferencia bancaria

### TRF-01 — Compra por transferencia
- **Pasos:** comprador A, "Prueba" talle L, 1 unidad, "Transferencia por alias" → "Continuar al pago".
- **Esperado:** se muestra un panel **"Pedido creado"** con botón/enlace **"Abrir WhatsApp"** (aunque el navegador haya bloqueado la ventana emergente). Stock descontado (total −1, L −1). El pedido figura **Pendiente** en Ventas. Mientras no se vacíe el carrito no se puede crear otro pedido igual.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### TRF-02 — Doble clic / reenvío
- **Pasos:** apretar dos veces seguidas "Continuar al pago" con transferencia; si se bloquea la ventana de WhatsApp, apretar de nuevo.
- **Esperado:** se crea **una sola** orden y se descuenta el stock **una sola vez** (revisar en Ventas y en Stock).
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### TRF-03 — Admin confirma la transferencia
- **Pasos:** Admin → Ventas → la orden de TRF-01 → Confirmar pago (con confirmación).
- **Esperado:** pasa a **Pagada**; el stock **no** se descuenta de nuevo.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### TRF-04 — Admin cancela la transferencia
- **Pasos:** crear otra orden de transferencia → Admin la cancela.
- **Esperado:** **Cancelada** y stock restaurado (total y talle). Reintentar cancelarla/confirmarla: mensaje de que ya no está pendiente, sin cambios.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### TRF-05 — Transferencia que llega después de 5 h (pago tardío)
- **Pre-condición:** una transferencia en estado **Expirada** (acordar con el responsable técnico cómo obtenerla).
- **Pasos:** Admin → Ventas → fila expirada → **"Confirmar pago tardío"** → confirmar.
- **Esperado:** si había stock: pasa a **Pagada** y descuenta stock. Si ya no había: pasa a Pagada con etiqueta roja **"Sin stock: reembolsar"** y un aviso claro al admin. El botón solo aparece en transferencias expiradas.
- **Resultado:** ☐ ok ☐ fail ☐ no probado ☐ requiere dev

---

## 8. Panel de administración

### ADM-01 — Ventas carga correctamente
- **Pasos:** Admin → Ventas.
- **Esperado:** la tabla carga sin errores (si aparece un error de "migración", avisar al responsable técnico de inmediato). Filtros por estado y método funcionan.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### ADM-02 — Estado "Pago en proceso"
- **Pasos:** con la orden de PEN-01, mirar Ventas pasados 15 minutos.
- **Esperado:** se ve **"Pago en proceso"** (no "Expirado"); el filtro y los contadores de pendientes coinciden con lo que se ve en la tabla.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### ADM-03 — Etiquetas de revisión
- **Esperado (cuando el responsable técnico fuerza o se produce el caso):** etiqueta **"Sin stock: reembolsar"** y etiquetas **"Revisar: monto distinto / cobro duplicado / reembolsado / contracargo"** con colores legibles, en la tabla de escritorio y en la vista móvil.
- **Resultado:** ☐ ok ☐ fail ☐ no probado ☐ requiere dev

### ADM-04 — Despachos
- **Pasos:** Admin → Despachos → cambiar el estado de despacho de una venta de prueba.
- **Esperado:** se guarda y se ve el cambio. (Es lo único que el admin puede cambiar desde el navegador.)
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### ADM-05 — Acciones sensibles piden confirmación
- **Pasos:** confirmar, cancelar o "pago tardío" desde Ventas.
- **Esperado:** siempre hay un diálogo de confirmación; mientras corre, el botón se deshabilita (un doble clic no manda dos acciones); el resultado se informa en pantalla (ok o error), no con ventanas `alert` del navegador.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

---

## 9. Edición de productos desde el admin (stock)

> Riesgo: antes del cambio, editar un producto podía **pisar stock** o dejarlo en 0. Probar solo con "Prueba" o con el producto que indique el responsable.

### PRD-01 — Editar sin cambiar el stock
- **Pasos:** Admin → Productos → editar "Prueba" → cambiar **solo la descripción** → guardar.
- **Esperado:** se guarda; el stock total y por talle **no cambia**.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### PRD-02 — El producto cambió mientras se editaba (CLAVE)
- **Pasos:**
  1. Admin abre el formulario de edición de "Prueba" (no guarda todavía).
  2. En otro navegador, un comprador compra 1 unidad de M o L (pago APRO o llegar a Mercado Pago).
  3. El Admin cambia la descripción y guarda.
- **Esperado:** el guardado se **rechaza** con un mensaje tipo "El producto cambió mientras lo editabas…". El sitio recarga los datos del producto y **conserva lo que el admin escribió** (salvo el stock por talle, que toma el valor actual). El stock **no vuelve** al valor viejo.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### PRD-03 — Producto sin stock por talle (stock en 0)
- **Pre-condición:** producto indicado por el responsable (con stock mayor a 0 y **sin** desglose por talle).
- **Pasos:** Admin edita ese producto, cambia **solo el precio** y guarda.
- **Esperado:** el stock **no se pone en 0**. En el formulario el stock aparece como dato de solo lectura con una nota.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### PRD-04 — Borrar un producto con ventas pendientes
- **Pre-condición:** "Prueba" con una venta **pendiente** (por ejemplo, la del PAG-05 sin esperar el vencimiento).
- **Pasos:** intentar eliminar el producto desde el admin. (**No** hacerlo con un producto real.)
- **Esperado:** el sistema **no lo elimina** y explica que tiene ventas pendientes.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### PRD-05 — Vista previa de producto
- **Pasos:** crear/editar producto → "Ver vista previa" → "Editar producto" → guardar.
- **Esperado:** el borrador se conserva entre pantallas y el guardado sigue controlando los cambios concurrentes (como PRD-02).
- **Resultado:** ☐ ok ☐ fail ☐ no probado

---

## 10. Dos pestañas, concurrencia y mala conexión

### CON-01 — Doble clic en "Ir a Mercado Pago"
- **Pasos:** apretar dos veces rápido "Ir a Mercado Pago".
- **Esperado:** una sola orden creada (revisar en Ventas), un solo descuento de stock.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### CON-02 — Dos pestañas del mismo usuario: carrito
- **Pasos:** con el mismo usuario, abrir el sitio en dos pestañas. En la pestaña 1 agregar el producto al carrito. Mirar la pestaña 2 sin recargar.
- **Esperado:** el carrito se actualiza solo en la pestaña 2. Si se vacía el carrito en una pestaña (por una compra pagada), la otra no lo "resucita".
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### CON-03 — Pagar en una pestaña y abrir `/checkout` en la otra
- **Pasos:** pestaña 1: pagar con APRO (sin cerrar Mercado Pago). Pestaña 2: abrir `/checkout`.
- **Esperado:** no se cancela la orden que se está pagando; si la pestaña 2 detecta la compra, informa que ya está pagada o en proceso. La venta termina **Pagada**.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### CON-04 — Duplicar pestaña en plena compra
- **Pasos:** estando en el paso de pago, usar "Duplicar pestaña" del navegador y operar en la copia.
- **Esperado:** no se pierde ni se cancela una compra que la otra pestaña está pagando; ningún error sin explicación.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### CON-05 — Mala conexión
- **Pasos:** con las herramientas del navegador (DevTools → Network → "Offline" o "Slow 3G"), apretar "Continuar al pago" / "Ir a Mercado Pago".
- **Esperado:** mensaje en lenguaje humano tipo **"No pudimos conectarnos. Revisá tu conexión y reintentá."** (nunca "Failed to fetch" ni "Load failed" crudo). El botón no queda cargando para siempre (a lo sumo ~20 segundos). Al reintentar con conexión **no** se duplica la orden.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### CON-06 — Recarga durante el checkout
- **Pasos:** F5 en `/checkout`, en `/checkout?paso=pago` y en `/checkout/result`.
- **Esperado:** la pantalla carga (sin quedar en blanco o cargando), conserva el paso y el carrito; en `/checkout/result` no vacía el carrito entero ni repite acciones.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### CON-07 — Atrás/Adelante del navegador con caché (Safari/iPhone sobre todo)
- **Pasos:** ir a Mercado Pago y volver con Atrás (en Safari de iPhone y en Chrome).
- **Esperado:** el botón **no** queda en "Redirigiendo a Mercado Pago…" deshabilitado para siempre; se puede reintentar.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

---

## 11. Seguridad y permisos (manual)

### SEG-01 — Usuario no logueado
- **Pasos:** abrir `/checkout` sin sesión.
- **Esperado:** pide iniciar sesión; no se puede pagar.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### SEG-02 — Usuario común no accede al admin
- **Pasos:** con el comprador A, abrir `/admin`, `/admin/sales`, `/admin/stock`.
- **Esperado:** acceso denegado o redirección; no se ven datos de ventas.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### SEG-03 — "Mis compras" solo muestra las propias
- **Pasos:** comparar "Mis compras" de A y de B.
- **Esperado:** cada uno ve **solo** sus compras pagadas.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### SEG-04 — Acciones de admin con usuario común (con ayuda de un desarrollador)
- **Pasos:** con el token del comprador A, intentar confirmar o cancelar una transferencia ajena y cancelar una orden de B.
- **Esperado:** rechazo (permisos insuficientes) sin cambios en la orden.
- **Resultado:** ☐ ok ☐ fail ☐ no probado ☐ requiere dev

---

## 12. Experiencia de usuario, accesibilidad y dispositivos

### UX-01 — Aviso previo accesible
- **Pasos:** abrir el aviso "Estás a un paso de finalizar tu compra" y usar solo el teclado (Tab, Shift+Tab, Enter, Escape).
- **Esperado:** el foco queda dentro del diálogo (no se escapa al fondo); el foco inicial está en **"Volver"**, no en "Ir a Mercado Pago"; Escape cierra.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### UX-02 — Textos en lenguaje humano
- **Pasos:** recorrer cada error de este documento.
- **Esperado:** ningún mensaje técnico crudo (códigos, "409", "undefined", inglés). Tono consistente de voseo.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### UX-03 — Avisos legibles
- **Pasos:** ver los banners nuevos (plazo vencido, pago en proceso, pago acreditado, precio cambió, etiquetas del admin).
- **Esperado:** buen contraste, no tapan botones, se anuncian a lectores de pantalla (el aviso de plazo vencido tiene rol de alerta).
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### UX-04 — Responsive
- **Pasos:** repetir PAG-01, STK-02 y los avisos nuevos en 320, 375, 768, 1024 y 1440 px.
- **Esperado:** sin scroll horizontal, botones de al menos 44 px, nada cortado.
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### UX-05 — Cross-browser / dispositivos
Probar PAG-01, TRF-01, ATR-01 y CON-07 en: ☐ Chrome (PC) ☐ Safari iPhone ☐ Chrome Android ☐ Firefox ☐ Edge.
- **Esperado especial en Safari/Firefox:** al crear una transferencia, WhatsApp **no** queda bloqueado sin alternativa (siempre aparece el botón "Abrir WhatsApp").
- **Resultado:** ☐ ok ☐ fail ☐ no probado

### UX-06 — Estados de carga, vacío y error
- **Pasos:** con el carrito vacío entrar a `/checkout`; con conexión lenta ver carga; forzar un error.
- **Esperado:** cada vista tiene estado de carga, vacío (con acción sugerida) y error (con "Reintentar").
- **Resultado:** ☐ ok ☐ fail ☐ no probado

---

## 13. Regresión general (el resto del sitio)
Verificar rápidamente que nada se rompió fuera del pago:
- [ ] Home, listado de productos (filtros, búsqueda, paginación), detalle de producto, carrusel, footer
- [ ] Registro, login, logout, recuperar contraseña
- [ ] Carrito: agregar, quitar, cambiar cantidad/talle
- [ ] Envío: cotización por código postal, retiro en local
- [ ] Mis compras
- [ ] Admin: productos (crear/editar con imágenes), usuarios, despachos, home/about/footer/temas

---

## 14. Casos que el QA manual NO puede ejecutar (los cubre el equipo técnico)
Se listan para que no se den por probados por error:

| Caso | Por qué no se prueba a mano |
|---|---|
| Pago acreditado **después** de que la orden venció y ya no hay stock (queda "Sin stock: reembolsar") | Mercado Pago bloquea pagar un link vencido; solo se reproduce simulando datos. |
| Monto pagado distinto al total ("Revisar: monto distinto") | Requiere un pago con importe alterado. |
| Reembolsos y contracargos | Requieren operaciones reales en Mercado Pago. |
| Cobro duplicado de la misma compra | Requiere dos pagos aprobados sobre la misma preferencia. |
| Compras simultáneas masivas / bloqueos cruzados | Requiere pruebas automatizadas de carga. |
| Webhook de Mercado Pago configurado en producción | Es configuración del servidor. |

---

## 15. Matriz de cobertura

| Módulo | Camino feliz | Casos borde | Fallos | Concurrencia | Permisos |
|---|---|---|---|---|---|
| Pago Mercado Pago | PAG-01 | PAG-03, PAG-06 | PAG-02, PAG-04, PAG-05, PAG-07 | CON-01, CON-03 | SEG-01 |
| Stock por talle | STK-01, STK-04 | STK-06, STK-08, STK-09 | STK-02, STK-07 | STK-02, STK-03 | — |
| Volver con Atrás / vencimiento | ATR-01 | ATR-02, ATR-05, ATR-06 | ATR-03, ATR-04, ATR-07 | ATR-05 | — |
| Pagos en proceso | PEN-02 | PEN-01 | PEN-03 | — | — |
| Transferencia | TRF-01, TRF-03 | TRF-05 | TRF-04 | TRF-02 | SEG-04 |
| Admin Ventas / Despachos | ADM-01, ADM-04 | ADM-02, ADM-03 | ADM-05 | — | SEG-02 |
| Admin Productos | PRD-01 | PRD-03, PRD-05 | PRD-04 | PRD-02 | — |
| Carrito y pestañas | CON-06 | CON-02 | CON-05 | CON-03, CON-04, CON-07 | — |
| UX / a11y / dispositivos | UX-01 | UX-04, UX-05 | UX-06 | — | — |

---

## 16. Cierre de la sesión de pruebas
1. **Restaurar el stock** de "Prueba" a los valores iniciales (M = ___, L = ___) desde el panel admin, y restaurar el precio si se cambió.
2. **Avisar al responsable técnico** de las órdenes de prueba que quedaron pendientes o retenidas (por ejemplo, PEN-01), para liberarlas.
3. **Completar el resumen:**

| Resultado | Cantidad |
|---|---|
| ok | |
| fail | |
| no probado | |
| requiere dev | |

4. Reportar cada falla con la plantilla del Apéndice B, empezando por las de **pago y stock**.

**Criterio de salida sugerido:** no se aprueba el despliegue si falla cualquiera de PAG-01, PAG-02, STK-02, STK-03, ATR-03, PRD-02 o PRD-03, o si queda alguna falla sin explicación en un flujo de pago.

---

## Apéndice A — Verificación en base de datos (solo si tenés acceso de **solo lectura**)

> No ejecutes `INSERT`, `UPDATE`, `DELETE` ni cambios de estructura. Si el nombre de columna `name` no existe en tu base, pedí el correcto al responsable.

```sql
-- Ventas de prueba (últimas 6)
SELECT left(id::text, 8) AS id, payment_status, payment_method, quantity,
       mp_preference_id IS NOT NULL AS tiene_pref,
       mp_external_reference IS NOT NULL AS tiene_ref,
       mp_payment_id, oversold, review_reason, created_at
  FROM public.ventas
 WHERE product_name = 'Prueba'
 ORDER BY created_at DESC LIMIT 6;

-- Stock actual de Prueba (total y por talle)
SELECT stock, variants FROM public.productos WHERE name = 'Prueba';
```

Valores esperados tras un pago aprobado (PAG-01): `payment_status = pagado`, `tiene_pref` y `tiene_ref` en `true`, `mp_payment_id` con valor, `oversold = false`, `review_reason` vacío.

---

## Apéndice B — Plantilla para reportar una falla

```
ID del caso: (ej. ATR-03)
Resumen: (una línea)
Entorno: sitio / navegador y versión / dispositivo / usuario / hora
Pasos para reproducir:
  1.
  2.
  3.
Resultado obtenido:
Resultado esperado:
Evidencia: (captura, URL, ids de venta si los ves en el panel)
Stock antes / después:
Severidad: ☐ crítica (cobro doble, stock o dinero incorrecto) ☐ alta ☐ media ☐ baja
```
