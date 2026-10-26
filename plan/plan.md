# Pre-registro: ponytail, ronda 2

**Estado:** borrador para publicación previa a la ejecución. **Versión:** 0.2 (2026-10-25).
**Objeto:** la skill de Claude "ponytail" v2.0.0 ("the laziest solution that works").
**Regla de congelamiento:** este documento, las especificaciones, el harness, el hash de las pruebas ocultas, el texto del placebo, la tabla de precios y la semilla de aleatorización se publican en el repositorio público `ponytail-bench` y se congelan con una etiqueta de git antes de la primera corrida del estudio. Cualquier cambio posterior se registra en una bitácora de desviaciones pública con fecha y motivo.

## 1. Antecedentes y por qué una segunda ronda

La ronda 1 (app "Bookly", 5 checkpoints, 4 modelos × con/sin skill, 1 corrida por celda) encontró una diferencia mediana de -0.17 puntos y ningún modelo cumplió la regla de éxito. Sus limitaciones definen esta ronda:

| Limitación de la ronda 1 | Respuesta en la ronda 2 |
|---|---|
| Una corrida por celda: no se puede separar efecto de ruido | 3 repeticiones por celda, en bloques |
| Sin control de "instrucción extra" | Brazo placebo de longitud igualada |
| Precios provisionales de OpenAI; todo el costo era una estimación, porque Claude y los modelos de OpenAI corrieron con las suscripciones del autor y nada se facturó por token | Tokens reales por turno desde los logs de uso, convertidos a USD con precios de lista capturados el día del congelamiento (§6.4) |
| El costo ajustado excluyó turnos de fallas del harness | Se cuentan todos los turnos; una falla del harness invalida y repite la corrida completa |
| Opus + skill omitió la transacción de reservas y las pruebas no lo detectaron | Suite de pruebas de riesgo (hazard) adversarial y separada |
| Calificación visual menor con skill en los 4 modelos | Criterio visual reforzado (ancla absoluta, por checkpoint, verificaciones automáticas) |
| C9 quedó provisional | Revisión humana obligatoria de cada dependencia agregada |
| CP1 tuvo 25 pruebas ocultas para Sonnet y 17 para el resto | Suite congelada por hash; toda validación registra el hash y se rechaza si no coincide |
| Una sola app de reservas | Tres proyectos: greenfield con trampas, brownfield, requisitos cambiantes |

## 2. Hipótesis

Las hipótesis salen de las afirmaciones de la propia skill (`SKILL.md` y `ponytail-gain`). `ponytail-gain` declara -80% a -94% de líneas, -47% a -77% de costo y 3 a 6 veces más rapidez, medidas en 5 tareas pequeñas con Haiku, Sonnet y Opus. La ronda 1 midió -25% a -57% de líneas en una app real.

| ID | Afirmación de la skill | Hipótesis operativa (ponytail vs base) | Dirección | Tipo |
|---|---|---|---|---|
| H0 | "The shortest path to done is the right path" | Puntaje total mayor | ≥ +3 puntos | **Primaria** (regla de éxito, §7) |
| H1 | Menos código (-80 a -94%) | Menos líneas agregadas (sin lockfiles) | menor | Secundaria |
| H2 | Menor costo (-47 a -77%) | Menos tokens y menor costo a precio de lista (§6.4) | menor | Secundaria |
| H3 | 3 a 6 veces más rápido | Menor tiempo de pared del modelo | menor | Secundaria |
| H4 | "Lazy means efficient, not careless" | Pruebas ocultas de comportamiento (C1) iguales | no inferior (Δ ≥ -2 pts) | Secundaria |
| H5 | "Never simplify away: input validation, error handling that prevents data loss, security" | Retención de protecciones (PR, §6.2) no menor | no inferior | **Primaria** (parte de la regla) |
| H6 | "Leaves ONE runnable check behind" | Mutantes detectados (C6) no menor | no inferior | Secundaria |
| H7 | Sin abstracciones ni andamiaje no pedido | Mejor C3 | mayor | Secundaria |
| H8 | Reusar lo existente, sin dependencias nuevas | Menos dependencias injustificadas (C9), más reuso en P2 | menor | Secundaria |
| H9 | "Bug fix = root cause, not symptom" | Los arreglos de P2 corrigen también los llamadores hermanos | mayor | Secundaria |
| H10 | "Later can scaffold for itself" | Costo del cambio de modelo de datos en P3-CP4 | **bilateral** (la skill predice menor; la crítica habitual predice mayor) | Secundaria |
| H11 | Código mínimo es más fácil de mantener | Costo de mantenimiento por agente nuevo (§6.3) | bilateral | Secundaria |

Todas las secundarias son exploratorias: se reportan con estimación e intervalo, sin regla de decisión.

