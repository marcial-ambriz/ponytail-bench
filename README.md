# ponytail-bench, ronda 2

Benchmark pre-registrado de la skill de Claude "ponytail" v2.0.0 ("the laziest solution that works"). La pregunta es si la skill mejora el resultado de un agente de código en proyectos web reales, sin perder protecciones.

El plan completo está en [`plan/plan.md`](plan/plan.md). Este README solo resume.

## Diseño en breve

- **54 corridas:** 2 modelos (Sonnet 5.5 en Claude Code, gpt-6-luna en Codex CLI) × 3 proyectos × 3 brazos × 3 repeticiones.
- **Brazos:** base, ponytail y un placebo de longitud igualada (`steady`).
- **Proyectos:**
  - P1: facturación multi-tenant en TypeScript, con trampas de dinero, webhooks e idempotencia.
  - P2: brownfield sobre [CTFd](https://github.com/CTFd/CTFd) (Flask), con commit fijado.
  - P3: inventario en TypeScript con un cambio de modelo de datos a mitad del proyecto.
- **Pruebas ocultas:** aceptación, sondas de API y una suite adversarial de riesgo. Se publican solo como hash hasta terminar.
- **Regla de éxito por modelo:** +3 puntos sobre base y sobre placebo, sin perder protecciones, y p ≤ 0.05 en una prueba de permutación sobre 9 bloques.
- **Costo:** todos los modelos sujeto corren con las suscripciones del autor (Claude Code y Codex con ChatGPT), así que ninguna corrida se factura por token, ni en la ronda 1 ni en la 2. Se miden tokens reales por turno, valuados con los precios de lista de `harness/prices.json` (precio de lista, no facturado). El tope de 600 USD es una salvaguarda que aplica solo si algún componente usa una clave de API facturada.
- **Mantenimiento:** un agente nuevo extiende cada código final. Sonnet mantiene las 54 corridas; gpt-6-luna repite la repetición 1 para medir sesgo de familia.
- **Piloto:** 6 corridas (Sonnet 5.5 y gpt-6-luna × P1 × 3 brazos) para validar el harness. No entran al análisis.

## Estructura

| Carpeta | Contenido |
|---|---|
| `plan/` | Pre-registro, texto del placebo, brechas del harness y contrato entre harness y proyectos |
| `harness/` | Runner genérico, calificación y contabilidad de costo |
| `projects/<id>/` | Un proyecto por carpeta: especificación, referencia y pruebas (ocultas hasta el final) |

## Publicación

El repositorio público `ponytail-bench` se congela con una etiqueta de git antes de la primera corrida. Después se publican los resultados, el harness final, el código de ejecución y todas las corridas, incluidas las fallidas. Los resultados nulos o negativos se publican igual.

## English summary

This repository holds the pre-registered second round of a benchmark for the "ponytail" Claude skill v2.0.0, which tells coding agents to ship the laziest solution that works. Round 2 runs 54 sessions: two models (Sonnet 5.5 in Claude Code, gpt-6-luna in Codex CLI), three web projects, three arms (base, ponytail, and a length-matched placebo skill), and three repetitions in blocks. The projects are a multi-tenant invoicing app, a brownfield task set on CTFd, and an inventory app with a mid-project data-model change. Hidden acceptance and adversarial hazard tests are frozen by hash. Ponytail counts as effective for a model only if it beats both base and placebo by 3 points, keeps safety protections, and reaches p ≤ 0.05 on a sign-flip permutation test across 9 blocks. All subject models run on the author's subscriptions (Claude Code OAuth for Claude, ChatGPT login in Codex for gpt-6), in round 1 and round 2, so no run is billed per token. Cost is measured in real tokens per turn, priced at list prices captured on 2026-10-26 (list price, not billed). A 600 USD cap applies only if some component uses a billed API key. The full plan is in Spanish in `plan/plan.md`.
