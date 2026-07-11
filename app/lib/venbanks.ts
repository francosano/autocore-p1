// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/lib/venbanks.ts
// Canonical Venezuelan bank list (código → nombre) for Bs operations.
// Codes are the official 4-digit bank codes used on transfers/pagos móvil.
// Shared by tesorería Bs ingresos and the Cambio Cash → Bolívares egreso so
// both write the SAME banco_bs_codigo, keeping /banco reconciliation consistent.
// NOTE: app/tesoreria/ingresos/nuevo currently still has its own identical copy;
// migrate it to this module in a later cleanup.
// ═══════════════════════════════════════════════════════════════════════════

export const VENBANKS: { codigo: string; nombre: string }[] = [
  { codigo: '0102', nombre: 'Banco de Venezuela' },
  { codigo: '0104', nombre: 'Venezolano de Crédito' },
  { codigo: '0105', nombre: 'Mercantil' },
  { codigo: '0108', nombre: 'BBVA Provincial' },
  { codigo: '0114', nombre: 'Bancaribe' },
  { codigo: '0115', nombre: 'Banco Exterior' },
  { codigo: '0128', nombre: 'Banco Caroní' },
  { codigo: '0134', nombre: 'Banesco' },
  { codigo: '0137', nombre: 'Sofitasa' },
  { codigo: '0138', nombre: 'Banplus' },
  { codigo: '0146', nombre: 'Bangente' },
  { codigo: '0151', nombre: 'BFC Banco Fondo Común' },
  { codigo: '0156', nombre: '100% Banco' },
  { codigo: '0157', nombre: 'DelSur' },
  { codigo: '0163', nombre: 'Banco del Tesoro' },
  { codigo: '0166', nombre: 'Banco Agrícola de Venezuela' },
  { codigo: '0168', nombre: 'Bancrecer' },
  { codigo: '0169', nombre: 'Mi Banco' },
  { codigo: '0171', nombre: 'Banco Activo' },
  { codigo: '0172', nombre: 'Bancamiga' },
  { codigo: '0173', nombre: 'Banco Internacional de Desarrollo' },
  { codigo: '0174', nombre: 'Banplus (Digital)' },
  { codigo: '0175', nombre: 'Banco Bicentenario' },
  { codigo: '0177', nombre: 'BANFANB' },
  { codigo: '0191', nombre: 'BNC — Banco Nacional de Crédito' },
]