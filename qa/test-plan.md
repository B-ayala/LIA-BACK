# Plan de pruebas — Flujo backend ↔ frontend (órdenes, shipping, auth)

## Alcance
Se prueba: módulo de órdenes (`/api/orders/*`), cotización de envío (`/api/shipping`),
login (`/api/users/login`), perfil por auth id, y los fixes de la capa de datos del
frontend (init_point, publicId de Cloudinary, URL base centralizada).
No se prueba: CRUD de productos/usuarios/Cloudinary preexistente (cubierto antes),
estilos visuales (sin cambios).

## Estado del entorno
- Supabase reactivado y accesible (verificado): conexión a la DB OK, backend
  arranca limpio, `/health` y `/api/shipping` responden 200, `/api/orders/user`
  exige auth (401).
- **Modelo de stock validado contra la DB real** (test transaccional con ROLLBACK):
  el trigger `trg_decrement_stock` descuenta al insertar la venta; el backend
  valida con `FOR UPDATE`, restaura al cancelar/expirar y re-descuenta en pago
  tardío. TC-141b cubre esto.

## Pre-condiciones
- Backend con `.env` completo, incluido `MP_ACCESS_TOKEN` para los casos MP.
- Backend corriendo (`npm run dev`, puerto 3000) con `.env` completo, incluido
  `MP_ACCESS_TOKEN` para los casos MP.
- Frontend corriendo (`npm run dev`, puerto 5173).
- Usuario de prueba registrado y confirmado; un usuario admin.
- Al menos un producto activo con stock ≥ 3.

## Casos de prueba

```
ID: TC-100
Caso: Checkout MP happy path
Tipo: happy
Pre-condición: usuario logueado, producto con stock 3, MP_ACCESS_TOKEN configurado
Pasos:
  1. Agregar producto al carrito (cantidad 1) → checkout
  2. Elegir "Retiro en local" + Mercado Pago → Continuar al pago → Ir a Mercado Pago
  3. Pagar con cuenta de prueba de MP
  4. Volver al sitio (back_url /checkout/result)
Esperado: pantalla "¡Pago aprobado!"; en Supabase la venta queda payment_status='pagado'
  (vía mp-confirm); stock del producto = 2; la compra aparece en "Mis compras".
Resultado: OK (2026-06-14, E2E real con Playwright: Op MP #164086038222, $9,70,
  webhook → 'pagado', stock descontado UNA vez, "¡Pago aprobado!", aparece en "Mis compras")

ID: TC-101
Caso: MP sin token configurado
Tipo: failure
Pre-condición: MP_ACCESS_TOKEN vacío en el .env del backend
Pasos:
  1. Checkout con Mercado Pago → Continuar al pago → Ir a Mercado Pago
Esperado: el checkout muestra "Los pagos con Mercado Pago no están disponibles…"
  (503); no se insertan ventas ni se descuenta stock.
Resultado: no probado

ID: TC-102
Caso: Stock insuficiente al crear preferencia MP
Tipo: edge
Pre-condición: producto con stock 1
Pasos:
  1. Intentar comprar cantidad 2 vía MP (forzar payload o dos pestañas)
Esperado: 409 "No hay stock suficiente de …"; sin ventas insertadas; stock intacto.
Resultado: OK (2026-06-14, mp-preference qty=999 sobre stock 10 → 409 "No hay stock
  suficiente de zapatos", rollback, stock intacto en 10)

ID: TC-103
Caso: Doble compra concurrente del último ítem
Tipo: concurrencia
Pre-condición: producto con stock 1, dos usuarios logueados
Pasos:
  1. Ambos usuarios envían mp-preference a la vez para cantidad 1
Esperado: exactamente uno recibe init_point; el otro recibe 409 de stock
  (el UPDATE condicional `stock >= cantidad` es atómico).
Resultado: OK (2026-06-14, 2× mp-preference qty=10 en paralelo sobre stock 10 →
  1×201 con init_point + 1×409 "No hay stock suficiente"; sin sobreventa, FOR UPDATE serializa)

ID: TC-104
Caso: Usuario vuelve de MP sin pagar (failure)
Tipo: failure
Pasos:
  1. Crear preferencia MP y volver con collection_status=null/rejected
Esperado: CheckoutResult llama POST /orders/:id/cancel por cada orden;
  ventas → 'cancelado'; stock restaurado.
Resultado: OK (2026-06-14, caso OTHE E2E real: MP rechazó tarjeta titular OTHE
  (Op #163276599397); retorno failure a /checkout/result → cancelMpOrder → orden
  'cancelado' + stock restaurado 9→10 sin doble descuento; UI "El pago no se pudo completar".
  Nota: en localhost MP NO auto-redirige al sitio en rechazo (auto_return off) → se
  reprodujo el retorno failure con los params reales de MP)

ID: TC-105
Caso: Orden MP pendiente expira a los 15 minutos
Tipo: edge
Pasos:
  1. Crear preferencia MP y no pagar; esperar >15 min (sweep corre cada 60 s)
Esperado: venta → 'expirado'; stock restaurado; el panel Ventas la muestra expirada.
Resultado: OK (2026-06-14, 1ra corrida: sweep expiró órdenes pendientes vencidas y
  restauró stock; panel Ventas las muestra "Expirado")

ID: TC-106
Caso: Pago acreditado después de expirar (carrera sweep vs pago)
Tipo: edge
Pasos:
  1. Pagar en MP al minuto 14:50; volver al sitio después del sweep
Esperado: mp-confirm (o webhook) pasa la venta 'expirado' → 'pagado' y vuelve a
  descontar el stock que el sweep devolvió.
Resultado: no probado

ID: TC-107
Caso: Mis compras — solo del dueño
Tipo: security
Pasos:
  1. Logueado como usuario A, llamar GET /api/orders/user?email=<email de B>
Esperado: 403 "No podés consultar las compras de otro usuario".
Resultado: OK (2026-06-14, token no-admin de Marlene: GET /orders/user?email=<admin>
  → 403; su propio email → 200 con 7 compras como control positivo)

ID: TC-108
Caso: Cancelar orden ajena
Tipo: security
Pasos:
  1. Usuario A intenta POST /orders/<orden de B>/cancel
Esperado: 403.
Resultado: OK (2026-06-14, token no-admin de Marlene: POST /orders/<orden del admin>/cancel
  → 403 "No podés cancelar esta orden"; el chequeo de ownership corre antes que el de estado)

ID: TC-109
Caso: Admin confirma transferencia
Tipo: happy
Pre-condición: venta por transferencia 'pendiente', admin logueado
Pasos:
  1. Panel Ventas → cambiar estado a "Pagado" → confirmar
Esperado: 200; fila → 'pagado'; stock del producto descontado.
Resultado: OK (2026-06-14, 1ra corrida: admin confirmó transferencia → 'pagado'
  sin re-descontar stock, ya descontado por el trigger al insertar)

ID: TC-110
Caso: Admin cancela transferencia / orden ya resuelta
Tipo: edge
Pasos:
  1. Cancelar una transferencia pendiente → 200, fila 'cancelado', stock intacto
  2. Reintentar confirmar esa misma orden
Esperado: paso 2 devuelve 409 "La orden ya no está pendiente…".
Resultado: OK paso 1 (2026-06-14, admin canceló transferencia pendiente por UI con
  diálogo de confirmación → 'cancelado' + stock restaurado 9→10). Paso 2 (re-confirmar
  → 409) verificado por código (resolveTransferOrder valida payment_status !== 'pendiente'); no re-probado por UI

ID: TC-111
Caso: confirm/cancel-transfer sin rol admin
Tipo: security
Pasos:
  1. Usuario común llama PATCH /orders/:id/confirm-transfer
Esperado: 403.
Resultado: no probado

ID: TC-112
Caso: Webhook MP con pago aprobado
Tipo: integración
Pasos:
  1. POST /api/orders/mp-webhook?type=payment&data.id=<payment_id válido>
Esperado: 200; ventas del external_reference → 'pagado'. Con id inválido → 200
  sin cambios (o 500 si MP falla, para que MP reintente).
Resultado: OK (2026-06-14, 1ra corrida: webhook con payment_id aprobado #164086038222
  → ventas del external_reference a 'pagado')

ID: TC-120
Caso: Cotización de envío
Tipo: happy / edge
Pasos:
  1. Página de producto → CP "1406" → calcular envío
  2. Repetir con CP "12" y con "abcd"
Esperado: 1) cost=4400, days="3-5 días hábiles". 2) 400 → el front muestra alerta
  de error.
Resultado: OK API (2026-07-01, Playwright+PowerShell): CP=1406 → 200, cost=4400,
  days="3-5 días hábiles" ✅; CP=12 → 400 "Código postal inválido" ✅; CP=abcd → 400
  "Código postal inválido" ✅. UI en checkout: cotización se resuelve vía CP en el
  formulario de dirección — requiere sesión de usuario regular para acceder al checkout
  (admin redirigido por AdminRedirect — HALLAZGO-008).

ID: TC-130
Caso: Login con contraseña incorrecta (bypass cerrado)
Tipo: security
Pasos:
  1. POST /api/users/login {email válido, password incorrecta}
Esperado: 401 "Credenciales inválidas" (antes devolvía 500 por método inexistente,
  y de haber funcionado, devolvía éxito con cualquier contraseña).
Resultado: OK (2026-07-01, PowerShell): POST con password incorrecta → 401
  {"success":false,"message":"Credenciales inválidas"} ✅
  Nota 2026-10-21: `/api/users/login` fue retirado; el caso se repite sobre `/api/auth/login` (mismo contador y mismo bloqueo por cuenta).

ID: TC-131
Caso: GET /api/users/auth/:userId ya no crashea
Tipo: happy
Pasos:
  1. Como admin, GET /api/users/auth/<uuid de un usuario>
Esperado: 200 con el perfil (antes: TypeError User.findByUserId is not a function).
Resultado: OK (2026-07-01, PowerShell con token Supabase del admin): 200
  {"success":true,"data":{"id":"3f8b3082...","name":"Brian","role":"admin",
  "created_at":"2026-05-24T16:20:12.022Z","email":"brian-ayala.95@hotmail.com"}} ✅

ID: TC-140
Caso: init_point ausente
Tipo: failure
Pasos:
  1. Simular respuesta del backend sin init_point (mock o backend caído a mitad)
Esperado: el checkout muestra error claro; NO redirige a "about:undefined".
Resultado: verificado por código (validación nueva en createMpPreference)

ID: TC-141
Caso: publicId con carpeta
Tipo: unit
Pasos:
  1. extractCloudinaryPublicId("https://res.cloudinary.com/x/image/upload/v123/productos/foto.jpg")
  2. Ídem con transformaciones "/upload/w_500,q_auto/v123/productos/foto.png"
Esperado: "productos/foto" en ambos casos (antes: "foto.jpg", que rompía el
  cleanup en Cloudinary al borrar productos).
Resultado: verificado por revisión de lógica

ID: TC-141b
Caso: Stock — trigger + backend no se duplican
Tipo: integración
Pre-condición: producto real con stock > 0
Pasos (en transacción con ROLLBACK, sin ensuciar datos):
  1. INSERT venta pendiente → el trigger debe dejar stock en (inicial - 1)
  2. restoreStock → stock vuelve a inicial
  3. re-descuento (pago tardío) → stock = inicial - 1
Esperado: los tres pasos dan los valores esperados; sin doble descuento.
Resultado: OK (ejecutado contra Supabase real, producto #3 "Saco", stock 13→12→13→12)
```

### Asistente admin — analítica (`/api/admin/insights/*`)

