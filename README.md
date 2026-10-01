# Mamba Bistro Bar 2.0 — Backend

API REST de Mamba Bistro Bar: sitio web público (menú, eventos, reservas, galería) y sistema administrativo
(salón, pedidos, comandas, caja multimoneda COP / USD / VES, inventario con recetas, reportes).
Node + Express 5 + TypeScript sobre PostgreSQL (local o Neon).

## Arrancar

```bash
cp .env.example .env     # DATABASE_URL y un JWT_SECRET largo
npm install
npm run db:instalar      # crea o actualiza la base (no necesita psql)
npm run dev              # http://localhost:4100/api/salud
```

`npm run db:instalar` instala todo si la base está vacía; si ya existe el sitio web, solo agrega el sistema
administrativo sin borrar datos. También se puede hacer a mano en pgAdmin o en el SQL Editor de Neon:
`database/mamba_completo.sql` (solo en una base vacía: borra y recrea las tablas del sitio) y luego
`database/mamba_sistema.sql` (aditivo, re-ejecutable).

El seed crea usuarios de ejemplo con una contraseña temporal (ver `database/04_sistema_seed.sql`).
**Cámbiala antes de poner el sistema en producción.**

## Estructura

```
database/        SQL del esquema y datos iniciales
scripts/db.mjs   instalador de la base
src/
  config/        variables de entorno validadas
  db/            pool de PostgreSQL y transacciones
  middlewares/   sesión JWT, roles y errores
  utils/         conversión entre monedas
  services/      cuentas (pedidos, inventario, cobros) · tasas y ajustes · recordatorios · notificaciones
  modules/
    local · menu · eventos · reservas · galeria      rutas públicas  (/api/...)
    admin/                                           panel           (/api/admin/..., requiere sesión)
```

## Rutas principales

| Públicas | |
|---|---|
| `GET /api/local` · `/api/menu` · `/api/eventos` · `/api/galeria` | Contenido del sitio |
| `POST /api/reservas` | Solicitud de reserva |
| `POST /api/eventos/:slug/recordatorio` | "Recuérdame este evento" |

| Panel (`/api/admin`, `Authorization: Bearer <token>`) | |
|---|---|
| `auth` · `usuarios` · `config` | Acceso, roles y ajustes |
| `salon` · `cuentas` · `pos` · `comandas` · `caja` | Operación |
| `catalogo` · `inventario` | Productos, recetas, adicionales e insumos |
| `reservas` · `eventos` · `recordatorios` · `clientes` | Comercial |
| `tasas` · `metodos-pago` · `reportes` | Administración |

## Variables de entorno

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | PostgreSQL local o Neon (`?sslmode=require`) |
| `JWT_SECRET` | Firma de las sesiones del panel (mínimo 16 caracteres) |
| `PORT` | Puerto del API (4100 por defecto) |
| `CORS_ORIGIN` | Dominio(s) del frontend, separados por coma |
| `TZ_NEGOCIO` | `America/Bogota` o `America/Caracas`: cortes de jornada y reportes |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Opcional: envío automático de reservas y recordatorios |
| `RESEND_API_KEY`, `EMAIL_FROM` | Opcional: correo de nuevas reservas |
| `INSTAGRAM_ACCESS_TOKEN` | Opcional: galería desde Instagram |
