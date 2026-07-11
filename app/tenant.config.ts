// TARGET: autocore-p1/app/tenant.config.ts
// Tenant identity + Worker endpoints for AutoCore P1 (Prime One Auto Sales).
// An empty Worker URL means the feature is DISABLED: callers must degrade
// gracefully (hide the action / show "función no disponible"), never fall
// back to a Motocentro Worker.
// Legal identity fields (nombreLegal, rif, registroMercantil) are omitted on
// purpose: P1 is CRM-only and generates no legal documents. Add them only if
// a printable-document feature returns.
export const TENANT = {
  id: 'primeone',
  nombre: 'Prime One Auto Sales',
  nombreCorto: 'Prime One',
  ciudad: 'Maracay',   // confirm with Franco
  estado: 'Aragua',
  marcas: [] as string[],   // multi-brand used cars — populated later; NO KIA default anywhere
  dominio: 'p1.motocentro2.com', // provisional; may change
  sitioWeb: 'https://www.p1autosales.com', // dealer's existing public website
  workers: {
    whatsapp: '',    // empty = feature disabled; wire real p1-* URLs when Workers are deployed
    adminUsers: '',
    siteSync: '',
    loginAudit: '',
  },
} as const
