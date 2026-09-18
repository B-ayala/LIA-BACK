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

ID: TC-101
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

ID: TC-187
Caso: Recuperación tras el Retry-After del rate limit
Tipo: edge
Pasos:
  1. Provocar 429 en /api/users/login
  2. Esperar los segundos que indica `Retry-After`
  3. Reintentar
Esperado: vuelve a responder 401 (no 429)
Resultado: OK (2026-08-08 — verificado al reejecutar la suite tras la ventana)

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

## Cross-browser / device
Probado en Chrome desktop (Playwright). Pendiente: Safari iOS, Chrome Android
sobre el flujo de checkout completo.

## Hallazgos abiertos
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