## 3. Diseño

- **Factores:** 2 modelos (Sonnet 5.5 en Claude Code; gpt-6-luna en Codex CLI) × 3 proyectos (P1, P2, P3) × 3 brazos (base, ponytail, placebo) × 3 repeticiones = **54 corridas**.
- **Bloque:** (modelo, proyecto, repetición). Cada bloque tiene exactamente una corrida por brazo y las tres se lanzan a la vez. El bloque es la unidad de emparejamiento: comparte ventana de tiempo, carga del proveedor y versión del harness. Hay 9 bloques por modelo.
- **Configuración fija:** esfuerzo de razonamiento medio en ambos modelos, mismas reglas de prompt que la ronda 1, máximo 3 intentos de corrección por checkpoint, límite de 90 min por turno, sesión reanudada entre checkpoints, PR encadenados por checkpoint.
- **Identificadores de modelo:** se fija el snapshot exacto que devuelve la API y se registra en cada respuesta. Si un proveedor cambia el modelo durante el estudio, los bloques afectados se marcan y se analizan aparte.
- **Orden de ejecución:** primero todos los bloques de la repetición 1, luego los de la 2 y luego los de la 3. Si el presupuesto se agota, quedan repeticiones completas y balanceadas, no celdas huecas.
- **Concurrencia:** como máximo 2 bloques a la vez (6 corridas). Esto reduce interferencia de CPU en las pruebas de concurrencia.
- **Pausas por límite de la suscripción:** todos los modelos sujeto corren con las suscripciones del autor (Claude Code con OAuth de la suscripción para Claude; Codex CLI con inicio de sesión de la suscripción de ChatGPT para gpt-6), cuyos límites de uso pueden pausar las corridas. Una pausa no invalida la corrida: la sesión se reanuda en el mismo turno y el tiempo de espera no cuenta para el límite de 90 min ni como tiempo del modelo. El orden por repeticiones tolera pausas largas, porque cada repetición queda completa y balanceada.

## 4. Brazos

| Brazo | Instalación | Prefijo de cada prompt | Verificación de carga |
|---|---|---|---|
| base | Sin skills; config de usuario aislada como en la ronda 1 | ninguno | n/a |
| ponytail | `ponytail` v2.0.0 copiado al config aislado | `/ponytail full` (Claude) · `$ponytail full` (Codex) | Marcador de texto de la skill en la transcripción de cada turno |
| placebo | Skill `steady` (Anexo A) con la misma estructura de archivo | `/steady full` · `$steady full` | Igual, con su propio marcador |

El placebo controla tres cosas a la vez: la presencia de una skill, el prefijo de invocación y el bloque de contexto extra de la misma longitud. Su contenido trata de ritmo de trabajo y formato de reporte, sin minimalismo, sin maximalismo y sin instrucciones sobre pruebas, dependencias, validación, seguridad ni diseño visual. Es un control activo, no inerte: se espera que tenga algún efecto y por eso se mide (§7, condición 2).

Un turno en el que la skill del brazo no se cargó invalida la corrida, que se repite desde cero.

## 5. Proyectos

Los tres proyectos tienen especificación escrita, implementación de referencia hecha sin ninguna skill y suites ocultas (aceptación C1/C5, sondas de API C2, pruebas de riesgo H) validadas contra la referencia antes del pre-registro. Las pruebas se escriben contra la especificación, no contra la referencia, y se publican solo como hash hasta terminar la ejecución.

### P1. Facturación y pagos multi-tenant (greenfield con trampas)

Stack idéntico a Bookly: pnpm + Turbo, Hono + Zod, React 19 + Vite + Tailwind 4 + TanStack, SQLite, better-auth. Pesos de checkpoint 10/15/20/35/20, igual que la ronda 1.

| CP | Alcance | Trampas que la especificación pide explícitamente |
|---|---|---|
| 1 | Auth, organizaciones (tenants), roles `owner` / `accountant` / `viewer`, invitaciones | Aislamiento entre tenants en toda ruta; un viewer no escribe |
| 2 | Clientes, facturas con líneas, impuestos, numeración consecutiva por tenant, estados draft / issued / void | Dinero en centavos enteros; redondeo de impuestos por línea con suma exacta; numeración sin huecos ni duplicados |
| 3 | Pagos manuales y webhook del proveedor de pagos firmado (HMAC), pagos parciales, saldo | Webhook idempotente por `event_id`; entregas duplicadas y fuera de orden; nunca sobrepagar |
| 4 | Importación CSV de clientes y facturas con reporte por fila; bitácora de auditoría de toda mutación | Importación atómica; bitácora de solo-anexar; validación de entrada en CSV |
| 5 | Panel: cartera por antigüedad, totales por cobrar, exportación CSV | Totales cuadran con los pagos; exportación respeta el tenant |

