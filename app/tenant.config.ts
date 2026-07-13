// TARGET: autocore-p1/app/tenant.config.ts
// Tenant identity + Worker endpoints for AutoCore P1 (Prime One Auto Sales).
// An empty Worker URL means the feature is DISABLED: callers must degrade
// gracefully (hide the action / show "función no disponible"), never fall
// back to a Motocentro Worker.
// Legal identity fields (nombreLegal, rif, registroMercantil) are omitted on
// purpose: P1 is CRM-only and generates no legal documents. Add them only if
// a printable-document feature returns.
// Business model (confirmed by Franco 2026-07-13): the dealer is Prime One
// Auto Sales LLC, Miami FL (used cars + commercial trucks/vans, USD). Franco
// operates AutoCore P1 as an INDEPENDENT third-party sales broker for that
// dealer (commission per sale) — this system is the broker's CRM, not the
// dealership's in-house tool. Inventory here mirrors the dealer's public
// stock via the p1-site-sync importer.
export const TENANT = {
  id: 'primeone',
  nombre: 'Prime One Auto Sales',
  nombreCorto: 'Prime One',
  ciudad: 'Miami',
  estado: 'FL',
  marcas: [] as string[],   // multi-brand used cars — populated later; NO KIA default anywhere
  dominio: 'p1.motocentro2.com', // provisional; may change
  sitioWeb: 'https://www.p1autosales.com', // dealer's existing public website
  // Sales WhatsApp for buyer contact (digits only, intl format). Franco's
  // personal line — used for wa.me links in generated Marketplace
  // descriptions. NOTE: this number lives in the WhatsApp app on his phone;
  // do NOT register it on the WhatsApp Business Platform (Cloud API) — that
  // would disconnect it from the phone app. A future Claudia AI bot needs
  // its own dedicated number.
  whatsappVentas: '13053333438',
  workers: {
    whatsapp: '',    // empty = feature disabled; wire real p1-* URLs when Workers are deployed
    adminUsers: '',
    siteSync: '',
    loginAudit: '',
  },
} as const
