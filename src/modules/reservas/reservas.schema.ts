import { z } from 'zod';

export const MOTIVOS = ['cumpleanos', 'corporativo', 'casual', 'despedida', 'aniversario', 'otro'] as const;
export const ESTADOS = ['pendiente', 'confirmada', 'rechazada', 'cancelada', 'asistio', 'no_asistio'] as const;

export const crearReservaSchema = z.object({
  nombre_completo: z.string().trim().min(3, 'Escribe tu nombre completo').max(120),
  telefono: z
    .string()
    .transform((v) => v.replace(/\D/g, ''))
    .pipe(z.string().min(10, 'Número de WhatsApp inválido').max(15, 'Número de WhatsApp inválido')),
  email: z
    .union([z.email('Email inválido'), z.literal('')])
    .optional()
    .transform((v) => v || null),
  fecha: z.iso.date('Fecha inválida'),
  hora: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora inválida'),
  personas: z.coerce.number().int().min(1, 'Mínimo 1 persona').max(60, 'Para más de 60 personas escríbenos por WhatsApp'),
  zona: z.string().min(1, 'Selecciona una zona'),
  motivo: z.enum(MOTIVOS).default('casual'),
  evento: z.string().optional().nullable(),
  notas: z.string().trim().max(500).optional().nullable(),
  acepta_politicas: z.literal(true, { error: 'Debes aceptar las condiciones de reserva' }),
  // honeypot anti-bots: los humanos no lo ven, debe llegar vacío
  sitio_web: z.string().optional(),
});

export type CrearReserva = z.infer<typeof crearReservaSchema>;