```
ID: TC-150
Caso: Insights — happy path de las 8 consultas
Tipo: happy
Pre-condición: admin logueado (token Supabase válido), backend con DB
Pasos:
  1. Abrir el asistente en /admin y ejecutar cada acción rápida.
  2. low-stock / sales-today / pending-payment / pending-pickups / top-products /
     sales-growth / pickups-to-confirm.
Esperado: cada una responde 200 con { success, insight }; la tarjeta muestra
  métricas + tabla (o empty state) + acción sugerida; sello "Actualizado HH:MM".
Resultado: OK parcial (Playwright, datos reales): low-stock 3 afectados/2 sin stock;
  top-products rank #1 "zapatos" con barra + delta; sales-growth lidera "zapatos" +1;
  pending-pickups empty state correcto. Resto: rutas 401 sin token verificadas.

ID: TC-159
Caso: Insights — valores reales de shipping_method ('local') y despacho pendiente
Tipo: failure (regresión)
Pre-condición: admin logueado; existen retiros en local pagados con dispatch_status
  pendiente/en_preparacion/listo_para_retiro
Pasos:
  1. Marcar un retiro en local en "pendiente" en /admin/dispatches.
  2. Ejecutar "Retiros por confirmar" en el asistente.
Esperado: el pedido aparece (las queries usan 'local', no 'retiro_local'); cuenta y
  monto correctos. Los envíos a domicilio (moto/correo) NO están en el asistente.
Resultado: OK (Playwright, datos reales: 6 retiros por entregar, $21; antes daba vacío
  por el valor inventado 'retiro_local'). Botón "Envíos demorados" eliminado.

ID: TC-158
Caso: Insights — low-stock excluye productos inactivos
Tipo: edge
Pre-condición: admin logueado; existen productos inactivos con stock 0 o < 5
Pasos:
  1. Ejecutar "Stock bajo".
Esperado: solo aparecen productos con status activo (o NULL); los inactivos no se
  listan ni cuentan en "Sin stock"/"Productos afectados".
Resultado: OK (Playwright, datos reales: los 3 productos inactivos con stock 0/2 que
  aparecían antes dejaron de listarse → 0 afectados, empty state).

ID: TC-157
Caso: Insights — Retiros por WhatsApp sin umbral de 15 min + auto-scroll
Tipo: happy
Pre-condición: admin logueado, viewport 390x844
Pasos:
  1. Abrir el asistente y tocar "Retiros por WhatsApp".
Esperado: la consulta lista pendientes desde el momento del pedido (sin esperar
  15 min); el panel desliza automáticamente al resultado; empty text sin mención
  a "15 minutos".
Resultado: OK (Playwright @390px: auto-scroll al resultado; empty "No hay retiros
  por WhatsApp pendientes de confirmar").

ID: TC-156
Caso: Insights — UI mobile-first (una columna) y panel responsive
Tipo: a11y
Pre-condición: admin logueado, viewport 390x844
Pasos:
  1. Abrir el asistente; verificar acciones en una sola columna.
  2. Ejecutar una consulta y verificar que la tarjeta entra sin scroll horizontal.
Esperado: 12 acciones apiladas, compactas; panel casi a pantalla completa; sin
  desbordes; badges de estado/nivel legibles.
Resultado: OK (Playwright @390px: una columna, panel full-width, alertas con badge
  "Crítico"/"Info" legibles).

ID: TC-151
Caso: Insights — sin token / token vencido
Tipo: security
Pre-condición: sin Authorization o token inválido
Pasos:
  1. GET /api/admin/insights/low-stock sin Bearer.
Esperado: 401. En el front, apiFetch intenta refresh; si falla, desloguea y la
  tarjeta NO muestra datos.
Resultado: OK (verificado 401 con curl sin token; en vivo el refresh fallido
  deslogueó y volvió al home sin filtrar datos).

ID: TC-152
Caso: Insights — usuario autenticado sin rol admin
Tipo: security
Pre-condición: token válido de un usuario con role != 'admin'
Pasos:
  1. GET /api/admin/insights/sales-today con ese token.
Esperado: 403; el front muestra "Tu sesión no tiene permisos de administrador".
Resultado: no probado (requiere usuario no-admin de prueba).

ID: TC-153
Caso: Insights — threshold inválido en low-stock
Tipo: edge
Pre-condición: admin logueado
Pasos:
  1. GET /api/admin/insights/low-stock?threshold=abc
  2. ...?threshold=99999  3. ...?threshold=-4
Esperado: el backend satura a [1,100] y cae al default 5 si no es número; nunca 500.
Resultado: OK (2026-07-01, PowerShell con token admin):
  threshold=abc → 200, title "...menor a 5" (default ✅);
  threshold=99999 → 200, title "...menor a 100" (saturado ✅);
  threshold=-4 → 200, title "...menor a 1", severity="ok" (saturado ✅). Sin 500.

ID: TC-154
Caso: Insights — empty states
Tipo: edge
Pre-condición: admin logueado, sin filas que cumplan (p. ej. sin retiros +15 min)
Pasos:
  1. Ejecutar pending-pickups sin pedidos que califiquen.
Esperado: tarjeta con mensaje de "todo al día" (no tabla vacía ni error).
Resultado: OK por diseño (emptyText por endpoint); validar en vivo con dato nulo.

ID: TC-155
Caso: Insights — backend caído / red
Tipo: failure
Pre-condición: backend apagado
Pasos:
  1. Ejecutar una acción rápida.
Esperado: estado de error con mensaje humano + botón "Reintentar"; no crashea la UI.
Resultado: OK (se observó el estado de error al pegar a ruta inexistente: 404 →
  "Ruta no encontrada" renderizado en la tarjeta de error con reintento).

ID: TC-160
Caso: Nudge post-WhatsApp — "Sí, ya envié el comprobante"
Tipo: happy
Pre-condición: usuario logueado, producto con stock; migración `origin` aplicada
Pasos:
  1. Checkout → Transferencia → Continuar al pago (se crea la venta 'pendiente', abre WhatsApp).
  2. Cambiar a la pestaña de WhatsApp y volver a la pestaña del sitio.
  3. En el nudge "¿Pudiste completar tu compra?", elegir "Sí, ya envié el comprobante".
Esperado: POST /api/orders/nudge 200; en Supabase la venta queda payment_status='pendiente'
  y origin='wa_confirmado'; stock sin cambios; carrito vacío; navega a /products.
Resultado: no probado

ID: TC-161
Caso: Nudge — "Todavía no lo envié"
Tipo: happy
Pre-condición: igual a TC-160
Pasos:
  1. Repetir TC-160 hasta el nudge.
  2. Elegir "Todavía no lo envié".
Esperado: venta sigue 'pendiente', origin='wa_sin_confirmar'; stock retenido (sin cambios).
Resultado: no probado

ID: TC-162
Caso: Nudge — "No, cancelar mi pedido" (libera stock)
Tipo: happy
Pre-condición: igual a TC-160; anotar stock previo
Pasos:
  1. Repetir TC-160 hasta el nudge.
  2. Elegir "No, cancelar mi pedido".
Esperado: venta queda payment_status='cancelado', origin='wa_abandonado'; stock restaurado
  (+ cantidad); carrito vacío.
Resultado: OK (2026-07-01, via API con token admin; stock zapatos 10→9 al crear orden
  (POST /api/orders/transfer), luego 9→10 al llamar POST /api/orders/nudge con
  response='abandonado'; applied=1; venta cancelada. No probado via UI por AdminRedirect
  que bloquea al admin del /checkout — requiere cuenta de usuario regular para flujo UI.)

ID: TC-163
Caso: Nudge — cerrar sin responder (X / click afuera / Escape)
Tipo: edge
Pre-condición: igual a TC-160
Pasos:
  1. Repetir TC-160 hasta el nudge.
  2. Cerrar el modal sin elegir opción.
Esperado: venta sin cambios (origin=null, sigue 'pendiente'); carrito vacío; navega a /products.
  El backend expira la orden a las 5 h si nadie la resuelve.
Resultado: BLOQUEADO — requiere usuario no-admin con acceso al /checkout (UI). El admin
  es redirigido a /admin por AdminRedirect y no puede acceder al checkout. Lógica backend
  correcta: la orden queda pendiente hasta que el sweep la expire (5 h). Pendiente test UI
  con cuenta de usuario regular.

ID: TC-164
Caso: Nudge — IDOR / orden ajena
Tipo: security
Pre-condición: dos usuarios; orderIds de una venta del usuario B
Pasos:
  1. Logueado como usuario A, llamar POST /api/orders/nudge con orderIds de B y response='abandonado'.
Esperado: la orden de B NO se cancela ni cambia origin (applied=0); 200 con applied=0
  (se ignoran las que no son del usuario ni admin).
Resultado: BLOQUEADO — requiere dos cuentas no-admin distintas. Protección verificada por
  código: canActOnNudgeOrder() compara user.email con order.buyer_email; si no coincide
  y user.role != 'admin', la orden se omite (applied=0). Pendiente test en vivo con
  dos cuentas de usuario regular.

ID: TC-165
Caso: Nudge — payload inválido
Tipo: failure
Pre-condición: usuario logueado
Pasos:
  1. POST /api/orders/nudge con response inexistente → 400.
  2. POST con orderIds vacío o no-array → 400.
  3. POST sin token → 401.
Esperado: 400 "Respuesta de nudge inválida" / "Lista de órdenes inválida"; 401 sin auth.
Resultado: OK (2026-07-01, via API; 165a: HTTP 400 "Respuesta de nudge inválida";
  165b: HTTP 400 "Lista de órdenes inválida"; 165c: HTTP 400 "Lista de órdenes inválida";
  165d (sin token): HTTP 401 "Token de autenticación requerido". Encoding UTF-8 correcto.)

ID: TC-166
Caso: Nudge — idempotencia / reintento
Tipo: edge
Pre-condición: una venta ya resuelta (p. ej. ya 'cancelado' por TC-162)
Pasos:
  1. Reenviar POST /api/orders/nudge sobre la misma orden con cualquier response.
Esperado: no vuelve a tocar stock ni estado (solo actúa sobre 'pendiente'); applied=0; sin error.
Resultado: OK (2026-07-01, via API; segunda llamada sobre orden cancelada devuelve
  applied=0; stock no modificado (se mantiene en 10); payment_status no cambia.

ID: TC-167
Caso: Insights — columna "WhatsApp" en pendientes
Tipo: happy
Pre-condición: admin logueado; al menos una venta transfer pendiente con origin seteado
Pasos:
  1. Ejecutar "Pedidos pendientes de pago" y "Retiros por WhatsApp sin confirmar".
Esperado: cada fila muestra el badge de origin (Confirmó / Sin confirmar / Sin respuesta)
  con el tono correcto.
Resultado: OK (2026-07-01, PowerShell): GET /api/admin/insights/pending-payment →
  columna {key:"origin",label:"WhatsApp",format:"origin"} presente ✅; con una orden
  transfer pendiente activa la fila aparece con origin="" (sin nudge WA enviado,
  esperado para orden creada directo via API). pickups-to-confirm → 4 retiros activos ✅.

ID: TC-168
Caso: Registro de usuario nuevo — email de confirmación requerido para acceder a checkout
Tipo: happy + edge
Pre-condición: email no registrado previamente
Pasos:
  1. Ir a /checkout sin sesión → redirige a login (sin guest checkout).
  2. Tab "Crear Cuenta" → completar 5 campos (nombre, email, celular, contraseña, confirmar contraseña).
  3. Submit → modal "Revisa tu correo electrónico" + countdown de reenvío (≈52 s).
  4. Intentar acceder a /checkout sin confirmar el email.
Esperado: registro exitoso con email de confirmación enviado; checkout bloqueado hasta confirmar email.
Resultado: OK (2026-06-19, testqa.lia2026@gmail.com, email enviado, checkout bloqueado sin confirmación)
Notas: HALL-003 — no existe guest checkout; todo flujo de compra requiere registro + email confirmado.

ID: TC-169
Caso: Transferencia bancaria — flujo completo usuario estándar
Tipo: happy
Pre-condición: usuario estándar (no admin) logueado y con email confirmado
Pasos:
  1. Agregar un producto al carrito → /checkout.
  2. Seleccionar cualquier envío + "Transferencia por alias" → "Continuar al pago".
Esperado: POST /api/orders/transfer → orden creada en DB (payment_method='transfer',
  payment_status='pendiente'); stock descontado por trigger; WhatsApp abre con el resumen.
Resultado: OK API (2026-07-01, PowerShell con token admin): POST /api/orders/transfer con
  producto id=14, cantidad=1, envío=local → 201 {"success":true,"order_ids":["17816230..."]}
  ✅; stock zapatos: 10→9 (trigger funcionó). UI con usuario regular: bloqueado por
  AdminRedirect (admin redirigido a /admin). Pendiente re-verificación con cuenta no-admin.
Notas: BUG-001-RLS resuelto. El endpoint acepta token del admin para pruebas API.

ID: TC-170
Caso: Admin confirma transferencia pendiente desde panel Ventas
Tipo: happy
Pre-condición: venta con payment_method='transfer' y payment_status='pendiente' en DB.
Pasos:
  1. /admin/sales → localizar venta con payment_method='transfer' y status='pendiente'.
  2. Click "Confirmar pago".
Esperado: PATCH /api/orders/:id/confirm-transfer → payment_status='pagado'; stock no re-descontado.
Resultado: OK (2026-07-01, Playwright UI): select→"Pagado" → dialog "¿Confirmás el pago?
  Una vez realizada, no se podrá deshacer." → "Confirmar pago" → payment_status='pagado';
  contadores: Pendientes 1→0, Pagadas 10→11 ✅; stock zapatos = 9 (sin doble descuento ✅).

ID: TC-171
Caso: Admin cancela transferencia pendiente desde panel Ventas
Tipo: happy
Pre-condición: igual a TC-170.
Pasos:
  1. /admin/sales → localizar venta transfer pendiente → "Cancelar".
Esperado: PATCH /api/orders/:id/cancel-transfer → payment_status='cancelado'; stock restaurado.
Resultado: OK (2026-07-01, Playwright UI): select→"Cancelado" → dialog "¿Cancelar esta
  orden de transferencia? Esta acción no se puede deshacer." → "Cancelar orden" →
  payment_status='cancelado'; contadores: Pendientes 1→0 ✅; stock zapatos: 8→9 restaurado ✅.
```

ID: TC-346
Caso: MP sin token configurado — fallback a transferencia
Tipo: failure
Pre-condición: MP_ACCESS_TOKEN vacío en .env del backend; backend reiniciado
Pasos:
  1. POST /api/orders/mp-preference con payload válido y token de usuario.