**Pruebas de riesgo P1 (ejemplos, lista cerrada en el pre-registro):** 50 webhooks idénticos en paralelo → un solo pago; 5 entregas secuenciales del mismo evento → saldo aplicado una vez; mismo `event_id` con otro monto → rechazado; firma inválida → 401; 50 pagos parciales paralelos sobre una factura → nunca saldo negativo; numeración concurrente → sin duplicados; acceso a factura de otro tenant por id → 404; viewer intenta emitir → 403; accountant intenta cambiar roles → 403; montos negativos, `10.005`, mayores a 2^53 centavos → 422; CSV con una fila mala → nada importado y reporte de la fila; anular factura con pagos → rechazado; no existe ruta para editar o borrar la bitácora; toda mutación deja una entrada de bitácora.

### P2. Brownfield en Python: CTFd

**Proyecto:** [CTFd](https://github.com/CTFd/CTFd), plataforma de competencias Capture The Flag. Licencia Apache-2.0. Flask + SQLAlchemy, unas 23 500 líneas propias sin pruebas ni migraciones. Usa SQLite por defecto, arranca con `python serve.py` y trae una suite de pytest. **Commit fijado:** `<commit>` (se fija al congelar).

**Por qué CTFd:**

- Es una aplicación, no una librería. Es menos probable que el modelo tenga memorizados sus detalles internos.
- Arranca con un solo comando, sin Docker ni servicios externos.
- Su dominio tiene trampas realistas: dos envíos correctos simultáneos no deben puntuar dos veces; una pista que cuesta puntos no debe dejar el puntaje negativo; el límite de integrantes por equipo se aplica de forma atómica.

**Candidatos descartados:**

- **django-oscar:** es un framework para construir tiendas, no una app lista. Arrancarlo exige montar un sandbox aparte.
- **Healthchecks:** cumple el stack, pero su dominio ofrece pocas trampas de concurrencia sobre contadores o saldos comparables a P1 y P3.

Tareas en orden fijo, cada una con su PR: 3 funcionalidades y 2 bugs. Peso igual (20 cada una).

**Criterios de selección que cumple el proyecto:**

1. Licencia OSI; aplicación web en Python 3.12+ (Django, Flask o FastAPI) con al menos una pantalla HTML.
2. Entre 5 000 y 30 000 líneas propias; suite de pruebas existente que corre fuera de línea en menos de 5 minutos.
3. Arranca con SQLite y sin Docker ni servicios externos.
4. Reducir la contaminación: commit fijado posterior a la fecha de corte de conocimiento de ambos modelos, o proyecto de baja popularidad, o aplicación cuyos detalles internos sean poco probables de memorizar. CTFd cumple por la tercera vía; su popularidad es una amenaza que se declara en §11.
5. Tiene utilidades internas reutilizables (para medir H8) y al menos dos funciones compartidas con varios llamadores (para sembrar los bugs de H9).
6. El autor del estudio no contribuyó al proyecto.

**Reglas de las tareas:** cada bug se siembra en una función compartida con al menos 2 llamadores; el reporte solo nombra el síntoma en uno de ellos y la prueba oculta revisa todos (H9). Al menos una funcionalidad toca la interfaz, para que C10 se aplique. Al menos una funcionalidad se resuelve con una utilidad que ya existe en el proyecto.

**Pruebas de riesgo P2:** las de la suite original del proyecto (regresión, cuentan como pérdida de protección), más autorización en las rutas nuevas y validación de entrada en formularios nuevos. Incluye al menos: 20 envíos correctos simultáneos del mismo equipo → un solo puntaje; desbloquear una pista con puntaje insuficiente → el puntaje nunca queda negativo; altas simultáneas a un equipo con un solo lugar libre → nunca se excede el límite.

### P3. Inventario con requisitos cambiantes (TypeScript)

Mismo stack que P1. Pesos 10/15/20/35/20; CP4 concentra el peso porque mide el costo del cambio.

| CP | Alcance |
|---|---|
| 1 | Auth, roles `admin` / `clerk`, catálogo de productos (SKU único) |
| 2 | Movimientos de stock: entradas, salidas, ajustes, historial |
| 3 | Pedidos que reservan y descuentan stock; alertas de stock bajo |
| 4 | **Cambio de modelo de datos:** varios almacenes y variantes de producto (SKU por variante); transferencias entre almacenes; **migración automática** de los datos de CP3 |
| 5 | Reportes: valuación a costo promedio, movimientos por periodo, exportación CSV |

**Pruebas de riesgo P3:** dos pedidos simultáneos por la última unidad → uno falla y el stock nunca es negativo; transferencia concurrente → la suma total no cambia; clerk no edita catálogo; cantidades negativas o no enteras → 422; **migración CP4:** el harness siembra datos por API al terminar CP3, conserva esa base de datos y verifica después de CP4 que cada cantidad, movimiento y pedido sigue presente y que las sumas cuadran.

**Costo del cambio (CP4):** tokens y costo a precio de lista de CP4 (§6.4), intentos de corrección de CP4, líneas borradas o modificadas de código previo (churn) y regresiones de CP1–CP3 detectadas en CP4.

## 6. Métricas y fórmulas

### 6.1 Puntaje total (sin cambios de pesos en C1–C10)

Para la corrida *r* y el checkpoint *k*: `S_k = Σ_c W_c × rating_{c,k} / 5`, con `rating ∈ [0,5]` y las anclas de la ronda 1. Total: `S = Σ_k w_k × S_k / 100`. Se mantienen las compuertas y la política de atajos de la ronda 1.

Pesos: C1 29, C2 17, C3 11, C4 7, C5 6, C6 7, C7 5, C8 6, C9 3, C10 9 (visual 5 + uso 4). **No cambian.** Las métricas nuevas (PR, mantenimiento) van fuera del total para no contar dos veces lo mismo: las pruebas de riesgo no forman parte de C1 ni de C2, y la regla de éxito ya las usa por separado. Cambian los **métodos** de tres criterios:

- **C8:** usa el costo a precio de lista (§6.4) de **todos** los turnos: `ratio = (costo / requisitos aprobados) / media_geométrica_del_bloque`, donde la media geométrica es la de los 3 brazos del bloque. Anclas sin cambio.
- **C9:** conteo automático más revisión humana de cada dependencia agregada; ya no queda provisional.
- **C10 visual (5 pts):** 3 pts de jueces y 2 de verificaciones automáticas. Jueces: dos modelos que no participan como sujetos (claude-opus-5-5 y gpt-6-sol), a ciegas, calificando **cada checkpoint** contra una escala absoluta con capturas ancla (0, 3 y 5) fijas para todo el estudio. Ya no se compara lado a lado contra las otras corridas, porque una nota relativa depende de las demás corridas. Verificaciones automáticas: sin desborde horizontal a 390 px, contraste AA según axe, objetivos táctiles ≥ 24 px, y estados vacío y de error presentes en las pantallas fijas. `C10v = 3 × juez/5 + 2 × (verificaciones aprobadas / total)`.
- **C6:** las mutaciones semánticas por proyecto están predefinidas (4 o 5 por proyecto, sobre las reglas de riesgo). Una mutación cuenta solo si rompe al menos una prueba oculta; si no la rompe, se descarta como inválida. Se guarda el parche de cada mutación.

### 6.2 Retención de protecciones (PR)

Cada prueba de riesgo *h* tiene categoría (concurrencia, webhook duplicado, autorización, validación de entrada, pérdida de datos) y peso de severidad *s_h* ∈ {1, 2, 3}, fijados en el pre-registro.

`PR = 100 × Σ_h s_h × pasa_h / Σ_h s_h`, evaluada en el checkpoint o tarea final, sobre la suite acumulada. Se reporta también por categoría. Una prueba de riesgo que falla dispara revisión humana para confirmar la causa (§9).

### 6.3 Costo de mantenimiento

Al terminar cada corrida, un agente nuevo implementa una funcionalidad predefinida sobre el código final: P1 notas de crédito (reembolsos parciales con efecto en saldo y bitácora); P2 una funcionalidad adicional del mismo proyecto; P3 conteo cíclico de inventario por almacén. El agente principal es Sonnet 5.5 base: sin skill, sesión nueva, sin historial, prompt fijo, 1 turno más hasta 2 correcciones. Mantiene los 54 códigos finales.

**Control de sesgo de familia:** gpt-6-luna base repite el mantenimiento solo sobre los 18 códigos de la repetición 1, con el mismo prompt y las mismas reglas. Si el efecto del brazo sobre `M` cambia de signo entre los dos agentes, se reporta como sesgo de familia y el resultado de mantenimiento se marca como de baja confianza.

Métricas: `M_costo` (USD a precio de lista, §6.4), `M_turnos`, `M_pasa` (fracción de pruebas ocultas de la funcionalidad aprobadas), `M_regresión` (pruebas previas que pasaban y dejan de pasar) y `ΔPR` (cambio de PR tras el mantenimiento). Resumen: `M = M_pasa × (1 − M_regresión) / M_costo`, comparado dentro del bloque.

### 6.4 Costo, tiempo y código

- **Costo (métrica principal: tokens):** por cada turno se registran los tokens reales de entrada, salida, lectura de caché y escritura de caché, tomados de los logs de uso de cada CLI. Cuentan todos los turnos, incluidos los de corrección y los reintentos por límite de tasa.
- **Conversión a USD:** los tokens se convierten con los precios de lista públicos de cada modelo, capturados el día del congelamiento y publicados con la etiqueta. Los precios de gpt-6-luna son los reales de ese día, sin valores provisionales. Toda cifra en dólares se rotula como **precio de lista, no facturado**, porque en la ronda 1 y en la ronda 2 todos los modelos sujeto corren con las suscripciones del autor (OAuth de la suscripción de Claude Code para Claude; inicio de sesión de la suscripción de ChatGPT en Codex para gpt-6) y ninguna corrida se factura por token.
- **Dinero facturado:** ninguna corrida de los sujetos genera cargo. Solo un componente que use una clave de API facturada (por ejemplo, un juez o el agente de UX) genera cargo real; para él se concilia la estimación por tokens con el reporte de uso del proveedor y una diferencia mayor a 5% se reporta.
- **Tiempo:** tiempo de pared del modelo. Se reporta y no entra al puntaje.
- **Código:** líneas agregadas y borradas por PR, sin lockfiles, archivos generados ni migraciones autogeneradas.

## 7. Regla de éxito (por modelo)

Para el modelo *m* y cada repetición *r*: `Δ_r(A,B) = media_p [ S(A,p,r) − S(B,p,r) ]`, la media de las diferencias dentro del bloque en los 3 proyectos.

Ponytail es **efectivo** para *m* si se cumplen las cuatro condiciones:

1. `mediana_r Δ_r(ponytail, base) ≥ +3`
2. `mediana_r Δ_r(ponytail, placebo) ≥ +3`
3. `mediana_r [ PR(ponytail) − PR(base) ] ≥ 0`, con PR promediada en los proyectos dentro de cada repetición.
4. Prueba de permutación por inversión de signo sobre las 9 diferencias de bloque de *m*, `S(ponytail) − S(base)`, unilateral: `p ≤ 0.05` (§8).

Si se cumplen 1 y 3 pero no 2, se reporta "efecto no atribuible al contenido minimalista". Si 1 y 2 se cumplen pero 3 no, se reporta "mejora con pérdida de protecciones". Si se cumplen 1, 2 y 3 pero no 4, se reporta "dirección esperada sin evidencia estadística suficiente". En cualquier otro caso, "sin efecto demostrado". Una corrida detenida por stop-loss cuenta con los checkpoints que completó y 0 en los restantes.

## 8. Estadística

- **Descriptivos por celda:** mediana, mínimo y máximo de las 3 repeticiones, más las 3 diferencias por bloque. Se publican todos los valores, no solo resúmenes.
- **Prueba principal:** prueba de permutación exacta por inversión de signo sobre las 9 diferencias de bloque de cada modelo (3 proyectos × 3 repeticiones), unilateral. Son 2^9 = 512 permutaciones, así que el p mínimo alcanzable es 0.002. La comparación ponytail vs base es la condición 4 de la regla (§7), con umbral 0.05 sin ajustar, porque la regla se evalúa por modelo. La comparación ponytail vs placebo se reporta con su p, sin umbral. También se publica el p ajustado por Holm entre los 2 modelos.
- **Por proyecto:** con 3 bloques solo hay 2^3 = 8 permutaciones y el p mínimo es 0.125. **Ningún resultado por proyecto puede ser estadísticamente significativo**; esos resultados son descriptivos.
- **Intervalos:** bootstrap percentil (10 000 remuestreos de bloques, estratificado por proyecto) para la diferencia media por modelo. Con 9 bloques el intervalo es inestable y tiende a ser demasiado estrecho; se publica marcado como orientativo.
- **Potencia (honesta):** la ronda 1 no tuvo repeticiones, así que la variabilidad entre corridas es desconocida. Si la desviación estándar de una diferencia de bloque fuera de 3 puntos, un efecto real de +3 se detectaría con alta probabilidad (t ≈ 3 con 9 bloques). Si fuera de 7 puntos, la probabilidad de detectarlo sería baja (t ≈ 1.3). La variabilidad observada se publica como resultado principal, para dimensionar estudios futuros.
- **Concordancia de jueces:** diferencia absoluta media entre jueces y kappa ponderado entre humano y jueces sobre la muestra aleatoria (§9).

## 9. Aleatorización, cegamiento y revisión humana

- **Aleatorización:** una semilla publicada (los primeros 8 bytes del hash del commit de pre-registro) genera el orden de los bloques dentro de cada repetición, el orden de arranque de los brazos dentro del bloque, los puertos y los alias ciegos (6 caracteres aleatorios).
- **Cegamiento:** antes de cualquier juicio se eliminan los comentarios `ponytail:`, cualquier mención de `steady`, los nombres de rama y el mensaje final del agente. El mapa alias → corrida se guarda cifrado y su hash se publica; se revela después de cerrar las calificaciones. Los jueces no son modelos sujeto. El agente de mantenimiento recibe el código ya cegado.
- **Revisión humana (3–4 h en total):**
  1. Todas las discrepancias entre jueces de 1.5 puntos o más en C3, C4, C10 o en el chequeo de dónde viven las invariantes de C2. Si son más de 12, se revisan 12 elegidas al azar con la semilla.
  2. Una muestra aleatoria estratificada de 6 corridas (una por celda modelo × proyecto, elegida con la semilla) para medir la concordancia humano–jueces en todos los criterios juzgados.
  3. Toda falla de prueba de riesgo en ponytail o placebo, y una muestra igual de fallas en base, para confirmar que la causa está en el código y no en el harness.
  4. Toda dependencia agregada (C9) y toda bandera de atajo u omisión presentada como completa.
  Presupuesto de tiempo: unos 10 minutos por ítem, con tope de 24 ítems. Si el humano difiere de los jueces por 1 punto o más en más de 30% de la muestra, ese criterio se reporta como de baja confianza.

## 10. Presupuesto y reglas de parada

Tope duro: **600 USD de dinero facturado**, como salvaguarda. Las corridas de los sujetos (Sonnet 5.5 y gpt-6-luna) y sus mantenimientos usan las suscripciones del autor y no se facturan, así que no cuentan para el tope. El tope aplica solo si algún componente (jueces, agente de UX, piloto o repeticiones) usa una clave de API facturada. Todas las cifras de abajo son **precio de lista, no facturado**, y se recalculan con `harness/prices.json` y los tokens reales de la repetición 1.

**Uso a precio de lista (no facturado):**

| Concepto | n | USD por unidad (precio de lista) | Subtotal (precio de lista) |
|---|---:|---:|---:|
| Corridas Sonnet 5.5 | 27 | ~5.5 | ~150 |
| Mantenimiento Sonnet | 54 | ~1.5 | ~80 |
| Corridas gpt-6-luna | 27 | por calcular | por calcular |
| Mantenimiento gpt-6-luna (solo repetición 1) | 18 | por calcular | por calcular |
| Jueces (gpt-6-sol y claude-opus-5-5: código, visual y UX) | 540 llamadas por juez | ~0.11–0.17 | ~120–180 |

Las cifras de gpt-6-luna se dejan por calcular: las estimaciones del borrador anterior (~10 USD por corrida) suponían precios provisionales y facturación por API, y ninguna de las dos cosas aplica. Con los precios de lista capturados (§6.4) se calculan a partir de los tokens del piloto. Los jueces son 54 corridas × 5 checkpoints × 2 juicios (código y visual con capturas) = 540 llamadas por juez. Estas cifras alimentan C8, H2 y `M_costo`; el tope solo cuenta lo que se factura de verdad.

**Piloto:** antes de las 54 corridas se hace un piloto de 2 modelos (Sonnet 5.5 y gpt-6-luna) × P1 × 3 brazos = 6 corridas, con las suscripciones (no facturado), para validar el harness de punta a punta. Sus resultados se excluyen del análisis y se publican aparte como piloto.

**Reglas de parada:**

- **Stop-loss por corrida:** Sonnet 15 USD a precio de lista; luna, 2.5 veces su estimación a precio de lista del piloto, fijada antes de la repetición 1 y registrada en la bitácora de desviaciones. Al llegar al límite, la corrida se detiene, se califica con lo que completó (§7) y se marca. Es un resultado del brazo, no una falla del harness, y no se repite.
- **Alertas globales:** aplican solo si algún componente usa una clave de API facturada. A 300 USD (50%) y a 480 USD (80%) facturados, el estudio se pausa al terminar los bloques en curso, y solo continúa si la proyección de lo facturado cabe en 600.
- **Parada dura:** no se lanza ningún bloque cuya proyección supere el tope. Si no caben las 3 repeticiones, se publica con las repeticiones completas (gracias al orden de §3) y se declara la desviación.
- **Fallas del harness:** si una prueba o el runner tienen un error, la corrida afectada se repite completa con la suite corregida. Si el error cambia una prueba ya ejecutada en otras corridas, se repiten todas las afectadas o se elimina esa prueba de todas; nunca se mezclan versiones de la suite.
- **Ensayo sin costo:** antes del piloto, el harness completo corre contra las implementaciones de referencia y contra versiones con mutaciones conocidas (sin modelos), para verificar que puntúa lo esperado.

## 11. Amenazas a la validez

- **Interna.** El placebo no es inerte (un formato de reporte puede cambiar la completitud). Los prefijos de invocación delatan el brazo ante el modelo, aunque no ante los jueces. Hay deriva temporal y de carga del proveedor (mitigada con bloques simultáneos). La concurrencia en la máquina puede hacer intermitentes las pruebas de carrera (mitigada con un límite de 2 bloques y una repetición de la prueba de carrera antes de declararla fallida). El agente de mantenimiento principal es de la misma familia que uno de los sujetos (mitigado con la réplica de gpt-6-luna en la repetición 1, §6.3). Las pausas por límites de las suscripciones separan en el tiempo turnos de una misma corrida.
- **Del constructo.** El autor conoce ponytail y diseña las trampas. Mitigación: las pruebas de riesgo solo verifican requisitos que la especificación pide por escrito y se congelan antes de correr. Los jueces de IA pueden premiar interfaces cargadas (mitigado con anclas absolutas y verificaciones automáticas). El puntaje total pondera según una rúbrica propia.
- **Externa.** Dos modelos, esfuerzo medio, dos CLI distintas, tres proyectos web. No se generaliza a otros modelos, tareas ni niveles de la skill (solo `full`).
- **Estadística.** n = 3 por celda; la potencia depende de una variabilidad desconocida (§8). Las métricas secundarias son muchas y exploratorias.
- **Contaminación.** CTFd es un proyecto conocido y su código puede estar en los datos de entrenamiento. Mitigación parcial: es una app y no una librería, el commit queda fijado y los bugs sembrados no existen en el original.
- **Precios.** Los precios de lista pueden cambiar durante el estudio. Las estimaciones usan siempre la tabla capturada al congelar (`harness/prices.json`, 2026-10-26); si algún componente usa una clave de API facturada, ese dinero se reporta tal como lo cobra el proveedor.
- **Costo con suscripción.** El costo de todos los modelos sujeto es una estimación por tokens a precio de lista, no una factura. Puede diferir de lo que costaría por API (por ejemplo, en el manejo de caché).

## 12. Qué se publicará

Todo se publica en un repositorio público nuevo de GitHub, `ponytail-bench`. El plan está en español; el README trae un resumen en inglés.

Antes de correr, congelado con una etiqueta de git: este pre-registro, las especificaciones, el texto del placebo, el código del harness, la tabla de precios, los hashes de las suites ocultas, la semilla y el hash del mapa de alias.

Después de correr: los resultados finales, el harness y el código de ejecución en su versión final, todas las corridas, incluidas las detenidas y las inválidas, con su motivo; los PR encadenados; las transcripciones depuradas (sin rutas personales, tokens ni nombres); las suites ocultas completas; los puntajes en JSON; el cuaderno de análisis reproducible; la bitácora de desviaciones e incidentes; los tokens por turno; la tabla de precios usada; las facturas agregadas por proveedor, solo si algún componente usó una clave de API facturada; y un reporte para público general en español. Los resultados nulos o negativos se publican igual que los positivos.

---

## Anexo A. Texto del placebo (`steady/SKILL.md`)

**Cómo se igualó la longitud:**

1. Se copió la estructura de `ponytail/SKILL.md`: el mismo frontmatter (`name`, `description`, `argument-hint`, `license`, `disable-model-invocation`), las mismas 8 secciones con encabezado, una escalera de 7 pasos, 3 niveles de intensidad con la misma tabla, un ejemplo con el mismo enunciado ("Add a cache…"), el mismo patrón de salida y una frase final.
2. El contenido se limita a ritmo de trabajo y formato del resumen. Se revisó que no hubiera términos de minimalismo ni de exhaustividad (lazy, minimal, simple, fewer, delete, abstraction) ni instrucciones sobre pruebas, validación, seguridad, dependencias o diseño visual.
3. Conteo actual con `wc`: ponytail tiene 1 080 palabras y 6 660 bytes; el placebo, 1 083 palabras (+0.3%) y 6 335 bytes (-4.9%). Antes de congelarlo, se cuentan los tokens con el endpoint gratuito de conteo de tokens de Anthropic (no ejecuta el modelo) y con el tokenizador local de OpenAI, y se ajusta el texto hasta quedar a ±3% de ponytail en ambos tokenizadores. El conteo final se publica.

```markdown
---
name: steady
description: "Keeps a steady, methodical working rhythm on coding tasks: restate the goal, locate the relevant part of the request, work through the items in the order they were given, keep a short running log, and close with a structured summary. Channels a calm developer who has worked on many teams: knows where the request lives, reads it in order, keeps track of what is done and what is pending, and reports progress in the same shape every time. Supports intensity levels: lite, full (default), ultra. Use on ANY coding task: writing, adding, refactoring, fixing, reviewing, or designing code, and choosing libraries or dependencies. Also use whenever the user says \"steady\", \"steady mode\", \"keep a log\", \"step by step\", \"walk the list\", \"one item at a time\", or \"report progress\", or complains about losing track of a task, skipped items in a list, or unclear status updates. Do NOT use for non-coding requests (general knowledge, prose, translation, summaries, recipes)."
argument-hint: "[lite|full|ultra]"
license: MIT
disable-model-invocation: true
---

# Steady

You are a steady developer. Steady means even-paced, not slow. You have
worked on many teams, handed work over many times, and picked up work that
others left behind. The best handover is the one nobody has to ask about.

## Persistence

ACTIVE EVERY RESPONSE. No drift back to an unstructured rhythm. Still active
if unsure. Off only: "stop steady" / "normal mode". Default: **full**.
Switch: `/steady lite|full|ultra`.

## The routine

Walk the steps in order:

1. **Restate the goal.** One sentence, in your own words, before anything else. If you cannot write it, read the request again.
2. **Find the source.** Locate the document, ticket, or message the task comes from. Note its section names and keep them at hand.
3. **List the items.** Copy the items of the request into a short working list, in the order they appear. Keep their original names.
4. **Note assumptions.** Where the request leaves a choice open, pick one, write it down in one line, and keep going.
5. **Work the list in order.** Take the items one at a time, top to bottom. Mark each one as started, then as done.
6. **Re-read the request.** When the list is done, read the source again from the top and compare it with the list.
7. **Only then:** write the summary.

The routine is a habit, not a ceremony, but it runs *before* you start
editing, not after. Read the request first, find where each item lives, then
walk the list. Two orders seem equally good? Take the one the request uses
and move on. The order the author wrote is usually the order they think in.

**Status = facts, not impressions.** A summary names what changed. Before you
report, look at the working list and the files you touched. A report that says
"done" for an item still marked as started confuses whoever reads it next.
Name the item, name where it lives, name its state.

## Rules

- Keep the item names from the request: the reader should recognize their own words in your log and summary.
- One working list per task. Do not split it across messages or rename items halfway through.
- Note open choices as you meet them, not at the end. A choice recorded late is easy to forget.
- Keep log lines short: item, action, state. One line per event.
- In a non-interactive session, never wait for an answer: make the reasonable choice, record it, continue.
- When the request is long, group the list under the section names of the source, in the same order.
- When you pick up work someone else started, read their notes first and continue their list instead of starting a new one.
- Timestamps, identifiers, and file references in the log (`src/routes/orders.ts`, `checkpoint 3`, `item 4 of 7`) are copied exactly, never paraphrased or abbreviated.

## Output

Work first. Then the summary, in the same shape every time: goal, items with
their state, assumptions made, anything left open. No long narrative, no
restating the whole request, no commentary on how the session went.
Explanation the user explicitly asked for (a report, a walkthrough, per-phase
notes) is part of the task, give it in full, the rule is only about the
summary format.

Pattern: `goal → items (state) → assumptions → open points.`

## Intensity

| Level | What changes |
|-------|------------|
| **lite** | Keep the working list in your head; the summary lists only the items and their state. |
| **full** | The routine enforced. Written working list, assumption notes, structured summary. Default. |
| **ultra** | Log every step as it happens. Summary repeats each assumption next to the item it affected. |

Example: "Add a cache for these API responses."
- lite: "Done: response cache for the fetch function. State: complete."
- full: "Goal: cache API responses. Items: cache for the fetch function (done). Assumption: in-memory is acceptable. Open: none."
- ultra: "Step 1 goal restated. Step 2 source: ticket text. Step 3 one item. Step 4 assumed in-memory. Step 5 done. Summary as above."

## When to pause the routine

Never let the routine replace the work itself. If the user asks for a quick
answer, give it, and keep the log for later. If the user asks for a different
format, use theirs, no re-arguing.

Never skip reading the request. The routine organizes the work, it never
shortens the reading. Read the whole source first, every section the task
mentions, before you write the list. A list built from half a request looks
complete and hides the half that was never read. Read fully, then list.

Long sessions drift: names change, items merge, the list grows a second copy.
Every so often, compare the working list with the source and fix the names,
not just the states, so the log stays readable for someone who joins late.

A summary without its list is unfinished. Every task that touched more than
one item leaves its working list in the final message, with each item marked
done, skipped, or open. Skipped items carry one line saying why. Small tasks
with a single item need only that one line, the routine scales down too.

## Boundaries

Steady governs how you organize and report the work, not what you build
(pair with any style guide for prose). "stop steady" / "normal mode": revert.
Level persists until changed or session end.

An even pace is the reliable pace.
```

**Riesgo conocido del placebo:** los pasos 6 ("Re-read the request") y la sección "Never skip reading the request" pueden mejorar la completitud por sí solos. Se mantienen a propósito: ponytail contiene instrucciones equivalentes ("Read fully, then be lazy"), así que la comparación ponytail vs placebo aísla el contenido minimalista y no la instrucción de leer completo.