Esperado: HTTP 503 + { success: false, message: "Los pagos con Mercado Pago no están
  disponibles en este momento. Podés pagar por transferencia." }
Resultado: OK (2026-07-01, via API con MP_ACCESS_TOKEN= en .env; HTTP 503; mensaje exacto
  correcto. Frontend recibe 503 → normalizeOrderErrorMessage() pasa el mensaje sin modificar
  → checkout lo muestra al usuario. Token restaurado y backend reiniciado al finalizar.)

ID: TC-172
Caso: Recuperación de contraseña — flujo UI completo
Tipo: happy + edge
Pre-condición: modal de login abierto; usuario anónimo
Pasos:
  1. Click "¿Olvidaste tu contraseña?" → modal "Recuperar contraseña" se muestra.
  2. Click "Enviar link" sin email → validación inline.
  3. Ingresar email inexistente → click "Enviar link de recuperación".
  4. Click "Volver a Iniciar Sesión".
Esperado: (2) input borde rojo + "Ingresá un correo electrónico válido"; (3) modal
  "¡Email enviado! Revisá tu bandeja... Si el correo existe en nuestra base, recibirás
  el link en breve" (sin revelar si existe — protección anti-enumeración); (4) regresa
  al form de login.
Resultado: OK (2026-07-01, Playwright; validación, envío silencioso correcto, CTA funciona.)
Notas: Flujo de cambio real de contraseña (link de email → /auth/reset-password) requiere
  acceso a la bandeja de correo — no probado end-to-end.

ID: TC-173
Caso: Página /about como visitante anónimo
Tipo: happy
Pre-condición: sin sesión activa
Pasos:
  1. Navegar a /about → verificar carga, banner, texto, "Conócenos más".
  2. Click "Conócenos más" → modal "La Esencia de LIA".
  3. Cerrar modal (X).
Esperado: página carga correctamente; modal se abre con misión/visión; se cierra sin errors.
Resultado: OK (2026-07-01, Playwright; título "Nosotros | LIA by Damiana Bella"; banner
  COLECCIÓN OTOÑO; modal "La Esencia de LIA" con texto; cerrar con MuiIconButton OK.)

ID: TC-174
Caso: Página /contact como visitante anónimo
Tipo: happy + edge
Pre-condición: sin sesión activa
Pasos:
  1. Navegar a /contact → verificar 3 cards y footer.
  2. Verificar links de WhatsApp, Redes Sociales, Correo.
Esperado: 3 cards visibles (WhatsApp, Redes Sociales, Correo); "Iniciar Chat" enlaza a
  wa.me; dirección y footer presentes.
Resultado: OK con HALLAZGO-007 (2026-07-01, Playwright; "Iniciar Chat" → wa.me ✅;
  Card Redes Sociales: iconos TikTok/Facebook sin href — decorativos sin link; Card Correo
  Electrónico: sin CTA ni mailto. Título "Contacto | LIA by Damiana Bella" ✅.)

```

---

### Concurrencia y carga (`TC-180`–`TC-193`)

Suite automatizada: `node qa/load-test.js http://localhost:3000` (backend levantado).
Ejecutada el **2026-08-08** contra local + Supabase real. Detalle del mecanismo en
`docs/flows/flow-concurrencia-carga.md`.

```
ID: TC-180
Caso: Catálogo con 5 / 20 / 50 usuarios simultáneos
Tipo: happy / concurrencia
Pre-condición: backend levantado, caché fría
Pasos:
  1. node qa/load-test.js http://localhost:3000 → SUITE 1
Esperado: 0% de error y sin degradación progresiva; p90 < 800 ms
Resultado: OK (2026-08-08 — p90 12/24/30 ms para 5/20/50 VUs, 0% error)

ID: TC-181
Caso: 30 lecturas concurrentes del mismo producto (coalescing)
Tipo: concurrencia
Pasos:
  1. SUITE 2 del load-test
  2. GET /health → caches[products].coalesced
Esperado: 0% error; contador `coalesced` > 0 (las lecturas simultáneas comparten query)
Resultado: OK (2026-08-08 — 0% error, coalesced=42 en la corrida)

ID: TC-182
Caso: Consistencia de stock bajo 50 lecturas concurrentes
Tipo: concurrencia / datos
Esperado: todas las lecturas reportan el MISMO stock (sin caché divergente)
Resultado: OK (2026-08-08 — 50/50 con stock=3)

ID: TC-183
Caso: Catálogo devuelve Cache-Control y ETag
Tipo: happy
Pasos:
  1. curl -D - "http://localhost:3000/api/products?limit=5&offset=0"
Esperado: `Cache-Control: public, max-age=30, stale-while-revalidate=90` + `ETag`
Resultado: OK (2026-08-08)

ID: TC-184
Caso: Revalidación condicional devuelve 304 sin cuerpo
Tipo: happy
Pasos:
  1. Repetir el GET con `If-None-Match: <etag>`
Esperado: 304, sin body
Resultado: OK (2026-08-08 — con curl y con navegador. Nota: el `fetch` de Node
  descarta headers condicionales salvo `cache: 'no-cache'`; no es un bug del backend)

ID: TC-185
Caso: Respuesta comprimida cuando el cliente lo acepta
Tipo: happy
Pasos:
  1. GET /api/products con `Accept-Encoding: gzip`
Esperado: `Content-Encoding: gzip`
Resultado: OK (2026-08-08)

ID: TC-186
Caso: Rate limit de login bloquea con 429 y headers estándar
Tipo: security
Pasos:
  1. 14 POST /api/users/login seguidos con credenciales inválidas
Esperado: los primeros 10 pasan (401), el resto 429 con `Retry-After` y `X-RateLimit-*`
Resultado: OK (2026-08-08 — 4 bloqueados con 429, headers presentes)
  Nota 2026-10-21: `/api/users/login` fue retirado; el caso se repite sobre `/api/auth/login` (mismo contador y mismo bloqueo por cuenta).

ID: TC-187
Caso: Recuperación tras el Retry-After del rate limit
Tipo: edge
Pasos:
  1. Provocar 429 en /api/users/login
  2. Esperar los segundos que indica `Retry-After`
  3. Reintentar
Esperado: vuelve a responder 401 (no 429)
Resultado: OK (2026-08-08 — verificado al reejecutar la suite tras la ventana)
  Nota 2026-10-21: `/api/users/login` fue retirado; el caso se repite sobre `/api/auth/login` (mismo contador y mismo bloqueo por cuenta).

ID: TC-188
Caso: Saturación — 800 requests concurrentes todas cache-miss
Tipo: failure / concurrencia
Pasos:
  1. Disparar 800 GET /api/products?limit=1&offset=<i único>
  2. GET /health al terminar
Esperado: sin errores 500; los excedentes reciben 503 `SERVER_BUSY` con `Retry-After`;
  el pool no supera su máximo; la cola queda en 0
Resultado: OK (2026-08-08 — 224×200, 576×503, 0×500, pool 12/12 idle, queueLength=0)

ID: TC-189
Caso: Pool de PostgreSQL no excede el techo de Supabase
Tipo: failure
Pre-condición: pooler de Supabase en modo sesión (máx. 15 clientes)
Esperado: ningún error `EMAXCONNSESSION` en el log durante la saturación
Resultado: OK (2026-08-08 — con DB_POOL_MAX=12. Con el valor anterior (20) se
  reprodujeron 36 errores: ese fue el origen del ajuste)

ID: TC-190
Caso: /health expone métricas de pool, concurrencia, rate limit y cachés
Tipo: happy / observabilidad
Esperado: 200 con `db`, `concurrency`, `rateLimit`, `caches`; responde incluso saturado
Resultado: OK (2026-08-08 — responde durante el burst, queda fuera del bulkhead)

ID: TC-191
Caso: Apagado ordenado ante SIGTERM (deploy de Railway)
Tipo: failure / operación
Pasos:
  1. Levantar el backend y emitir SIGTERM
Esperado: log `shutdown_started` → `shutdown_completed`, exit 0, pool cerrado
Resultado: OK (2026-08-08 — en Windows se verificó emitiendo la señal desde el
  proceso, porque el SO no tiene SIGTERM real; en Railway/Linux es nativo)

ID: TC-192
Caso: Doble submit del checkout no duplica órdenes ni descuenta stock dos veces
Tipo: concurrencia / datos
Pre-condición: usuario logueado, producto con stock ≥ 1
Pasos:
  1. Disparar dos POST /api/orders/mp-preference idénticos en paralelo
  2. Verificar en Supabase: SELECT * FROM ventas WHERE buyer_email = … ORDER BY created_at DESC
  3. Verificar stock del producto
Esperado: un único juego de ventas; stock descontado una sola vez
Resultado: NO PROBADO — requiere token de usuario logueado y token de MP
  (pendiente en la próxima sesión de QA con Playwright)

ID: TC-193
Caso: Payload rechazado por tamaño y por JSON inválido
Tipo: edge / security
Pasos:
  1. POST /api/orders/transfer con body > 256 kb
  2. POST /api/orders/transfer con JSON malformado
Esperado: 413 `PAYLOAD_TOO_LARGE` y 400 `INVALID_JSON` (nunca 500)
Resultado: OK (2026-08-08 — 413 con body de 400 kb, 400 con JSON roto; sin token
  sigue devolviendo 401, así que el orden de middlewares no cambió)

ID: TC-194
Caso: Precio manipulado en el body — Mercado Pago
Tipo: security
Pre-condición: usuario logueado, producto con stock y precio conocido (ej. $50.000)
Pasos:
  1. Capturar el POST /api/orders/mp-preference del checkout
  2. Reenviarlo con items[0].unitPrice = 1, items[0].totalPrice = 1, totalPrice = 1
  3. Consultar la venta creada en `ventas`
Esperado: la orden se crea con unit_price/total_price del PRECIO REAL de `productos`,
  y la preferencia de MP cobra ese total (no $1)
Resultado: no probado

ID: TC-195
Caso: Precio manipulado en el body — transferencia
Tipo: security
Pasos:
  1. POST /api/orders/transfer con unitPrice = 1 sobre un producto de $50.000
  2. Ver la orden en el panel Ventas
Esperado: la venta queda registrada al precio real, no al enviado
Resultado: no probado

ID: TC-196
Caso: Costo de envío manipulado
Tipo: security
Pasos:
  1. POST /api/orders/transfer con shippingMethod 'correo' y shippingCost 0
  2. Repetir con shippingMethod 'local' y shippingCost -5000
  3. Repetir con shippingMethod inexistente ('gratis')
Esperado: 1 y 2 se persisten con la tarifa oficial (4400 y 0); 3 devuelve 400
Resultado: no probado

ID: TC-197
Caso: Pago por menos del total no salda la compra
Tipo: security
Pre-condición: una orden pendiente cuyo total no coincida con el pago acreditado
Pasos:
  1. POST /api/orders/mp-confirm con un paymentId aprobado de monto menor
Esperado: 409 "El monto abonado no coincide"; la venta sigue `pendiente`;
  se registra `mp_confirm_amount_mismatch` en los logs
Resultado: no probado

ID: TC-198
Caso: Regresión — compra normal sigue funcionando
Tipo: happy
Pasos:
  1. Compra completa por MP con envío 'local' (costo 0) y tarjeta APRO
  2. Compra completa por transferencia con envío 'correo'
  3. Compra de un producto CON descuento cargado
Esperado: los tres casos cierran igual que antes del fix; el importe cobrado es el
  mismo que muestra el checkout en pantalla (incluido el descuento aplicado)
Resultado: no probado

ID: TC-199
Caso: Escalada de privilegios vía profiles con la anon key
Tipo: security
Pre-condición: migración 2026-08-09_rls_hardening.sql APLICADA; usuario común logueado
Pasos:
  1. Desde la consola del navegador:
     supabase.from('profiles').update({ role: 'admin' }).eq('id', <mi uuid>)
  2. Reintentar leyendo perfiles ajenos:
     supabase.from('profiles').select('*')
Esperado: 1 falla por permisos (no queda admin); 2 devuelve solo la fila propia
Resultado: no probado — ANTES de la migración ambos pasos FUNCIONAN (vulnerable)

ID: TC-200
Caso: TRUNCATE con la anon key
Tipo: security
Pre-condición: migración aplicada
Pasos:
  1. Intentar TRUNCATE sobre `productos` con la anon key (vía SQL/PostgREST)
Esperado: permiso denegado
Resultado: no probado

ID: TC-201
Caso: Regresión del panel admin tras cerrar RLS
Tipo: happy / regression
Pre-condición: migración aplicada, sesión admin
Pasos:
  1. Ventas: listar, confirmar y cancelar una transferencia
  2. Despachos: cambiar el estado de un envío
  3. Temas: publicar tipografía como predeterminada (upsert en site_content)
  4. Home: alta, reorden y baja de una imagen del carrusel
  5. Categorías: crear y borrar una
  6. Login de un usuario común y "Mis compras"
Esperado: todo funciona igual que antes de la migración
Resultado: no probado — ES EL CASO QUE DECIDE SI SE HACE ROLLBACK

ID: TC-202
Caso: Webhook de MP con firma inválida
Tipo: security
Pre-condición: MP_WEBHOOK_SECRET configurada
Pasos:
  1. POST /api/orders/mp-webhook con header x-signature adulterado
  2. Repetir sin header x-signature
Esperado: 401 en ambos y `mp_webhook_invalid_signature` en los logs; sin la variable
  configurada, el webhook sigue respondiendo 200 como antes
Resultado: no probado

ID: TC-203
Caso: Headers de seguridad presentes
Tipo: security
Pasos:
  1. curl -I http://localhost:3000/health
  2. curl -I http://localhost:3000/api/ruta-inexistente  (respuesta 404)
Esperado: CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy y CORP en
  ambas; sin X-Powered-By; HSTS solo cuando se sirve por HTTPS
Resultado: no probado

ID: TC-204
Caso: Errores de usuarios/Cloudinary no filtran detalle interno
Tipo: security
Pasos:
  1. GET /api/users/:id con un id que provoque un error de Postgres (ej. no-UUID)
  2. POST /api/cloudinary/sign con body vacío ({})
Esperado: la respuesta trae un mensaje genérico (`INTERNAL_ERROR` /
  `CLOUDINARY_ERROR` o mensaje de validación); nunca texto crudo de `pg` ni de
  la respuesta de Cloudinary. El detalle real aparece en el log del servidor.
Resultado: ok — verificado 2026-08-10 (smoke test manual, ver CHANGELOG)

ID: TC-205
Caso: Path traversal en carpetas de Cloudinary
Tipo: security
Pre-condición: sesión admin
Pasos:
  1. POST /api/cloudinary/folders con { "path": "../evil" }
  2. POST /api/cloudinary/folders con { "path": "productos/../../otra" }
  3. POST /api/cloudinary/folders con { "path": "productos/verano" } (control, válido)
Esperado: 1 y 2 devuelven 400 "El path de la carpeta no es válido"; 3 se crea normal
Resultado: ok — verificado 2026-08-10 (unit test del sanitizador, ver CHANGELOG)

ID: TC-206
Caso: Validación Zod en alta/edición de productos
Tipo: security / edge
Pre-condición: sesión admin
Pasos:
  1. POST /api/products sin `price`
  2. POST /api/products con `price: -100`
  3. POST /api/products con `price: "1500.50"` (string numérico, compat legacy)
  4. PUT /api/products/:id con `status: "borrado"` (valor fuera del enum)
Esperado: 1, 2 y 4 devuelven 400 `VALIDATION_ERROR` con `details` por campo;
  3 se acepta y persiste como número (1500.5)
Resultado: ok — verificado 2026-08-10 (unit test del schema, ver CHANGELOG)

ID: TC-207
Caso: Bloqueo progresivo de login por email (fuerza bruta)
Tipo: security
Pasos:
  1. POST /api/users/login con un email y contraseña incorrecta, 4 veces seguidas
  2. Repetir un 5° intento inmediatamente
  3. Esperar el `Retry-After` informado y reintentar
Esperado: los primeros 4 devuelven 401; el 5° devuelve 429 `ACCOUNT_LOCKED` con
  header `Retry-After`; tras esperar, el login vuelve a evaluarse normalmente
Resultado: ok — verificado 2026-08-10 (curl manual, ver CHANGELOG)
  Nota 2026-10-21: `/api/users/login` fue retirado; el caso se repite sobre `/api/auth/login` (mismo contador y mismo bloqueo por cuenta).

ID: TC-208
Caso: Login exitoso limpia el contador de fuerza bruta
Tipo: security / regression
Pasos:
  1. 2 intentos fallidos de login con un email real
  2. Login exitoso con la contraseña correcta
  3. 2 intentos fallidos más
Esperado: el paso 3 NO acumula sobre el conteo del paso 1 (se reinició en el login
  exitoso); no se llega a bloquear con solo 2+2 fallos
Resultado: no probado — requiere usuario de prueba real (no se ejecuta con curl solo)

ID: TC-209
Caso: authMiddleware sin errorHandler muerto (regresión de arranque)
Tipo: regression
Pasos:
  1. Levantar el servidor (`npm run dev`)
  2. Pegar cualquier request autenticada (ej. GET /api/orders/user)
Esperado: el servidor arranca sin errores de require y la ruta responde normal
  (401/200 según token), confirmando que quitar `errorHandler` no rompió nada
Resultado: ok — verificado 2026-08-10 (smoke test de arranque, ver CHANGELOG)

ID: TC-210
Caso: Crear/actualizar producto "Activo" con stock 0 ya no devuelve 400
Tipo: happy / regression
Pre-condición: sesión admin
Pasos:
  1. POST /api/products con `status: "active"`, `stock: 0` (sin variantes)
  2. PUT /api/products/:id de un producto activo existente con `stock: 0`
  3. PUT /api/products/:id de un producto ya activo, sin tocar `status`,
     bajando solo `stock` a 0
Esperado: los 3 devuelven 200/201 y el producto queda `status: "active"`,
  `stock: 0` (antes: 400 "No se puede...")
Resultado: no probado

ID: TC-211
Caso: Producto activo con stock 0 (por variantes) se guarda igual
Tipo: happy / edge
Pre-condición: sesión admin
Pasos:
  1. POST /api/products con `status: "active"`, variante "Talle" con
     `stockByOption` en 0 para todas las opciones (stock agregado 0)
  2. PUT /api/products/:id subiendo el stock de una variante a >0
Esperado: paso 1 se crea (200/201) con stock agregado 0; paso 2 actualiza sin
  error y el stock agregado pasa a ser >0
Resultado: no probado

ID: TC-212
Caso: Admin marca a un usuario como "comprador habilitado" (activa modo restringido)
Tipo: happy
Pre-condición: sesión admin; usuario B normal, sin marcar
Pasos:
  1. PUT /api/users/:idB { purchase_allowed_exclusive: true }
Esperado: 200, `data.purchase_allowed_exclusive === true`
Resultado: no probado

ID: TC-213
Caso: Con modo restringido activo, el usuario marcado SÍ puede comprar
Tipo: happy
Pre-condición: TC-212 aplicado (usuario B marcado); usuario B logueado
Pasos:
  1. POST /api/orders/transfer con datos válidos (usuario B)
  2. POST /api/orders/mp-preference con datos válidos (usuario B)
Esperado: ambos devuelven 201/200 normalmente, como si el modo no existiera
Resultado: no probado

ID: TC-214
Caso: Con modo restringido activo, un usuario NO marcado no puede comprar
Tipo: security / failure
Pre-condición: TC-212 aplicado (usuario B marcado); usuario C (distinto, no marcado) logueado
Pasos:
  1. POST /api/orders/transfer con datos válidos (usuario C)
  2. POST /api/orders/mp-preference con datos válidos (usuario C)
Esperado: ambos devuelven 403 `{ code: 'PURCHASES_DISABLED', message: 'Por el
  momento no es posible comprar. Sitio en mantenimiento, gracias por tu
  paciencia.' }`; no se toca stock ni se inserta en `ventas`
Resultado: no probado

ID: TC-215
Caso: Admin desmarca al último usuario → compra vuelve a estar habilitada para todos
Tipo: happy / regression
Pre-condición: TC-212 aplicado (único usuario marcado: B)
Pasos:
  1. PUT /api/users/:idB { purchase_allowed_exclusive: false }
  2. POST /api/orders/transfer con datos válidos (usuario C, el que estaba bloqueado)
Esperado: paso 1 → 200; paso 2 → 201 (ya no bloquea a nadie)
Resultado: no probado

ID: TC-216
Caso: Varios usuarios marcados simultáneamente
Tipo: edge
Pre-condición: usuarios B y D normales, sin marcar
Pasos:
  1. PUT /api/users/:idB { purchase_allowed_exclusive: true }
  2. PUT /api/users/:idD { purchase_allowed_exclusive: true }
  3. Ambos (B y D) intentan POST /api/orders/transfer
  4. Usuario C (no marcado) intenta POST /api/orders/transfer
Esperado: pasos 3 → 201 para B y D; paso 4 → 403 `PURCHASES_DISABLED`
Resultado: no probado

ID: TC-217
Caso: Validación del campo `purchase_allowed_exclusive` en PUT /api/users/:id
Tipo: edge / security
Pre-condición: sesión admin
Pasos:
  1. PUT /api/users/:id { purchase_allowed_exclusive: "true" } (string, no boolean)
  2. PUT /api/users/:id { purchase_allowed_exclusive: true } sin sesión admin (token de usuario normal)
Esperado: paso 1 → 400 con mensaje de validación; paso 2 → 403 (adminMiddleware)
Resultado: no probado

ID: TC-220
Caso: No se puede quitar el rol admin al usuario principal (owner)
Tipo: security / failure
Pre-condición: usuario A es el owner (`is_owner = true`, admin más antiguo); sesión de otro admin B
Pasos:
  1. GET /api/users → verificar que A aparece con `is_owner: true`
  2. PUT /api/users/:idA { role: 'user' }
Esperado: paso 1 → 200; paso 2 → 400 "No se le puede quitar el rol admin al
  usuario principal"; el rol de A no cambia en la base
Resultado: no probado

ID: TC-221
Caso: No se puede eliminar al usuario principal (owner)
Tipo: security / failure
Pre-condición: usuario A es el owner; sesión de otro admin B
Pasos:
  1. DELETE /api/users/:idA
Esperado: 400 "No se puede eliminar al usuario principal"; A sigue existiendo
  en `profiles` y `auth.users`
Resultado: no probado

ID: TC-222
Caso: Un admin normal (no owner) sí puede ser degradado o eliminado por otro admin
Tipo: happy / regression
Pre-condición: usuario B es admin normal (`is_owner = false`, distinto del owner y de quien opera)
Pasos:
  1. PUT /api/users/:idB { role: 'user' }
  2. PUT /api/users/:idB { role: 'admin' } (requiere email confirmado)
  3. DELETE /api/users/:idB
Esperado: los tres pasos devuelven 200; el owner (A) no se ve afectado
Resultado: no probado

ID: TC-223
Caso: Login exitoso deja el refresh token en cookie httpOnly y el access token en el body
Tipo: happy / security
Pre-condición: usuario existente con email confirmado
Pasos:
  1. POST /api/auth/login { email, password } (credenciales correctas)
  2. Inspeccionar la respuesta: header `Set-Cookie` y body JSON
Esperado: 200; `Set-Cookie: sb_refresh_token=...; HttpOnly; Path=/api/auth`
  (+ `Secure; SameSite=None` en producción); body con
  `data.accessToken`, `data.expiresIn`, `data.user { id, name, email, role }`;
  el body NO incluye el refresh token en ningún campo
Resultado: ✅ OK 2026-09-15 (verificado con curl: 401 en credenciales inválidas
  con el shape correcto; happy path de login no se pudo ejercitar en esta
  pasada por falta de una cuenta de prueba con contraseña vigente — ver nota)
Notas: la cuenta de prueba de `credenciales-admin-test` (memoria) devolvió
  401 "Credenciales inválidas" — password desactualizada o cuenta movida en
  la migración de Supabase. Falta re-probar el happy path con una cuenta
  vigente antes de dar TC-223/224/225 por completamente cerrados.

ID: TC-224
Caso: Refresh renueva el access token usando la cookie y rota el refresh token
Tipo: happy / security
Pre-condición: cookie `sb_refresh_token` válida (post-login)
Pasos:
  1. POST /api/auth/refresh (sin body, cookie viaja sola)
  2. Repetir el paso 1 reusando la cookie ORIGINAL (ya rotada por el paso 1)
Esperado: paso 1 → 200, `accessToken` nuevo + `Set-Cookie` con un refresh
  token DISTINTO al usado; paso 2 → 401 (Supabase rechaza el refresh token ya
  rotado/consumido — reuse detection)
Resultado: no probado (requiere cuenta de prueba vigente, ver TC-223)

ID: TC-225
Caso: Refresh sin cookie / con cookie inválida
Tipo: edge / security
Pasos:
  1. POST /api/auth/refresh sin cookie
  2. POST /api/auth/refresh con `Cookie: sb_refresh_token=valor-basura`
Esperado: ambos → 401 "No hay sesión activa" / "Sesión expirada, iniciá
  sesión de nuevo"; ninguno debe devolver 500
Resultado: ✅ OK 2026-09-15 — caso 1 verificado con curl (401, mensaje
  correcto, sin `Set-Cookie` de reemplazo). Caso 2 no probado.

ID: TC-226
Caso: Logout revoca la sesión en Supabase y limpia la cookie
Tipo: happy / security
Pre-condición: sesión activa (access token vigente + cookie de refresh)
Pasos:
  1. POST /api/auth/logout con `Authorization: Bearer <accessToken>`
  2. Reintentar POST /api/auth/refresh con la cookie que tenía el navegador
     antes del logout
Esperado: paso 1 → 200 "Sesión cerrada" + `Set-Cookie` que expira
  `sb_refresh_token` (`Expires` en el pasado); paso 2 → 401 (el refresh token
  quedó revocado en Supabase, `scope=global`)
Resultado: parcialmente probado — logout sin access token (usuario ya sin
  sesión) devuelve 200 y limpia la cookie igual (✅ OK 2026-09-15, verificado
  con curl). Falta probar el caso con sesión real activa.

ID: TC-227
Caso: Rate limit / bloqueo por fuerza bruta en /api/auth/login
Tipo: security
Pasos:
  1. 11 POST /api/auth/login seguidos en <60s con la misma IP (credenciales
     cualquiera) → validar el límite de IP (max 10/min)
  2. 4 POST /api/auth/login con el mismo email y contraseña incorrecta →
     validar el bloqueo por cuenta (`loginBruteforce`, backoff desde el 4° fallo)
Esperado: paso 1 → el 11° request da 429 `RATE_LIMITED` con `Retry-After`;
  paso 2 → el 4° intento da 429 `ACCOUNT_LOCKED` con `Retry-After` creciente
Resultado: ✅ headers de rate limit verificados en cada request de esta
  pasada (`X-RateLimit-*` decrecientes); no se llegó a disparar el 429 en sí
  (se hicieron pocos requests para no ensuciar el store compartido con
  `/api/users/login`)

ID: TC-228
Caso: CORS — /api/auth/* solo responde con `Access-Control-Allow-Credentials`
  para orígenes de la allowlist
Tipo: security
Pasos:
  1. POST /api/auth/refresh con `Origin: http://localhost:5173` (allowlist)
  2. POST /api/auth/refresh con `Origin: https://sitio-malicioso.com`
Esperado: paso 1 → `Access-Control-Allow-Origin` refleja el origin + `Allow-
  Credentials: true`; paso 2 → sin esos headers (el browser real bloquearía
  la respuesta aunque el servidor responda 200/401)
Resultado: ✅ OK 2026-09-15 — paso 1 verificado con curl (headers presentes
  y correctos). Paso 2 no probado.

ID: TC-229
Caso: ventas.user_id se completa al crear una orden autenticada (MP y transferencia)
Tipo: happy
Pre-condición: script SQL `2026-09-18_add_user_id_to_ventas.sql` ya aplicado en Supabase;
  usuario de sitio logueado
Pasos:
  1. Iniciar sesión con un usuario del sitio
  2. Completar checkout por transferencia → `POST /api/orders/transfer`
  3. Completar checkout con Mercado Pago → `POST /api/orders/mp-preference`
  4. `SELECT id, user_id, buyer_email FROM ventas ORDER BY created_at DESC LIMIT 2`
Esperado: las dos ventas nuevas tienen `user_id` = uuid del usuario logueado
  (no NULL), y `buyer_email` sigue coincidiendo con su email
Resultado: no probado — pendiente de aplicar el script SQL en producción

ID: TC-230
Caso: paid_at / cancelled_at / dispatched_at se completan solos al cambiar de estado
Tipo: happy
Pre-condición: script SQL `2026-09-18_add_status_timestamps_to_ventas.sql` ya aplicado
Pasos:
  1. Confirmar una transferencia pendiente (`PATCH /api/orders/:id/confirm-transfer`)
     → verificar `paid_at` en la base
  2. Cancelar una orden de transferencia pendiente (`PATCH /api/orders/:id/cancel-transfer`)
     → verificar `cancelled_at`
  3. Desde el panel admin (Despachos), cambiar `dispatch_status` a "despachado"
     → verificar `dispatched_at`
Esperado: cada columna queda con la fecha/hora real del cambio; el resto de las
  columnas de timestamp para esa fila quedan NULL (no se pisan entre sí)
Resultado: no probado — pendiente de aplicar el script SQL en producción
```

### Cambios 2026-10-05/06 — catálogo por audiencia, auth 503, idempotencia, webhook firmado, RLS de ventas (`TC-301`–`TC-333`)

> **Nota (merge con `lia-back`, 2026-10-16):** los IDs de esta sección se renumeraron (+70) para no chocar con los casos de idempotencia y conciliación de `lia-back`. Se redactaron contra la implementación anterior del checkout: antes de ejecutarlos, revisar los de idempotencia (`TC-301`–`TC-317`) contra `utils/idempotency.js`.

> Estado de ejecución: **ningún caso de esta sección se ejecutó contra una base ni un
> servidor real** (esta pasada fue solo de documentación, leyendo el código). El pedido
> original mencionaba verificaciones parciales con stubs; **no hay evidencia de ellas en el
> repo** (`qa/` solo contiene `concurrency-stock-test.js`, `load-test.js` y
> `_verify_mp_timeout.js`, ninguno cubre estos casos), así que todo figura como
> `no probado`. Cuando alguien corra un caso, que anote fecha y método (stub / servidor real).
> Pre-condiciones comunes: scripts SQL `2026-10-06_idempotency_key.sql` y
> `2026-10-06_ventas_restrict_update.sql` aplicados (donde el caso lo indique), backend en
> `localhost:3000`, un usuario común y un admin con token válido, un producto activo con
> stock >= 3 y uno con `status='inactive'`.

```
ID: TC-301
Caso: Catálogo público no lista productos inactivos; admin sí
Tipo: security
Pre-condición: existe al menos un producto con status 'inactive'
Pasos:
  1. GET /api/products?limit=100 sin Authorization
  2. GET /api/products?limit=100 con token de usuario común
  3. GET /api/products?limit=100 con token de admin
Esperado: pasos 1 y 2 no incluyen el inactivo (`total` cuenta solo activos; productos con
  status NULL cuentan como activos); paso 3 lo incluye y su `total` es mayor; la respuesta
  del paso 3 trae `Cache-Control: private, no-store` y todas traen `Vary: Authorization`
Resultado: no probado

ID: TC-302
Caso: Detalle de producto inactivo — público 404, admin 200
Tipo: security
Pasos:
  1. GET /api/products/:idInactivo sin token
  2. GET /api/products/:idInactivo con token de admin
  3. GET /api/products/:idActivo sin token
Esperado: paso 1 -> 404 "Producto no encontrado"; paso 2 -> 200; paso 3 -> 200
Resultado: no probado

ID: TC-303
Caso: La caché del catálogo no se mezcla entre audiencias
Tipo: edge
Pasos:
  1. Reiniciar el backend (caché vacía)
  2. GET /api/products como admin (calienta la clave `list:admin:...`)
  3. Inmediatamente GET /api/products sin token
  4. Repetir invirtiendo el orden (público primero, admin después)
Esperado: en ambos órdenes el público nunca ve inactivos y el admin siempre los ve
  (claves `list:public:*` / `list:admin:*` y `detail:public:*` / `detail:admin:*` separadas)
Resultado: no probado

ID: TC-304
Caso: Token inválido o falla de auth en endpoint público degrada a anónimo
Tipo: failure
Pasos:
  1. GET /api/products con `Authorization: Bearer basura`
  2. (Con Supabase Auth bloqueado/lento) GET /api/products con un token válido
Esperado: ambos responden 200 con la vista pública (sin inactivos); no 401 ni 503; en el
  paso 2 el log trae `optional_auth_degraded`
Resultado: no probado

ID: TC-305
Caso: id de producto inválido responde 404 sin tocar la base
Tipo: edge
Pasos:
  1. GET /api/products/abc, /api/products/1e3, /api/products/-1, /api/products/1234567890123456 (16 dígitos)
  2. PUT y DELETE a /api/products/abc con token de admin
Esperado: 404 "Producto no encontrado" en todos (regex `^\d{1,15}$`); ningún 500 ni error de
  rango de pg; un id válido inexistente (ej. 999999999) también da 404
Resultado: no probado

ID: TC-306
Caso: 503 AUTH_UNAVAILABLE cuando Supabase Auth no responde en 3 s (sin 401)
Tipo: failure
Pre-condición: poder simular un Supabase Auth lento (proxy/stub que demore > 3 s o corte la conexión)
Pasos:
  1. POST /api/orders/transfer con un token válido que NO esté en caché de auth (30 s)
Esperado: respuesta 503 `{ code: 'AUTH_UNAVAILABLE' }` con header `Retry-After: 2`
  en ~3 s; log `auth_unavailable`; el mismo token válido funciona al volver Auth
Resultado: no probado

ID: TC-307
Caso: Token realmente inválido sigue dando 401 (no 503)
Tipo: security
Pasos:
  1. GET /api/orders/user?email=x@y.com con `Authorization: Bearer token-roto`
  2. Idem sin header Authorization
Esperado: paso 1 -> 401 "Token inválido o expirado"; paso 2 -> 401 "Token de autenticación requerido"
Resultado: no probado

ID: TC-308
Caso: Front — el 503 AUTH_UNAVAILABLE no cierra la sesión (ver TC-API-01 del front del front)
Tipo: failure
Pasos:
  1. Con la sesión iniciada, forzar el 503 del caso TC-306 durante un checkout
  2. Observar la UI
Esperado: el usuario sigue logueado; `apiFetch` reintenta una vez tras `Retry-After`; no se
  emite `auth:logout`
Resultado: no probado

ID: TC-309
Caso: Checkout sin Idempotency-Key funciona igual que antes (compatibilidad)
Tipo: happy
Pasos:
  1. POST /api/orders/transfer sin header, producto stock 3, cantidad 1
Esperado: 201 con `order_ids`; stock 2; la fila de `ventas` tiene `idempotency_key` NULL
Resultado: no probado

ID: TC-310
Caso: Doble click / doble submit con la misma Idempotency-Key no duplica la reserva
Tipo: edge
Pre-condición: script `2026-10-06_idempotency_key.sql` aplicado
Pasos:
  1. Generar una key (ej. `qa-key-0001`)
  2. POST /api/orders/transfer con esa key y un carrito de 2 líneas
  3. Repetir exactamente el mismo POST (misma key, mismo carrito) otra vez, después de que
     terminó el primero
Esperado: ambas responden 201 con los mismos `order_ids`; en `ventas` solo hay 2 filas con
  `idempotency_key` = `qa-key-0001:<12 hex>:0` y `...:1`; el stock se descontó UNA vez;
  log `order_reserve_replayed` en la segunda
Resultado: no probado

ID: TC-311
Caso: Misma key con distinto carrito responde 422
Tipo: failure
Pasos:
  1. POST /api/orders/transfer con key K y carrito A (1 unidad del producto X)
  2. POST /api/orders/transfer con key K y carrito B (2 unidades de X, o producto Y)
  3. POST /api/orders/transfer con key K, carrito A pero otro `shippingMethod`
Esperado: pasos 2 y 3 -> 422 `IDEMPOTENCY_KEY_REUSED` con mensaje "Esta compra no coincide con
  la que ya se había iniciado..."; no se crean filas nuevas ni se descuenta stock
Resultado: no probado

ID: TC-312
Caso: Misma key con distinto medio de pago responde 422
Tipo: failure
Pasos:
  1. POST /api/orders/transfer con key K
  2. POST /api/orders/mp-preference con key K y el mismo carrito
Esperado: paso 2 -> 422 `IDEMPOTENCY_KEY_REUSED` (el medio de pago está en la huella y se
  compara `payment_method` de la fila guardada)
Resultado: no probado

ID: TC-313
Caso: Formato inválido de Idempotency-Key responde 400
Tipo: edge
Pasos:
  1. POST /api/orders/transfer con header `Idempotency-Key: corta` (5 caracteres)
  2. Idem con `abc:def:ghi12345` (contiene ':'), con 129 caracteres y con espacios
Esperado: 400 `INVALID_IDEMPOTENCY_KEY` en todos; nada persistido, stock intacto
Resultado: no probado

ID: TC-314
Caso: Carrera simultánea de N requests con la misma key
Tipo: edge
Pasos:
  1. Disparar 10 POST /api/orders/transfer en paralelo con la misma key y mismo carrito
     (stock suficiente), desde procesos/conexiones distintas para evitar el single-flight
     en memoria (`caches.orders.single`)
Esperado: todas responden 201 con los mismos `order_ids`; en la base solo hay una reserva
  (N líneas del carrito, no 10 x N); stock descontado una sola vez; sin 500
Resultado: no probado
Notas: complementa TC-192; el test automatizado `qa/concurrency-stock-test.js` invoca
  `reserveOrders` directo y podría extenderse con `idempotencyKey`.

ID: TC-315
Caso: Replay de mp-preference sobre órdenes que ya no están pendientes responde 409
Tipo: failure
Pasos:
  1. POST /api/orders/mp-preference con key K (queda 'pendiente')
  2. Cancelar la orden (POST /api/orders/:id/cancel) o dejarla expirar
  3. Repetir el POST con la misma key y carrito
Esperado: 409 "Esta compra ya fue procesada, cancelada o venció. Iniciá una nueva compra."
  (el front debe generar una key nueva para un carrito nuevo)
Resultado: no probado

ID: TC-316
Caso: Si Mercado Pago falla tras reservar, la key se libera y se puede reintentar
Tipo: failure
Pre-condición: poder forzar un error de MP (ej. `MP_ACCESS_TOKEN` inválido o timeout)
Pasos:
  1. POST /api/orders/mp-preference con key K -> MP falla (502)
  2. Verificar las filas en `ventas`
  3. Corregir MP y repetir el POST con la misma key K
Esperado: paso 1 -> 502; paso 2 -> las órdenes quedaron 'cancelado' con `idempotency_key`
  NULL y el stock restaurado; paso 3 -> 201 con órdenes nuevas (no 409 "ya procesada")
Resultado: no probado

ID: TC-317
Caso: Idempotency-Key con la migración SQL sin aplicar
Tipo: failure
Pre-condición: base SIN la columna `ventas.idempotency_key`
Pasos:
  1. POST /api/orders/transfer con cualquier key válida
Esperado: 500 "No se pudo registrar la orden. Intentá de nuevo." con rollback y stock intacto
  (por eso el script SQL va antes del deploy del front; ver flow-despliegue-produccion.md);
  sin header el mismo POST sigue funcionando (TC-309)
Resultado: no probado

ID: TC-318
Caso: Webhook de MP con MP_WEBHOOK_SECRET definido y sin firma
Tipo: security
Pre-condición: `MP_WEBHOOK_SECRET` cargada
Pasos:
  1. POST /api/orders/mp-webhook?type=payment&data.id=123 sin header x-signature
  2. Idem con `x-signature: ts=1,v1=00` (firma inválida)
  3. Idem con `type=merchant_order` y sin firma
Esperado: los tres -> 401 `{ success: false }`; log `mp_webhook_invalid_signature`; no se
  consulta la API de MP ni se modifica ninguna orden
Resultado: no probado

ID: TC-319
Caso: Webhook con firma válida marca pagada la orden
Tipo: happy
Pre-condición: `MP_WEBHOOK_SECRET` cargada; orden MP pendiente; pago aprobado en sandbox
Pasos:
  1. Calcular `v1` = HMAC-SHA256(secret, `id:<data.id en minúsculas>;request-id:<x-request-id>;ts:<ts>;`)
  2. POST al webhook con `x-signature: ts=<ts>,v1=<v1>` y `x-request-id`
Esperado: 200; la orden pasa a 'pagado'; si no se marcó ninguna fila, el catálogo cacheado no se invalida
Resultado: no probado

ID: TC-320
Caso: Webhook sin MP_WEBHOOK_SECRET se acepta y deja aviso
Tipo: edge
Pre-condición: `MP_WEBHOOK_SECRET` vacía
Pasos:
  1. Arrancar el backend y mirar los logs
  2. POST al webhook sin firma con un pago aprobado
Esperado: log `mp_webhook_unsigned` (phase 'startup') al arrancar y por request; el pago se
  procesa igual tras revalidarlo contra la API de MP (200)
Resultado: no probado

ID: TC-321
Caso: Orden con nombre/imagen del producto falsificados en el body
Tipo: security
Pasos:
  1. POST /api/orders/transfer con `items[0].productName = "Producto trucho"` y
     `productImage = "https://evil.example/x.png"` para un producto real
  2. Mirar la fila creada en `ventas` y (en MP) el título de la preferencia
Esperado: `product_name` y `product_image` de la fila son los de `productos`
  (`name`, `image_url`), no los del body; el título/imagen en MP también
Resultado: no probado
Notas: `productName` del body sigue siendo obligatorio (400 si falta), pero no se persiste.

ID: TC-322
Caso: Orden con email de otra persona en el body
Tipo: security
Pasos:
  1. Con el usuario A logueado: POST /api/orders/transfer con `buyerEmail: "victima@x.com"`
  2. GET /api/orders/user?email=victima@x.com como usuario A, y como la víctima (tras confirmar pago)
Esperado: la fila queda con `buyer_email` = email de la cuenta A y `user_id` = A; la orden
  NO aparece en "Mis compras" de la víctima; el paso 2 como A da 403 (email ajeno)
Resultado: no probado

ID: TC-323
Caso: Dueño por user_id con fallback por email en filas históricas
Tipo: security
Pre-condición: una orden nueva (con `user_id`) y una histórica sin `user_id` de otro usuario
Pasos:
  1. Usuario B: POST /api/orders/:idDeA/cancel y POST /api/orders/nudge con la orden de A
  2. Usuario dueño de la fila histórica (match por email): cancelar su orden MP pendiente
  3. Usuario con `user_id` de la orden pero email cambiado: GET /api/orders/user?email=<su email actual>
Esperado: paso 1 -> 403 (cancel) y `applied: 0` (nudge); paso 2 -> 200; paso 3 -> ve sus
  compras ligadas a `user_id` aunque el `buyer_email` guardado sea otro
Resultado: no probado

ID: TC-324
Caso: Carrito con productId inválido o inexistente
Tipo: edge
Pasos:
  1. POST /api/orders/transfer con `productId: "abc"` (o ausente)
  2. Idem con `productId: 999999999` (no existe)
Esperado: paso 1 -> 400 "No se pudo identificar el producto ..."; paso 2 -> 409 "No hay stock
  suficiente de ..."; en ambos no se persiste nada y los locks se liberan
Resultado: no probado

ID: TC-325 — DEPRECATED (2026-10-21)
Motivo: `POST /api/users/login` fue retirado (404, ver TC-349). Lo mismo se cubre en TC-326
  sobre `POST /api/auth/login`, que ahora también rechaza emails de más de 254 caracteres (TC-351).

ID: TC-326
Caso: POST /api/auth/login con tipos inválidos en el body
Tipo: edge
Pasos:
  1. POST /api/auth/login con `{"email": {"a":1}, "password": "x"}`
Esperado: 400 (mismo criterio que TC-325)
Resultado: no probado
Notas: HALLAZGO abierto H-OBJ-LOGIN. Por lectura de código, `authController.login` solo valida
  `!email || !password` (no `typeof`), y `checkLock(email)` llama `email.toLowerCase()`, que
  lanza TypeError con un objeto -> cae en el catch y responde 500 "No se pudo validar las
  credenciales". No se ejecutó para confirmarlo.

ID: TC-327
Caso: El rastreo de fuerza bruta de login se purga y tiene tope
Tipo: edge
Pasos:
  1. Provocar 3 fallos de login para un email y esperar > 15 min (o simular el reloj)
  2. Observar que el registro desaparece (purga cada 60 s) y que un nuevo fallo cuenta desde 1
  3. Provocar fallos con > 10000 emails distintos
Esperado: los registros vencidos (ventana 15 min y sin bloqueo vigente) se eliminan solos; el
  Map nunca supera 10000 cuentas (se descartan las más viejas); el proceso puede terminar
  (timer con `unref`)
Resultado: no probado

ID: TC-328
Caso: UPDATE sobre ventas desde el cliente solo permite dispatch_status
Tipo: security
Pre-condición: script `2026-10-06_ventas_restrict_update.sql` aplicado; sesión admin de Supabase
Pasos:
  1. Con supabase-js (anon key + sesión admin): `update({ dispatch_status: 'despachado' }).eq('id', X)`
  2. `update({ payment_status: 'pagado' }).eq('id', X)`, y lo mismo con `total_price` y `buyer_email`
  3. Con la anon key sin sesión: `select` y `update` sobre `ventas`
Esperado: paso 1 OK y `dispatched_at` queda seteado por el trigger; paso 2 -> error de
  permisos (42501 / "permission denied for table ventas"); paso 3 -> sin acceso (anon no tiene
  privilegios)
Resultado: no probado

ID: TC-329
Caso: Verificación de privilegios de columna tras aplicar el script
Tipo: security
Pasos:
  1. Ejecutar la consulta de `information_schema.column_privileges` (ver
     docs/flows/flow-despliegue-produccion.md, "Orden de despliegue 2026-10-06")
Esperado: para `authenticated` y `UPDATE` solo aparece `dispatch_status`
Resultado: no probado

ID: TC-330
Caso: Los flujos del backend siguen actualizando ventas con el UPDATE restringido
Tipo: edge
Pasos:
  1. Confirmar y cancelar una transferencia desde el panel (backend)
  2. Pagar una orden MP (mp-confirm / webhook) y dejar expirar otra (sweep)
Esperado: todo funciona (el backend corre como `postgres` y no depende de los GRANT del cliente)
Resultado: no probado

ID: TC-331
Caso: Deadlock entre carritos con los mismos productos en orden cruzado
Tipo: edge
Pasos:
  1. Con stock suficiente de A y B, disparar en paralelo (varias rondas, 20+ pares) un
     checkout con items [A, B] y otro con [B, A], de usuarios distintos y sin key
Esperado: todos responden 201 (o 409 si se agota stock), ningún 500; ninguna entrada
  `order_reserve_failed` con code `40P01` en los logs (los locks se toman en orden de id)
Resultado: no probado
Notas: antes del cambio, dos transacciones podían bloquearse mutuamente y una caía con 40P01.

ID: TC-332
Caso: Ids de orden mal formados no revientan las consultas por uuid
Tipo: edge
Pasos:
  1. POST /api/orders/not-a-uuid/cancel con token válido
  2. PATCH /api/orders/123/confirm-transfer con token de admin
  3. POST /api/orders/nudge con `orderIds: ["x", "<uuid válido ajeno>"]`
Esperado: pasos 1 y 2 -> 400 `INVALID_ORDER_ID` (validado en el borde, sin llegar a la base ni error de cast de Postgres); paso 3
  -> 200 con `applied` solo sobre lo que corresponde
Resultado: no probado

ID: TC-333
Caso: Insights "hoy" usa el índice y mantiene el corte por día en zona horaria local
Tipo: edge
Pasos:
  1. Con ventas cerca de la medianoche local (23:59 / 00:01), consultar el insight de ventas del día
  2. `EXPLAIN` de la consulta de `Insights` con `created_at >= inicio_de_hoy AND created_at < inicio_de_hoy + 1 day`
Esperado: el resultado incluye solo ventas del día local; el plan puede usar `idx_ventas_paid_created`
  (rango sargable sobre `created_at` en lugar de `date_trunc` sobre la columna)
### Segunda pasada de seguridad (2026-10-16)

ID: TC-334
Caso: Una sola línea no puede reservar todo el stock de un producto
Tipo: security
Pre-condición: producto activo con stock >= 25; usuario común logueado
Pasos:
  1. POST /api/orders/transfer con un ítem de quantity 21
  2. Repetir con quantity 20
  3. Con MAX_QUANTITY_PER_LINE=3 en el entorno, probar quantity 4 y 3
Esperado: paso 1 -> 400 VALIDATION_ERROR sin filas nuevas en ventas ni cambio de stock; paso 2 -> 201;
  paso 3 -> 400 y 201
Resultado: OK 2026-10-16 con dobles (test/security-pass2.test.js, SEC-N01); falla en el código anterior

ID: TC-335
Caso: Tope de unidades pendientes por cuenta (MAX_PENDING_UNITS_PER_USER, default 60)
Tipo: security
Pre-condición: usuario común sin pendientes; producto con stock >= 100
Pasos:
  1. Crear 3 compras de 20 unidades por transferencia (quedan pendientes)
  2. Pedir 1 unidad más
  3. Cancelar una de las 3 y repetir el paso 2
Esperado: paso 2 -> 429 TOO_MANY_PENDING_ORDERS sin reservar; paso 3 -> 201 (se liberaron 20)
Resultado: OK 2026-10-16 contra PostgreSQL local real (test/integration/real-db.test.js); stock final 440 de 500

ID: TC-336
Caso: Rate limit de checkout por cuenta (no solo por IP)
Tipo: security
Pasos:
  1. Con el usuario A, hacer 9 POST /api/orders/transfer en menos de 1 minuto
  2. Sin esperar, con el usuario B desde la misma IP, hacer 1 POST
Esperado: la 9.ª de A -> 429 RATE_LIMITED con Retry-After; B no recibe 429
Resultado: OK 2026-10-16 con dobles (SEC-N02). Falta confirmar en Render, detrás de Cloudflare, qué IP ve req.ip (ver SEC-N09)

ID: TC-337
Caso: La misma Idempotency-Key de dos usuarios no cruza respuestas
Tipo: security
Pasos:
  1. Usuario A hace POST /transfer con Idempotency-Key K
  2. Usuario B hace POST /transfer con la misma K y su propio carrito
  3. A repite con K y el mismo carrito; luego con K y otro carrito
Esperado: B recibe SUS propios order_ids; A recibe lo mismo sin reservar otra vez; con otro carrito 422
  IDEMPOTENCY_KEY_REUSED
Resultado: OK 2026-10-16 con dobles (control ya existente, ahora fijado por test)

ID: TC-338
Caso: Devolución parcial de un pago aprobado queda marcada para el admin
Tipo: failure
Pre-condición: sandbox de Mercado Pago, una compra pagada
Pasos:
  1. Devolver parte del importe desde el panel de MP
  2. Esperar la notificación (o reenviar el webhook firmado desde el panel de MP)
Esperado: la venta sigue 'pagado', queda review_reason = 'refunded', log payment_reversed; el stock no cambia
Resultado: OK 2026-10-16 con dobles y contra PostgreSQL local real (SEC-N03). Pendiente con MP sandbox

ID: TC-339
Caso: Los logs no guardan emails de la query string
Tipo: security
Pasos:
  1. Superar el rate limit de GET /api/orders/user?email=<email de prueba> (40/min)
  2. Revisar el log rate_limit_blocked
Esperado: path = /api/orders/user, sin el email
Resultado: OK 2026-10-16 con dobles (SEC-N04)

ID: TC-340
Caso: Pruebas de integración contra un PostgreSQL local aislado
Tipo: edge / concurrencia
Pre-condición: PostgreSQL 16 local con SSL activo (initdb, ssl = on con certificado autofirmado), base lia_test
  con db/migracion-nueva-cuenta/01_schema_public.sql (sin las extensiones de Supabase), un esquema auth con
  users(id, email, raw_user_meta_data) y auth.uid(), los roles anon / authenticated / service_role, y los scripts
  de db/migrations/ aplicados en orden de fecha
Pasos:
  1. LIA_TEST_DB_PORT=<puerto> npm test
Esperado: los 16 tests de test/integration/real-db.test.js pasan: 25 compradores de la última unidad -> 1 gana;
  última unidad de un talle; 20 carritos cruzados sin deadlock; tope de 60 unidades; pagos (monto menor, duplicado,
  tardío con y sin stock); doble cancelación simultánea; SQL de IdempotencyKey, findPurchasesByEmail, expiración,
  conciliación y devoluciones; barrido; auditoría con actor
Resultado: OK 2026-10-16 (16/16). Sin LIA_TEST_DB_PORT los tests se saltean. Nunca apuntar a la base de Supabase
Notas: reemplaza a qa/concurrency-stock-test.js, que importa reserveOrders de un módulo que ya no la exporta

ID: TC-341
Caso: GET /health en producción no expone el detalle interno
Tipo: security
Pasos:
  1. GET /health sin header
  2. Con HEALTH_DETAIL_TOKEN definido, GET /health con x-health-token correcto e incorrecto
Esperado: 1 -> solo { status, uptimeSeconds }; 2 -> detalle solo con el token correcto
Resultado: OK 2026-10-16 con dobles (SEC-N05). Verificado en vivo ANTES del cambio: lia-back.onrender.com/health devolvía pool, bulkhead y cachés

ID: TC-342
Caso: MFA de admin (opt-in)
Tipo: security
Pre-condición: ADMIN_REQUIRE_MFA=true, TOTP de Supabase activado y enrolado para el admin de prueba
Pasos:
  1. Con sesión de solo contraseña (aal1) llamar a una ruta admin
  2. Verificar el segundo factor y repetir con el token nuevo (aal2)
Esperado: 1 -> 403 MFA_REQUIRED; 2 -> la ruta responde normal; usuario común -> 403 igual
Resultado: lógica OK 2026-10-16 con dobles (SEC-N06). No probado con Supabase real: el panel no tiene el desafío TOTP

ID: TC-343
Caso: audit_log atribuye al admin los cambios hechos por la API
Tipo: security
Pre-condición: script 2026-10-16_audit_actor.sql aplicado (2026-10-16)
Pasos:
  1. Desde el panel (PUT /api/products/:id) cambiar el precio del producto de prueba
  2. SELECT at, actor, table_name FROM public.audit_log ORDER BY id DESC LIMIT 3
  3. Dejar que el sweep expire una orden (sin usuario)
Esperado: paso 2 -> actor = uuid del admin; paso 3 -> actor NULL (sistema); un actor mal formado no rompe la escritura
Resultado: OK 2026-10-16 contra PostgreSQL local real (SEC-N07); falta aplicarlo en Supabase

ID: TC-344
Caso: El barrido no se queda siempre con las mismas compras retenidas
Tipo: edge
Pasos:
  1. Tener >= 1 compra de MP retenida (pago en curso) consultada hace < 5 min y otra vencida sin consultar
  2. Ejecutar un ciclo del sweep
Esperado: la retenida no vuelve a salir en el lote; la otra se evalúa
Resultado: OK 2026-10-16 contra PostgreSQL local real (SEC-N08)

ID: TC-345
Caso: Matriz de permisos por rol contra el esquema real (anon / usuario / admin)
Tipo: security
Pre-condición: base local de TC-340 con los scripts de RLS
Pasos:
  1. Con SET LOCAL ROLE y request.jwt.claim.sub, ejecutar SELECT / UPDATE / INSERT / DELETE sobre ventas, productos,
     profiles, audit_log, contact_messages y las funciones SECURITY DEFINER para anon, un usuario común y un admin
Esperado: anon y usuario común sin acceso a ventas ni audit_log; usuario sin escritura en productos ni en profiles;
  admin solo UPDATE de productos.featured y de ventas.dispatch_status; EXECUTE de las funciones definer denegado
Resultado: OK 2026-10-16 (35 verificaciones, todas como se esperaba; la de site_content quedó inconclusa por tabla vacía). Es el esquema de los scripts, no la base de Supabase

### Idempotencia de creación de órdenes (`Idempotency-Key`)

```
ID: TC-231
Caso: Reintento con la misma key y el mismo carrito devuelve la orden original
Tipo: happy / edge
Pre-condición: usuario logueado, producto con stock
Pasos:
  1. POST /api/orders/mp-preference con header Idempotency-Key: <uuid> → 201
  2. Repetir exactamente la misma request (misma key y body)
Esperado: la segunda devuelve 201 con los mismos order_ids e init_point; en `ventas` hay un
  solo juego de filas y el stock se descontó UNA vez
Resultado: no probado — la lógica de replay sí se verificó con un script unitario (2026-10-08)

ID: TC-238
Caso: El replay sobrevive a un reinicio del backend
Tipo: edge
Pre-condición: migración 2026-10-08_add_idempotency_keys.sql aplicada
Pasos:
  1. Crear una compra con la key K (201) y anotar order_ids
  2. Reiniciar el servicio en Render (Manual Deploy / Restart)
  3. Repetir la misma request (misma K y mismo body)
Esperado: 201 con las mismas order_ids; `SELECT * FROM idempotency_keys WHERE key = 'K'` tiene
  una fila; no hay ventas nuevas ni doble descuento de stock
Resultado: no probado — con el modelo simulado sí (2026-10-08)

ID: TC-239
Caso: Sin la tabla, el checkout sigue funcionando
Tipo: failure / regression
Pre-condición: migración NO aplicada (o tabla renombrada temporalmente)
Pasos:
  1. Completar una compra con Idempotency-Key
  2. Repetirla con la misma key
Esperado: ambas responden bien (la 2ª por memoria, misma orden); en los logs aparece
  `idempotency_write_failed` / `idempotency_read_failed` (código 42P01); el pago no se corta
Resultado: no probado — con el modelo simulado sí (2026-10-08)

ID: TC-347
Caso: Misma key con otro nombre o email de comprador
Tipo: edge
Pasos:
  1. Crear una compra con la key K
  2. Repetir con la misma K cambiando solo buyerName o buyerEmail
Esperado: 422 IDEMPOTENCY_KEY_REUSED (la huella del backend incluye al comprador)
Resultado: no probado

ID: TC-348
Caso: La tabla no es accesible desde el navegador
Tipo: security
Pre-condición: migración aplicada
Pasos:
  1. Con la anon key (o un usuario logueado) intentar SELECT/INSERT sobre idempotency_keys
Esperado: permiso denegado / 0 filas (RLS activo sin policies, REVOKE a anon/authenticated)
Resultado: no probado

ID: TC-232
Caso: Misma key con carrito distinto
Tipo: failure
Pasos:
  1. Crear una compra con la key K (201)
  2. Repetir con la misma K pero otra cantidad, otro envío o otro total
Esperado: 422 { code: 'IDEMPOTENCY_KEY_REUSED' } con mensaje en lenguaje humano; no se crea
  ninguna venta nueva ni se toca el stock
Resultado: no probado

ID: TC-233
Caso: Key con formato inválido
Tipo: edge / security
Pasos:
  1. Enviar Idempotency-Key de 3 caracteres, de 129 caracteres o con espacios/símbolos
Esperado: 400 { code: 'IDEMPOTENCY_KEY_INVALID' }; nada se persiste
Resultado: no probado

ID: TC-234
Caso: Un error no queda "pegado" a la key
Tipo: failure
Pre-condición: stock = 0 del producto
Pasos:
  1. Crear compra con la key K → 409 sin stock
  2. Reponer stock y repetir con la misma K
Esperado: el segundo intento se ejecuta y responde 201 (los 409/502 no se recuerdan)
Resultado: no probado

ID: TC-235
Caso: La key no se comparte entre usuarios ni entre tipos de pago
Tipo: security
Pasos:
  1. Usuario A crea una compra MP con la key K (201)
  2. Usuario B usa la misma K con su carrito; luego A usa K en /transfer
Esperado: B y /transfer crean órdenes propias (no reciben la respuesta de A)
Resultado: no probado

ID: TC-236
Caso: Sin header el comportamiento no cambia
Tipo: regression
Pasos:
  1. Compra por MP y por transferencia sin Idempotency-Key
  2. Doble click rápido sin header
Esperado: ambas compras funcionan; el doble click simultáneo sigue creando un solo juego de ventas
Resultado: no probado

ID: TC-237
Caso: CORS permite Idempotency-Key desde el dominio del front
Tipo: regression
Pasos:
  1. Desde https://www.liaa.com.ar iniciar "Pagar con Mercado Pago"
  2. DevTools → Network: ver el preflight OPTIONS de /orders/mp-preference
Esperado: OPTIONS 204 con Access-Control-Allow-Headers que incluye idempotency-key; el POST
  responde 201 (antes: "Failed to fetch" por CORS)
Resultado: no probado
```

---

## Casos pendientes sin probar (backlog)

| ID | Caso | Bloqueante |
|----|------|-----------|
| TC-101 | MP sin token configurado | ✅ OK 2026-07-01 — 503 + mensaje correcto |
| TC-106 | Pago acreditado después de expirar (carrera sweep vs pago) | — |
| TC-111 | confirm/cancel-transfer sin rol admin | necesita usuario no-admin de prueba |
| TC-120 | Cotización de envío (CP válido e inválido) | ✅ API OK 2026-07-01; UI pendiente (requiere usuario no-admin) |
| TC-130 | Login con contraseña incorrecta | ✅ OK 2026-07-01 — 401 "Credenciales inválidas" |
| TC-131 | GET /api/users/auth/:userId | ✅ OK 2026-07-01 — 200 con perfil completo |
| TC-223/224/226 | Happy path de login/refresh/logout con cookie httpOnly | necesita cuenta de prueba con password vigente (la de memoria devolvió 401) |
| TC-225 (caso 2) | Refresh con cookie con valor basura | — |
| TC-228 (caso 2) | Refresh con Origin no permitido (CORS) | — |
| TC-152 | Insights — usuario sin rol admin | necesita usuario no-admin de prueba |
| TC-153 | Insights — threshold inválido en low-stock | ✅ OK 2026-07-01 — saturación y default correctos |
| TC-160–162 | Nudge happy path + cancelar pedido + stock restaurado | ✅ OK 2026-07-01 (ver notas TC-162) |
| TC-163–164 | Nudge cerrar sin responder / IDOR | BLOQUEADO — requiere cuenta no-admin para UI |
| TC-165–166 | Nudge payload inválido / idempotencia | ✅ OK 2026-07-01 |
| TC-167 | Insights — columna WhatsApp en pendientes | ✅ OK 2026-07-01 — columna origin presente; row activo con origin="" |
| TC-169 | Transferencia happy path (usuario estándar) | ✅ API OK 2026-07-01; UI pendiente (requiere usuario no-admin) |
| TC-170 | Admin confirma transferencia — UI | ✅ OK 2026-07-01 — Playwright /admin/sales; stock sin doble descuento |
| TC-171 | Admin cancela transferencia — UI | ✅ OK 2026-07-01 — stock restaurado correctamente |
| — | Recuperación de contraseña (email reset + cambio + login nuevo) | ✅ UI OK 2026-07-01 (ver TC-172) |
| — | "Mis compras" — historial del usuario | ✅ API OK 2026-07-01 (2 órdenes pagadas); UI BLOQUEADA (AdminRedirect) |
| — | About, Contacto — páginas públicas | ✅ OK 2026-07-01 (ver TC-173/174) |
| — | Checkout con carrito vacío (URL directa) | ✅ OK 2026-07-01 — redirige a /products |
| — | Safari iOS / Android Chrome — flujo de checkout completo | — |
| TC-192 | Doble submit del checkout no duplica órdenes | necesita usuario logueado + token MP |
| TC-231–TC-263 | Cambios 2026-10-05/06 (catálogo por audiencia, auth 503, idempotencia, webhook firmado, UPDATE de ventas, deadlock) | no probados: requieren aplicar los scripts SQL del 2026-10-06 y MP_WEBHOOK_SECRET; ver sección propia |

## Matriz de cobertura

| Módulo | happy | edge | failure | security | concurrencia |
|---|---|---|---|---|---|
| Órdenes MP | TC-100 | TC-102/105/106 | TC-101/104 | TC-107/108 | TC-103 |
| Transferencias | TC-109 | TC-110 | — | TC-111 | — |
| Nudge post-WhatsApp | TC-160/161/162 | TC-163/166 | TC-165 | TC-164 | — |
| Webhook | TC-112 | — | TC-112 | — | — |
| Shipping | TC-120 | TC-120 | TC-120 | — | — |
| Auth/usuarios | TC-131/223/224/226 | TC-225 | — | TC-130/225/227 | TC-228 |
| Front data layer | TC-141 | — | TC-140 | — | — |
| Asistente insights | TC-150 | TC-153/154 | TC-155 | TC-151/152 | — |
| Concurrencia y carga | TC-180/183/185/190 | TC-184/187/193 | TC-188/189/191 | TC-186 | TC-181/182/192 |
| Productos (CRUD admin) | TC-210 | TC-211 | — | — | — |
| Modo compra restringida | TC-212/213/215/216 | TC-216 | TC-215 | TC-214/217 | — |
| Admin principal (owner) | TC-222 | — | — | TC-220/221 | — |
| Catálogo por audiencia (público vs admin) | TC-301/302 | TC-303/305 | TC-304 | TC-301/302 | — |
| Auth 503 AUTH_UNAVAILABLE | — | — | TC-306/308 | TC-307 | — |
| Idempotencia de checkout | TC-309 | TC-310/313/314 | TC-311/312/315/316/317 | — | TC-314 |
| Webhook MP firmado | TC-319 | TC-320 | — | TC-318 | — |
| Datos de orden desde la base / dueño | — | TC-324/332 | — | TC-321/322/323 | TC-331 |
| Login (validación de tipos / fuerza bruta) | — | TC-325/326/327 | — | TC-325/326 | — |
| RLS de ventas (UPDATE por columna) | TC-328 | TC-330 | — | TC-328/329 | — |
| Insights (rango sargable) | — | TC-333 | — | — | — |
| Conciliación MP / mp-cancel / review_reason (2026-10-14) | TC-253/256/262/266 | TC-254/255/258/263/264/270 | TC-257/259/260/261/265/267 | TC-268/269/271 | TC-272/273 |
| Productos: edición optimista y borrado | TC-274 | TC-276 | TC-275/277 | TC-278 | TC-275 |
| Acaparamiento de stock / rate limit por cuenta | — | TC-334/335 | — | TC-334/335/336 | TC-340 |
| Idempotencia entre usuarios | — | — | — | TC-337 | — |
| Devoluciones parciales y auditoría con actor | — | TC-338 | — | TC-343 | — |
| Hardening (logs, /health, MFA opt-in, RLS por rol) | — | TC-344 | — | TC-339/341/342/345 | TC-340 |
| Abuso de solicitudes (ReDoS, timeouts de Auth/Cloudinary, stores acotados, endpoints retirados) | TC-352 | TC-351/353 | TC-350/354/355 | TC-349/351 | — |
| Observabilidad (request-id, latencias, /ready, proceso) | TC-357/358 | TC-357 | TC-358/364 | — | — |
| Resiliencia (carriles, circuito de MP, lecturas con reintento) | TC-361 | TC-362 | TC-359/360/363 | — | TC-359 |
| Endurecimiento de catálogo y tokens | TC-366 | TC-365 | — | TC-365/366 | — |

## Cross-browser / device
Probado en Chrome desktop (Playwright). Pendiente: Safari iOS, Chrome Android
sobre el flujo de checkout completo.

## Hallazgos abiertos
- 🟡 Medio — H-OBJ-LOGIN — `POST /api/auth/login` (`authController.login`) valida solo
  `!email || !password`; con `email` objeto/array, `checkLock` (`email.toLowerCase()`) lanza
  TypeError y la respuesta es 500 en vez de 400. `POST /api/users/login` ya valida con
  `typeof`. Detectado leyendo el código (2026-10-06); sin reproducir. Caso: TC-256.
- 🟢 Menor — H-REL-RATE — Replay de `transfer` con una Idempotency-Key no chequea el estado
  de las órdenes originales (solo `mp-preference` devuelve 409 si ya no están pendientes):
  devuelve los ids originales aunque estén canceladas/expiradas. Comportamiento a confirmar
  con producto (leído en `replayReservation`, 2026-10-06).
- 🟡 Medio — H-DEPLOY-1006 — Hasta aplicar `2026-10-06_idempotency_key.sql` en Supabase, un
  POST con `Idempotency-Key` responde 500 (TC-247). Orden de despliegue en
  `docs/flows/flow-despliegue-produccion.md`. (2026-10-06)
- 🟢 Info — H-WEBHOOK-SECRET — Mientras `MP_WEBHOOK_SECRET` no esté cargada en Render, el
  webhook se acepta sin firma (se revalida el pago contra MP). Pendiente de cargar. (2026-10-06)
- 🟢 Menor — Panel admin Ventas: las tarjetas de stats ("Total ventas", "Pagadas") no
  cuadran con la lista. "Pendientes de pago" sí cuenta bien en vivo (0↔1). No bloqueante.
  (2026-06-14)
- 🟡 Medio — HALLAZGO-006 — `/product/:id` a 375px: botón "Agregar al carrito" truncado
  como "Agregar al car..." en la barra sticky inferior. Los dos botones ("Comprar ahora"
  y "Agregar al carrito") compiten por el ancho. Fix: reducir font-size, abreviar texto
  o apilar en columna a ≤400px. Confirmado en Playwright 2026-07-01.
- 🟡 Medio — HALLAZGO-007 — `/contact`: Cards "Redes Sociales" y "Correo Electrónico"
  sin CTAs funcionales. Iconos TikTok/Facebook decorativos (sin href). Card Correo sin
  mailto ni formulario. "Iniciar Chat" de WhatsApp sí funciona. (2026-07-01)
- 🟡 Medio — HALLAZGO-008 — `AdminRedirect` redirige al admin fuera de rutas públicas,
  bloqueando pruebas de UI de checkout/productos como admin. No bloqueante para producción.
  Workaround: usar cuenta de usuario regular para tests de UI. (2026-07-01)

## Stock de zapatos (id=14) al cerrar sesión 2026-07-01
- Inicio sesión: 10
- TC-169 "Test QA Transfer" creado → trigger → 9
- TC-170 confirmar → sin cambio (stock: 9)
- TC-171 "Test QA Cancel" creado → trigger → 8
- TC-171 cancelar → restaurado → 9
- **Stock final: 9**

### Stock por talle y conciliación de pagos MP (2026-10-13)
Pre-condición: migración `2026-10-13_payment_reconciliation_and_schema_hardening.sql` aplicada. Tests automáticos: `node --test qa/unit/*.test.js` (ok, 20/20).

ID: TC-240 — Caso: talle agotado con stock total disponible. Tipo: failure (regresión DATA-004). Pre: producto con Talle M=1, L=3 (stock 4). Pasos: comprar 2 unidades de M (`mp-preference`). Esperado: 409 "No hay stock suficiente del talle M…"; nada se persiste. Resultado: no probado (solo unit test de `validateSizeStock`).
ID: TC-241 — Caso: la compra descuenta total y talle. Tipo: happy. Pasos: comprar 1 M y 1 L. Esperado: `productos.stock` 4→2 (una sola vez) y `variants` Talle M=0, L=2. Resultado: no probado.
ID: TC-242 — Caso: cancelar / expirar devuelve el talle. Tipo: happy. Pasos: cancelar la orden de TC-241 (y repetir dejándola expirar). Esperado: stock 4 y M=1, L=3, sin doble restauración. Resultado: no probado.
ID: TC-243 — Caso: unidad sin talle. Tipo: edge. Pasos: `mp-preference` con `unitsConfig` vacío para un producto con stock por talle. Esperado: 400 "Elegí el talle de cada unidad…". Resultado: no probado.
ID: TC-244 — Caso: sweep con pago en curso. Tipo: failure. Pasos: pago con ticket (queda `pending`), esperar >15 min. Esperado: la orden sigue `pendiente`, el stock retenido, log `orders_sweep` con `heldMp`; pasadas 72 h expira. Resultado: no probado.
ID: TC-245 — Caso: sweep con pago aprobado sobre el plazo. Tipo: edge. Pasos: aprobar el pago sandbox sin que llegue el webhook ni `mp-confirm`, esperar >15 min. Esperado: el sweep la pasa a `pagado` con `mp_payment_id`; no queda `expirado`. Resultado: no probado.
ID: TC-246 — Caso: sweep sin pagos. Tipo: happy. Pasos: crear preferencia y no pagar, esperar >15 min. Esperado: `expirado` + stock restaurado. Resultado: no probado.
ID: TC-247 — Caso: cancelar mientras MP procesa el pago. Tipo: security/failure. Pasos: pago `in_process` y `POST /:id/cancel`. Esperado: 200 `{ released: false }`, orden `pendiente`, stock intacto; con pago aprobado → 409 y orden `pagado`. Resultado: no probado.
ID: TC-248 — Caso: pago tardío con stock. Tipo: edge. Pasos: orden `expirado`, luego `mp-confirm` aprobado con stock disponible. Esperado: `pagado`, stock descontado exacto (sin clamp) y talle descontado. Resultado: no probado.
ID: TC-249 — Caso: pago tardío sin stock. Tipo: failure (DATA-001). Pasos: orden `expirado`, otro comprador se lleva la última unidad, luego `mp-confirm` aprobado. Esperado: `pagado` con `oversold = true`, stock sin tocar, log `oversold_late_payment`, etiqueta "Sin stock: reembolsar" en el panel Ventas. Resultado: no probado.
ID: TC-250 — Caso: doble pago de la misma compra. Tipo: failure. Pasos: confirmar dos `payment_id` aprobados distintos para las mismas ventas. Esperado: la venta conserva el primero y se loguea `duplicate_approved_payment`. Resultado: no probado.
ID: TC-251 — Caso: migración sin aplicar. Tipo: failure. Pasos: arrancar el backend contra una base sin las columnas nuevas. Esperado: log `missing_migration` con las columnas faltantes. Resultado: no probado.
ID: TC-252 — Caso: CHECK de estados. Tipo: security. Pasos: intentar `UPDATE ventas SET payment_status = 'x'` en una transacción con ROLLBACK. Esperado: error de `ventas_payment_status_check`. Resultado: no probado.

### Conciliación MP, mp-cancel, review_reason, confirmación tardía y edición optimista (2026-10-14)

Pre-condiciones comunes: migración `2026-10-14_add_review_reason_to_ventas.sql` aplicada; backend con
`MP_ACCESS_TOKEN` de sandbox; usuario del sitio logueado. Probar escrituras de stock dentro de una
transacción con ROLLBACK cuando no haga falta el flujo completo. Unit tests: `node --test qa/unit/*.test.js`
(57/57 ok al 2026-10-12).

ID: TC-253 — Caso: preferencia con id de compra. Tipo: happy. Pasos: crear `mp-preference` con 3 productos; mirar la preferencia en MP y `ventas`. Esperado: `external_reference` = un uuid (≤ 256 caracteres) igual a `ventas.mp_external_reference` de las 3 líneas; `mp_preference_id` guardado. Resultado: ok (unit test del payload); flujo real no probado.
ID: TC-254 — Caso: carrito grande. Tipo: edge. Pasos: carrito con 40 líneas. Esperado: la preferencia se crea (antes la lista de ids superaba 256 caracteres). Resultado: no probado.
ID: TC-255 — Caso: medios diferidos excluidos. Tipo: edge. Pasos: abrir el checkout de MP. Esperado: no aparecen Rapipago / Pago Fácil / cajero. Resultado: ok (unit test del payload); visual no probado.
ID: TC-256 — Caso: `mp-cancel` sin pago. Tipo: happy. Pasos: crear preferencia, volver con failure; el front llama `POST /api/orders/mp-cancel { orderIds }`. Esperado: `200 { outcome: 'released' }`, ventas `cancelado`, stock total y talle restaurados una vez. Resultado: no probado.
ID: TC-257 — Caso: `mp-cancel` con pago en curso o MP caído. Tipo: failure. Pasos: pago `in_process` (o MP sin responder) y `mp-cancel`. Esperado: `200 { outcome: 'held' }`, ventas `pendiente`, stock intacto; ninguna conexión del pool retenida durante la consulta (`/health` → `pool.waiting` 0). Resultado: no probado.
ID: TC-258 — Caso: `mp-cancel` con pago aprobado. Tipo: edge. Pasos: aprobar el pago sin `mp-confirm` ni webhook y llamar `mp-cancel`. Esperado: `200 { outcome: 'paid' }`, ventas `pagado` con `mp_payment_id`. Resultado: no probado.
ID: TC-259 — Caso: `mp-cancel` body inválido. Tipo: failure. Pasos: `orderIds` ausente, `[]`, 51 ids, un id `"1"`. Esperado: `400 { code: 'INVALID_ORDER_IDS' }`. Resultado: no probado.
ID: TC-260 — Caso: id de orden no uuid. Tipo: failure. Pasos: `POST /api/orders/abc/cancel`, `PATCH /api/orders/1/confirm-transfer`. Esperado: `400 { code: 'INVALID_ORDER_ID' }`, nunca 500. Resultado: ok (unit test de `isUuid`); endpoint no probado.
ID: TC-261 — Caso: errores de stock con `code`. Tipo: failure. Pasos: comprar más que el stock; talle agotado; talle borrado por el admin; unidad sin talle; color inexistente; `productId: "abc"`. Esperado: `OUT_OF_STOCK` 409, `SIZE_OUT_OF_STOCK` 409 (+`size`), `SIZE_UNAVAILABLE` 409 (+`size`), `SIZE_REQUIRED` 400, `INVALID_VARIANT` 400, `INVALID_PRODUCT_ID` 400; todos con `productId` y el mensaje humano; con `Idempotency-Key`, el reintento vuelve a ejecutarse. Resultado: ok (unit tests de `evaluateLine`); endpoint no probado.
ID: TC-262 — Caso: nombre/imagen desde la base. Tipo: happy. Pasos: `mp-preference` con `productName: "X"` y `productImage` de otro dominio. Esperado: `ventas.product_name`/`product_image` y el ítem de MP con el nombre y la primera imagen reales. Resultado: ok (unit test); endpoint no probado.
ID: TC-263 — Caso: email del comprador desde la sesión. Tipo: edge. Pasos: `transfer` con `buyerEmail` distinto al del usuario logueado. Esperado: `ventas.buyer_email` = email de la sesión; la compra aparece en "Mis compras". Resultado: no probado.
ID: TC-264 — Caso: monto no coincide. Tipo: edge. Pasos: pago aprobado con `transaction_amount` distinto (o no numérico). Esperado: `mp-confirm` 409 `AMOUNT_MISMATCH`; ventas no pagadas con `review_reason='amount_mismatch'`; log `payment_amount_mismatch`; el sweep no vuelve a consultar MP y las expira recién pasadas 24 h. Resultado: ok (unit tests de settle y sweep); flujo no probado.
ID: TC-265 — Caso: reembolso / contracargo por webhook. Tipo: failure. Pasos: reembolsar en MP un pago que saldó ventas. Esperado: webhook 200; ventas `pagado` con `review_reason='refunded'` (o `charged_back`), stock y estado sin cambios; log `payment_reversed`. Resultado: ok (unit test); flujo no probado.
ID: TC-266 — Caso: confirmación tardía de transferencia con stock. Tipo: happy. Pasos: transferencia `expirado`, `PATCH /:id/confirm-late-transfer` (admin). Esperado: `200 { oversold: false }`, `pagado`, stock total y talle descontados una vez, `cancelled_at` sin cambios, `paid_at` seteado. Resultado: no probado.
ID: TC-267 — Caso: confirmación tardía sin stock / estado incorrecto. Tipo: failure. Pasos: la unidad se vendió a otro y luego confirm-late; repetir sobre una transferencia `pendiente` y sobre una orden MP; repetir con usuario no admin. Esperado: `200 { oversold: true }` sin tocar stock; `409 ORDER_NOT_EXPIRED`; `409 NOT_A_TRANSFER`; 403. Resultado: no probado.
ID: TC-268 — Caso: `mp-cancel` con una orden ajena. Tipo: security. Pasos: mezclar una venta propia y una de otro usuario. Esperado: `403 { code: 'FORBIDDEN' }` y ninguna venta cambia. Resultado: ok (unit test con modelo stubeado); endpoint no probado.
ID: TC-269 — Caso: cobro duplicado. Tipo: security. Pasos: confirmar un segundo `payment_id` aprobado sobre ventas ya pagadas. Esperado: conservan el primer `mp_payment_id`, `review_reason='duplicate_payment'`, log `duplicate_approved_payment`. Resultado: no probado.
ID: TC-270 — Caso: conciliación de compras cerradas. Tipo: edge. Pasos: dejar expirar una compra MP, aprobar el pago sin webhook, esperar hasta 15 min. Esperado: log `closed_order_reconciled`, ventas `pagado` (stock re-descontado u `oversold`). Resultado: no probado.
ID: TC-271 — Caso: pago tardío de producto borrado. Tipo: security/failure. Pasos: venta `expirado` cuyo producto se borró; pago aprobado. Esperado: `pagado` con `oversold = true`, log `late_payment_without_stock_control`. Resultado: no probado.
ID: TC-272 — Caso: carritos cruzados sin deadlock. Tipo: concurrencia. Pasos: dos compras simultáneas con productos [A, B] y [B, A]. Esperado: ninguna falla por deadlock (40P01); una gana el último ítem y la otra recibe 409. Resultado: ok (unit test del orden de bloqueo); concurrencia real no probada.
ID: TC-273 — Caso: sweep con muchas retenidas. Tipo: concurrencia. Pasos: 15 compras con pago en curso vencidas. Esperado: por ciclo hasta 10 consultas, 4 en paralelo, ciclo < 60 s; una retenida no se reconsulta antes de 5 min y todas rotan; un error en una compra no frena las demás ni las transferencias. Resultado: ok (unit tests de rotación y concurrencia); real no probado.
ID: TC-274 — Caso: edición con `expectedUpdatedAt` vigente. Tipo: happy. Pasos: leer el producto, `PUT` con el `updated_at` leído. Esperado: 200 y `updated_at` nuevo. Resultado: ok (unit test del UPDATE); endpoint no probado.
ID: TC-275 — Caso: el producto cambió mientras se editaba. Tipo: failure/concurrencia. Pasos: leer `updated_at`, comprar 1 unidad, `PUT` con el valor viejo. Esperado: `409 PRODUCT_CHANGED` con el mensaje "El producto cambió desde que lo abriste…", nada modificado. Resultado: no probado.
ID: TC-276 — Caso: `PUT` sin `stock`. Tipo: edge. Pasos: editar solo el nombre de un producto con stock por talle. Esperado: la columna `stock` no se escribe. Resultado: ok (unit test); endpoint no probado.
ID: TC-277 — Caso: borrar producto con ventas pendientes. Tipo: failure. Pasos: reserva pendiente del producto; `DELETE /api/products/:id`. Esperado: `409 PRODUCT_HAS_PENDING_ORDERS`, producto e imagen intactos. Resultado: no probado.
ID: TC-278 — Caso: ids de producto y fecha inválidos. Tipo: security. Pasos: `GET /api/products/abc`; `PUT` con `expectedUpdatedAt: "2026-13-45T00:00:00Z"` o `"x"`. Esperado: `400 INVALID_PRODUCT_ID`; `400 VALIDATION_ERROR`; nunca 500. Resultado: no probado.
ID: TC-279 — Caso: transferencia con comprobante avisado aparece en "Mis compras" como pendiente. Tipo: happy. Pasos: checkout por transferencia → nudge "Sí, ya envié el comprobante" → abrir Mis compras. Esperado: la compra se lista con "Verificando tu comprobante" y sin seguimiento de despacho. Resultado: no probado.
ID: TC-280 — Caso: el admin resuelve la transferencia avisada. Tipo: happy. Pasos: con la compra de TC-279, el admin la confirma / (otra) la cancela; el usuario reabre Mis compras o espera el refresco de 20 s. Esperado: confirmada → "Pagado" + seguimiento de despacho; cancelada → "Pedido cancelado". Resultado: no probado.
ID: TC-281 — Caso: transferencia sin comprobante avisado no se lista. Tipo: edge. Pasos: nudge "Todavía no lo envié" o cerrar el modal sin responder; abrir Mis compras. Esperado: la compra NO aparece (origin distinto de `wa_confirmado`, sigue `pendiente`). Resultado: no probado.

ID: TC-349 — Caso: endpoints públicos retirados. Tipo: security. Pasos: `POST /api/users/login`, `GET /api/users/signup-status/a%40b.co`, `POST /api/users/signup-ratelimit`. Esperado: 404 en los tres y ninguna llamada a Supabase. Resultado: ok (2026-10-21, `test/http-security.test.js`, automatizado).
ID: TC-350 — Caso: Supabase Auth colgado en login / refresh / forgot-password / resend-confirmation. Tipo: failure. Pasos: simular timeout de Supabase Auth (el doble de `fetch` lanza `TimeoutError`). Esperado: 503 `AUTH_UNAVAILABLE` con `Retry-After`; en refresh la cookie NO se borra; toda llamada a Supabase lleva `signal`. Resultado: ok (2026-10-21, `test/http-security.test.js`, automatizado). Pendiente: probar en staging con latencia real.
ID: TC-351 — Caso: ReDoS en el email. Tipo: security/edge. Pasos: `POST /api/auth/forgot-password` y `/resend-confirmation` con `a@` + 250.000 puntos; `POST /api/auth/login` con email de 300 caracteres; emails de exactamente 254 y 255 caracteres. Esperado: 400 en < 500 ms (nunca bloquea el event loop); 254 válido, 255 inválido. Resultado: ok (2026-10-21, `test/http-security.test.js` y `qa/unit/abuseProtection.test.js`, automatizado).
ID: TC-352 — Caso: happy path de recuperación de contraseña y login tras el cambio de validación. Tipo: happy. Pasos: pedir recuperación con un email normal (`nombre+tag@dominio.com.ar`); iniciar sesión con credenciales correctas. Esperado: 200 uniforme en recuperación; login 200 con cookie httpOnly. Resultado: ok en automatizado (2026-10-21); prueba manual en el front: no probado.
ID: TC-353 — Caso: body mayor al tope en `/api/auth/*`. Tipo: edge. Pasos: `POST /api/auth/login` con un body de 20 kB; el mismo body en otra ruta de la API. Esperado: 413 `PAYLOAD_TOO_LARGE` en auth; el resto de la API sigue aceptando hasta 256 kB. Resultado: ok sobre Express aislado (2026-10-21, 413 / 200); no probado contra `server.js` levantado.
ID: TC-354 — Caso: Cloudinary lento o con respuesta enorme. Tipo: failure. Pasos: borrar imagen / listar carpetas con Cloudinary sin responder > 8 s, o respondiendo > 5 MB. Esperado: 502 `CLOUDINARY_ERROR` sin colgar el slot; la request lleva `AbortSignal`. Resultado: ok en unit (2026-10-21, `qa/unit/abuseProtection.test.js`, con doble de `https`); no probado contra Cloudinary real. Verificar manualmente que el gestor de imágenes del admin sigue listando, creando y borrando carpetas e imágenes.
ID: TC-355 — Caso: stores de seguridad en memoria acotados. Tipo: security. Pasos: superar el tope de entradas (10.000) en `loginBruteforce` / `emailActionLimiter`; esperar la purga. Esperado: el tamaño no supera el tope y las entradas vencidas se purgan. Resultado: ok en unit (2026-10-21, `boundedStore`); no probado con 10.000 emails reales.
ID: TC-356 — Caso: timeout global por request. Tipo: failure. Pasos: handler que no responde en 25 s bajo `/api/products`, `/api/auth`, etc. Esperado: 503 `REQUEST_TIMEOUT` con `Retry-After`; `/api/orders` no lo aplica. Resultado: ok en unit con plazo corto (2026-10-21); no probado a 25 s reales.

ID: TC-357 — Caso: id de correlación y métricas por ruta. Tipo: happy/edge. Pasos: cualquier request a la API (con y sin `X-Request-Id` entrante; probar uno con saltos de línea); leer `GET /health` con `x-health-token`. Esperado: la respuesta trae `X-Request-Id` (se respeta solo un id de 8-64 caracteres seguros); `requests.routes` lista `METHOD /ruta/:param` con p50/p95/p99 y conteos por clase; `/health` y `/ready` no se miden; las rutas inexistentes se agrupan en `unmatched`. Resultado: ok en unit y con `server.js` real y base simulada (2026-10-21); no probado contra la base real.
ID: TC-358 — Caso: readiness. Tipo: happy/failure. Pasos: `GET /ready` con la base sana; con la base caída o el pool agotado; ráfaga de 50 requests a `/ready`. Esperado: `200 READY`; `503 NOT_READY` en menos de ~2 s; la ráfaga no genera un `SELECT 1` por request (resultado memorizado 3 s); sin token solo se ve `status`. Resultado: ok en unit y smoke con base simulada (2026-10-21); no probado con la base caída real.
ID: TC-359 — Caso: aislamiento de carriles del bulkhead. Tipo: failure/concurrencia. Pasos: saturar el carril de checkout (slots + cola) mientras se pide el catálogo y se envía un webhook de MP. Esperado: el checkout excedente recibe `503 SERVER_BUSY` con `Retry-After`; el catálogo y el webhook responden 200. Resultado: ok en `qa/unit/lanesHttp.test.js` con topes chicos (2026-10-21); no probado con los topes reales bajo carga (ver `qa/k6/`).
ID: TC-360 — Caso: Mercado Pago caído (circuit breaker). Tipo: failure. Pasos: 5 fallas seguidas de MP (timeout, 503 o corte de red); luego `POST /api/orders/mp-preference`; esperar 30 s y repetir con MP sano. Esperado: con el circuito abierto `502 MP_UNAVAILABLE` sin crear ventas ni tocar stock (verificar en `ventas`/`productos`); la transferencia sigue funcionando; pasados 30 s una sola request de prueba decide si se cierra; `GET /health` muestra `mercadopago.circuit`. Resultado: ok en `qa/unit/mpCircuit.test.js` y `resilience.test.js` con MP simulado (2026-10-21); no probado contra el sandbox de MP.
ID: TC-361 — Caso: lecturas a MP con reintento. Tipo: edge. Pasos: `mp-confirm` y webhook con MP respondiendo 503 una vez y luego 200; con 404; con timeout. Esperado: el 503 aislado se reintenta una vez y el pago se salda; el 404 no se reintenta ni abre el circuito; el timeout no se reintenta (`502 PAYMENT_VERIFICATION_FAILED`); crear la preferencia nunca se reintenta. Resultado: ok en unit (2026-10-21); no probado contra el sandbox de MP.
ID: TC-362 — Caso: sweep con el circuito abierto. Tipo: failure. Pasos: compra MP vencida y pendiente mientras el circuito de MP está abierto. Esperado: la consulta se trata como `unknown` y NO se libera el stock; se reevalúa cuando MP responde. Resultado: no probado (el sweep ya trataba el error de MP como `unknown`; falta verificar que `CIRCUIT_OPEN` siga ese camino).
ID: TC-363 — Caso: caída del proceso. Tipo: failure. Pasos: provocar una excepción síncrona sin capturar en staging. Esperado: log `uncaught_exception` y cierre ordenado con código 1 (la plataforma reinicia); `unhandledRejection` solo se cuenta y se loguea. Resultado: no probado.
ID: TC-364 — Caso: arranque con la base caída o con el pooler lleno durante un deploy. Tipo: failure. Pasos: arrancar el servicio con la base inaccesible; luego durante un deploy con solape de instancias. Esperado: 5 intentos con espera creciente (2, 4, 8, 10 s con jitter) y logs `db_connect_failed` sin host ni usuario; el proceso sale con código 1 solo si se agotan. Resultado: ok solo el cálculo de la espera (unit, 2026-10-21); no probado contra la base real.
ID: TC-365 — Caso: abuso del catálogo. Tipo: security/edge. Pasos: `GET /api/products?offset=999999999999`; 1000 ids inexistentes distintos; mismo id inexistente dos veces. Esperado: el offset se acota a 10000; los ids inexistentes se recuerdan aparte (la segunda consulta no llega a la base) y no expulsan la caché del catálogo. Resultado: ok en `qa/unit/catalogAbuse.test.js` (2026-10-21).
ID: TC-366 — Caso: tokens inservibles y token válido. Tipo: security/happy. Pasos: request autenticada con un token de más de 4096 caracteres; con un JWT vencido; con un token vigente. Esperado: los dos primeros dan 401 (o siguen como anónimos en rutas con `optionalAuth`) sin ninguna llamada a Supabase Auth; el vigente se verifica normalmente. Resultado: ok en unit para la detección (2026-10-21); no probado el flujo completo con Supabase real. Limitación: un JWT vigente pero falso igual se consulta (la defensa de fondo es el rate limit).
ID: TC-367 — Caso: scripts de carga. Tipo: performance. Pasos: ejecutar `qa/k6/` en staging (smoke → load → stress → spike → soak; `last-unit.js`). Esperado: métricas objetivo del informe (p95 < 300 ms en lecturas, 0 sobreventa, sin 5xx fuera de 503 controlados). Resultado: no probado (no hay staging; scripts con la sintaxis verificada, no ejecutados).

Pasada manual 2026-10-22 (servidor real `server.js` por HTTP, con la BASE simulada; Supabase Auth, Cloudinary y Mercado Pago reales). La base real NO se pudo usar: el `DB_PASSWORD` del `.env` local es rechazado por Supabase (`28P01`).
ID: TC-349 — Resultado manual: ok. `POST /api/users/login`, `GET /api/users/signup-status/:email` y `POST /api/users/signup-ratelimit` responden 404; `GET /api/users` sin token sigue en 401.
ID: TC-350 — Resultado manual: ok. Con Supabase Auth colgado, login, refresh, forgot-password y resend-confirmation responden 503 `AUTH_UNAVAILABLE` con `Retry-After: 2` a los 5,0 s; el refresh no borra la cookie; el catálogo responde en 4 ms durante el cuelgue.
ID: TC-351 — Resultado manual: ok. Email de 7 kB -> 400 (forgot-password y resend); 250 kB en `/api/auth/*` -> 413 en 7 ms; email de 255 caracteres -> 400; el mismo body de 250 kB en otra ruta (límite 256 kB) llega a auth y responde 401.
ID: TC-352 — Resultado manual: ok el login real de punta a punta (200, cookie `HttpOnly`, refresh token ausente del body, refresh 200, logout 200 con cookie vencida, refresh posterior 401, contraseña incorrecta 401 genérico, token alterado 401, token de usuario común en ruta admin 403). Pendiente: probarlo desde el front y con la base real.
ID: TC-354 — Resultado manual: ok contra Cloudinary REAL con el cliente nuevo (solo lecturas y un borrado de id inexistente): `/config` 200, `/usage` 200, `/folders` 200, `/images` 200 (65 recursos), `/folders?path=../x` 400, `/sign` 200 (SHA1 de 40 hex), `/delete` de un id inexistente 200 `not_found`, sin token 401. Pendiente: crear/borrar carpeta e imagen reales desde el admin.
ID: TC-357 — Resultado manual: ok. `X-Request-Id` generado, respetado si es seguro (`mi-prueba-12345`) y reemplazado si trae espacios o caracteres raros; `/health` muestra p50/p95/p99 por ruta y los 5 carriles.
ID: TC-358 — Resultado manual: ok `/ready` con la base simulada sana (200 `READY`). No probado con la base caída.
ID: TC-361 — Resultado manual: parcial. Un 4xx REAL de Mercado Pago (`mp-confirm` con un pago inexistente) no se reintenta (0,75 s) y el circuito sigue `closed`. Limitación: el `MP_ACCESS_TOKEN` del `.env` local no autentica contra MP ("Must provide your access_token"), así que no se probó una lectura exitosa ni un 5xx real.
ID: TC-360 — Resultado manual: no probado (requiere editar `hosts` del sistema para cortar `api.mercadopago.com`).
ID: TC-365 — Resultado manual: ok. `offset=999999999999` devuelve `offset: 10000`; un id inexistente consultado dos veces queda en `productMisses` (size 1) sin ensuciar `products`.
ID: TC-366 — Resultado manual: ok con Supabase Auth colgado. JWT vencido -> 401 en 10 ms y token de 5000 caracteres -> 401 en 2 ms, ambos sin llamar a Auth; un JWT vigente (falso) sí intenta la verificación (503 por no poder conectar).
Hallazgo de la pasada (corregido): todo 503 de degradación controlada se logueaba además como `request_failed` en nivel error, duplicando líneas bajo un pico y ensuciando las alertas. Ahora el observer no lo loguea como error (cada causa ya se loguea donde ocurre) y sigue contando en las métricas.
Diagnóstico de proxy (A6): ok. `proxy_diagnostic` se loguea una sola vez por request con `X-Forwarded-For`, con `forwardedForHops: 2`, la IP enmascarada (`10.0.x.x`) y `reqIpIsRightmostHop: true`.

Pasada manual 2026-10-23 (backend `server.js` REAL contra la base real; barrido de órdenes vencidas desactivado en el proceso de prueba; Mercado Pago NO utilizable: el `MP_ACCESS_TOKEN` local no autentica).
ID: TC-352 — Resultado manual (base real): ok. Login de usuario común, de admin y de una cuenta habilitada para comprar (rol real leído de la base); `/api/users`, `/api/cloudinary/usage` y `/api/admin/insights/*` -> 403 para usuario común y 200 para admin; "Mis compras" propias 200, de otro email 403, sin token 401.
ID: TC-358 — Resultado manual (base real): ok. `/ready` 200 con la base real (172 ms).
ID: TC-365 — Resultado manual (base real): ok. `offset=999999999999` devuelve `offset: 10000` (total 20); un id inexistente tarda 175 ms la primera vez y 2 ms la segunda; id no numérico 400.
ID: TC-359 — Resultado manual: parcial. Con la base real, cada carril cuenta su propio tráfico en `/health` (read, auth, checkout, admin, webhook) sin rechazos. No se saturó ningún carril con carga real.
ID: TC-368 — Caso: ciclo de checkout por transferencia con la base real y limpieza. Tipo: happy/security/concurrencia. Pasos: reservar 1 unidad del producto 15 con la cuenta habilitada; repetir con la misma `Idempotency-Key`; repetir la key con otro carrito; revisar "Mis compras"; cancelar-transferencia como usuario común y como admin; repetir la cancelación. Esperado: 201 y stock -1; replay 201 con las mismas órdenes y sin descontar de nuevo; 422 `IDEMPOTENCY_KEY_REUSED`; la compra sin comprobante no aparece; 403 / 200 / 409; stock restaurado. Resultado: ok (2026-10-23), stock final = stock inicial. Nota: con el modo de compra restringida activo, las cuentas sin habilitar reciben 403 `PURCHASES_DISABLED` (también verificado).
ID: TC-369 — Caso: doble envío simultáneo sin `Idempotency-Key`. Tipo: concurrencia. Esperado: una sola orden (single-flight por carrito). Resultado: ok en 1 de 2 corridas (misma `order_id` en ambas respuestas); en la otra se crearon 2 órdenes, probablemente porque las requests no se solaparon en el servidor (no se midió el solapamiento). Pendiente: repetir con una barrera que garantice el solape. El single-flight no fue modificado en esta tanda.
ID: TC-370 — Caso: Mercado Pago no disponible durante la creación de la preferencia. Tipo: failure. Esperado: `502 MP_UNAVAILABLE`, stock restaurado, circuito sin abrirse con un 4xx. Resultado: ok (2026-10-23) con el token local inválido (401 de MP): reserva compensada y circuito `closed`. Un segundo intento inmediato recibió 429 `RATE_LIMITED` (límite de 8 compras por minuto por usuario), como corresponde.
ID: TC-371 — Caso: webhook de MP. Tipo: edge/failure. Resultado: ok. Tópico no relevante 200; id de pago no numérico 200 (nada que reintentar); pago `1` con el token local inválido 500 `WEBHOOK_FAILED` (MP reintenta).
ID: TC-372 — Caso: CRUD de producto de prueba con un asset real de Cloudinary. Tipo: happy. Pasos: firmar (`/sign`), subir una imagen de 1x1 a la carpeta `qa-tanda2`, crear el producto inactivo, verlo como admin (200) y como público (404), editarlo, borrarlo. Resultado: ok salvo el último punto: el asset de Cloudinary NO se borró al eliminar el producto (ver H-CLD-DESTROY). Se limpió a mano; la carpeta `qa-tanda2` quedó vacía.
ID: TC-373 — Caso: borrar un producto cuya imagen NO usa nada más. Tipo: happy. Pasos: subir imagen de prueba, crear producto inactivo, borrarlo. Esperado: el asset desaparece de Cloudinary. Resultado: ok (2026-10-26, `qa/e2e-cloudinary-lock.js`: producto con asset real de Cloudinary, borrado por endpoint, asset eliminado).
ID: TC-374 — Caso: borrar un producto cuya imagen usa también un slide del carrusel (o `site_content`). Tipo: edge. Pasos: crear producto con imagen X, agregar X al carrusel, borrar el producto. Esperado: el asset sigue en Cloudinary y el log tiene `cloudinary_asset_in_use`. Resultado: ok (2026-10-26, `qa/e2e-cloudinary-lock.js`): la imagen se conserva si la usa el carrusel, `site_content` u otro producto, y se borra al eliminar el último que la usa.
ID: TC-375 — Caso: con el script `2026-10-23_stock_trigger_fail_loud.sql` aplicado, un INSERT en `ventas` por más stock del disponible falla. Tipo: failure. Pasos: en una transacción con ROLLBACK, aplicar el script y descontar `stock + 1` a un producto. Esperado: error 23514 (`productos_stock_non_negative`). Resultado: ok (UPDATE directo, 2026-10-23); el INSERT real en `ventas` y el ciclo completo de compra: no probado.
ID: TC-376 — Caso: lock del producto retenido por otra transacción durante una reserva. Tipo: failure/concurrencia. Pasos: transacción A hace `SELECT … FOR UPDATE` del producto; transacción B con `lock_timeout` 500 ms pide el mismo lock. Esperado: B falla con 55P03 en ~0,5 s. Resultado: ok a nivel base (676 ms) y por HTTP (2026-10-26, `qa/e2e-cloudinary-lock.js`, `RESERVE_LOCK_TIMEOUT_MS=300`): 503 `ORDER_BUSY`, sin orden creada, stock intacto; liberado el bloqueo la compra pasa (201).
ID: TC-377 — Caso: editar stock o variants sin `expectedUpdatedAt`. Tipo: failure/security. Pasos: `PUT /api/products/:id` como admin con `{ stock: 3 }` y sin `expectedUpdatedAt`. Esperado: 400 `VALIDATION_ERROR`, nada se modifica; con `expectedUpdatedAt` vigente → 200; editando solo `name` sin él → 200. Resultado: ok por HTTP real (2026-10-26, `qa/e2e-endpoints.js`: sin fecha 400, fecha vieja 409, fecha vigente 200, solo descripción 200); edición desde el panel admin: no probado.
ID: TC-399 — Caso: `TRUST_PROXY_HOPS=3` en Render (Cloudflare + proxies internos). Tipo: security/config. Pasos: setear la variable, reiniciar, abrir el sitio y mirar los 3 logs `proxy_diagnostic`. Esperado: `reqIp` es una IP pública (no `10.x`), `reqIpIsLeftmostHop: true`, `trustProxy: 3`; dos personas con IP distinta no comparten cupo (429 de una no afecta a la otra). Resultado: ok (2026-10-26, Render): tras cargar `TRUST_PROXY_HOPS=3` como variable de entorno (no como Secret File) y desplegar, `proxy_diagnostic` mostró `trustProxy: 3`, `reqIp` pública y `reqIpIsLeftmostHop: true`. Nota: Render despliega desde el remoto `lia-back`.
ID: TC-378b — Caso: ciclo de transferencia + carrera por el último ítem por HTTP (`qa/e2e-endpoints.js`, 2026-10-26). Tipo: happy/concurrencia. Resultado: ok 14/14: compra descuenta 1 vez, cancelar y confirmar correctos, doble submit idéntico = 1 orden, 6 compras simultáneas del último ítem = 1 gana y 5 reciben 409, stock nunca negativo (trigger sin GREATEST), limpieza completa. Cubre TC-375 por endpoints; `qa/concurrency-stock-test.js` sigue sin correr. TC-376 (503 ORDER_BUSY): ok, ver su caso.

ID: TC-378 — Caso: índices trigram. Tipo: happy. Pasos: aplicar `2026-10-24_trigram_search_indexes.sql`; con `SET enable_seqscan = off` hacer `EXPLAIN` de `buyer_email ILIKE '%juan%'` en `ventas`. Esperado: Bitmap Index Scan sobre `idx_ventas_buyer_email_trgm`; el buscador del catálogo y del panel de ventas devuelven lo mismo que antes. Resultado: no probado.
ID: TC-379 — Caso: audit_log con payload acotado y purga. Tipo: happy/failure. Pasos: aplicar `2026-10-24_audit_log_index_and_retention.sql`; cambiar el precio de un producto de prueba desde el panel; `SELECT old_data, new_data FROM audit_log ORDER BY id DESC LIMIT 1`; luego `SELECT purge_audit_log(interval '10 days')`. Esperado: jsonb solo con id, price, discount, original_price, status y `actor` = uuid del admin; la purga con menos de 30 días falla. Borrar un producto de prueba sigue guardando la fila completa. Resultado: no probado.
ID: TC-380 — Caso: policies con InitPlan y CHECK duplicado. Tipo: regression. Pasos: aplicar `2026-10-24_rls_initplan_and_duplicate_checks.sql`; correr la consulta de VERIFICACION del script; con la cuenta de prueba cargar catálogo, "Mis compras" y el panel admin; con el usuario común intentar editar un producto. Esperado: 0 policies con `auth.uid()` sin envolver; todo carga igual; la edición ajena sigue denegada; `ventas_payment_status_domain` ya no existe. Resultado: no probado.

## Hallazgos abiertos (agregado 2026-10-23)
- ✅ RESUELTO (2026-10-23, verificado por endpoints el 2026-10-26) — H-CLD-DESTROY — `utils/cloudinaryDestroy.js` usaba un endpoint inexistente; ahora usa `DELETE /resources/image/upload` y exige `deleted`. `Product.deleteIfNoPendingOrders` no borra el asset si otro producto, `carousel_images` o `site_content` lo referencian. Casos: TC-372, TC-373, TC-374.

## Validación de datos de usuario (SEC-N10, 2da parte)

ID: TC-VAL-B01 — Caso: `PUT /api/users/:id` con nombre inválido (HTML, 61 caracteres, objeto/array/número). Tipo: security. Esperado: 400 con mensaje de dominio (o genérico para tipos no string), sin `UPDATE` ni detalle interno. Resultado: ok (`test/user-validation.test.js`).
ID: TC-VAL-B02 — Caso: asignación masiva (`is_owner`, `id`, `email` en el body). Tipo: security. Esperado: no llegan al `UPDATE`. Resultado: ok (`test/user-validation.test.js`).
ID: TC-VAL-B03 — Caso: `POST /api/auth/login` con contraseña > 128 caracteres o email/contraseña no string. Tipo: edge. Esperado: 400. Resultado: ok (`test/user-validation.test.js`).
ID: TC-VAL-B04 — Caso: aplicar `2026-10-25_signup_input_validation.sql` y registrar con nombre inválido / celular inválido / nombre válido con tildes. Tipo: security. Esperado: los dos primeros fallan sin crear cuenta; el tercero crea la cuenta y el perfil. Resultado: no probado (script sin aplicar).

## Catálogo de talles (`/api/sizes` + `optionMeta`)

Automatizados: `test/sizes.test.js` y `qa/unit/sizeSchemas.test.js`. Los casos de base real requieren aplicar `db/migrations/2026-10-26_create_talles_catalog.sql`.

ID: TC-381 — Caso: `GET /api/sizes` sin token. Tipo: happy. Esperado: 200 `{ success, data: Size[] }` en camelCase, con activos e inactivos, orden `type, name`, `Cache-Control: public, max-age=30`. Resultado: ok (`test/sizes.test.js`; orden y filas reales sin probar).
ID: TC-382 — Caso: `POST /api/sizes` como admin con `name: " xl "`. Tipo: happy. Esperado: 201 y nombre guardado `XL`. Resultado: ok (`test/sizes.test.js`).
ID: TC-383 — Caso: `POST` y `PUT` sin token / con usuario común. Tipo: security. Esperado: 401 / 403 sin tocar la base. Resultado: ok (`test/sizes.test.js`).
ID: TC-384 — Caso: crear dos veces el mismo `type` + nombre (también "m" y "M"). Tipo: failure. Esperado: 409 `SIZE_DUPLICATE`. Resultado: ok con base simulada (`test/sizes.test.js`); índice único real no probado.
ID: TC-385 — Caso: `PUT /api/sizes/:id` con `{ active: false }` y luego `{ active: true }`. Tipo: happy. Esperado: 200; el talle sigue en `GET` con `active` actualizado. Resultado: ok con base simulada (`test/sizes.test.js`).
ID: TC-386 — Caso: `PUT` con id inexistente, id mal formado y body vacío. Tipo: failure. Esperado: 404 `SIZE_NOT_FOUND`, 400 `INVALID_SIZE_ID`, 400 `NO_FIELDS`. Resultado: ok (`test/sizes.test.js`).
ID: TC-387 — Caso: `DELETE /api/sizes/:id`. Tipo: edge. Esperado: 404, no existe el endpoint. Resultado: ok (`test/sizes.test.js`).
ID: TC-388 — Caso: nombre vacío, de 21 caracteres, tipo desconocido, campos extra (`id`). Tipo: edge. Esperado: 400 `VALIDATION_ERROR` con `details`. Resultado: ok (`qa/unit/sizeSchemas.test.js`).
ID: TC-389 — Caso: medidas con 9 claves, clave de 31 caracteres o vacía, valor de 21 caracteres, valor no string, array. Tipo: edge. Esperado: 400. En el límite exacto (8 / 30 / 20): aceptadas. Resultado: ok (`qa/unit/sizeSchemas.test.js`).
ID: TC-390 — Caso: medidas con clave `__proto__`, `constructor` o `prototype` (talle y `optionMeta.custom`). Tipo: security. Esperado: 400, nada llega a la base. Resultado: ok (`qa/unit/sizeSchemas.test.js`, `test/sizes.test.js`).
ID: TC-391 — Caso: producto con `variants` sin `optionMeta`. Tipo: edge (regresión). Esperado: se aceptan y conservan `name/options/stockByOption/colorsByOption` y cualquier campo extra. Resultado: ok (`qa/unit/sizeSchemas.test.js`).
ID: TC-392 — Caso: `optionMeta` válido (`global` con `sizeId` uuid y `custom` con medidas). Tipo: happy. Esperado: se guarda completo dentro de `variants`; `sizeId` normalizado a minúsculas. Resultado: ok (`qa/unit/sizeSchemas.test.js`, `test/sizes.test.js`).
ID: TC-393 — Caso: `optionMeta` inválido (global sin `sizeId`, sin uuid o con `measurements`; custom con `sizeId`; `source` desconocido; clave que no está en `options`; en variante que no es de talle; campo extra). Tipo: security. Esperado: 400 `VALIDATION_ERROR`. Resultado: ok (`qa/unit/sizeSchemas.test.js`).
ID: TC-394 — Caso: crear producto con `sizeId` global inexistente. Tipo: failure. Esperado: 400 `SIZE_NOT_FOUND`, no se inserta el producto. Resultado: ok (`test/sizes.test.js`).
ID: TC-395 — Caso: producto con varias opciones globales. Tipo: edge. Esperado: una sola query de verificación para todos los `sizeId`. Resultado: ok (`test/sizes.test.js`, `qa/unit/sizeSchemas.test.js` para la deduplicación).
ID: TC-396 — Caso: editar un producto que referencia un talle global desactivado. Tipo: edge. Esperado: 200, no se valida `active`. Resultado: no probado (requiere base real).
ID: TC-397 — Caso: comprar un producto con `optionMeta` y stock por talle. Tipo: regresión. Esperado: el checkout y el descuento por talle no cambian. Resultado: no probado en vivo (`optionMeta` no es leído por `utils/variantStock.js`).
ID: TC-398 — Caso: aplicar el script SQL y, con la anon key y con un token de usuario común / admin, leer `public.talles` vía PostgREST e intentar INSERT/UPDATE/DELETE. Tipo: security. Esperado: lectura permitida; las tres escrituras rechazadas (sin GRANT). Resultado: no probado (script sin aplicar).
ID: TC-399 — Caso: crear talle con `garment` "  Saco Sastrero ". Tipo: happy. Esperado: 201, se guarda "Saco Sastrero" (sin forzar mayúsculas; `name` sí en mayúsculas). Resultado: ok (`test/sizes.test.js`).
ID: TC-400 — Caso: `garment` vacío, solo espacios o `null` al crear. Tipo: edge. Esperado: se guarda `null`. Resultado: ok (`test/sizes.test.js`, `qa/unit/sizeSchemas.test.js`).
ID: TC-401 — Caso: `garment` de 30 y de 31 caracteres, y de tipo no string. Tipo: edge. Esperado: 30 válido; 31 y no string → 400 `VALIDATION_ERROR` sin tocar la base. Resultado: ok (`test/sizes.test.js`, `qa/unit/sizeSchemas.test.js`).
ID: TC-402 — Caso: mismo `type` y `name` con distinta prenda (p. ej. "M" Saco y "M" Camisa). Tipo: edge. Esperado: ambos 201. Resultado: ok con base simulada; con base real: no probado (script SQL sin aplicar).
ID: TC-403 — Caso: repetir `type` + `name` + prenda cambiando mayúsculas ("m" / "SACO" vs "M" / "Saco"). Tipo: failure. Esperado: 409 `SIZE_DUPLICATE`. Resultado: ok con base simulada; con base real: no probado.
ID: TC-404 — Caso: `PUT /api/sizes/:id` con `garment: null` y con `garment: " Saco "`. Tipo: edge. Esperado: null borra la prenda; el texto se guarda recortado. Resultado: ok (`test/sizes.test.js`).
ID: TC-405 — Caso: `GET /api/sizes` con talles con y sin prenda. Tipo: happy. Esperado: cada talle trae `garment` (string o `null`), orden `type`, `garment` (null primero), `name`. Resultado: ok el campo (`test/sizes.test.js`); el orden: no probado (requiere base real).
ID: TC-406 — Caso: aplicar `2026-10-26_add_garment_to_talles.sql` dos veces y con talles ya existentes. Tipo: regresión. Esperado: idempotente; los talles existentes quedan con `garment = null` y sin conflicto de unicidad. Resultado: no probado (script sin aplicar).
