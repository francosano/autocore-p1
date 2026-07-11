// TARGET: autocore-npa/app/components/NotaEntregaPrint.tsx
// ═══════════════════════════════════════════════════════════════════════════
// NotaEntregaPrint — Documentos de Entrega de un negocio APROBADO:
//   • Nota de Entrega (con persona autorizada a retirar opcional)
//   • Declaración de Pagos por Zelle/Transferencias (terceros)
//   • Legitimación de Capitales (solo efectivo USD / USDT)
//
// Extraído de app/admin/page.tsx (2026-07-08) sin cambios de contenido, para
// que Deisi también pueda imprimirlos desde /auditoria una vez aprobado el
// negocio (antes Mirla tenía que imprimirlos o enviárselos por correo).
// Gate: el caller decide dónde mostrarlo (npa_can_nota_entrega).
// onPrint se dispara al imprimir la Nota (el caller estampa nota_entrega_at).
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useState, useEffect } from 'react'
import { supabase } from '../supabase'

const fmtDate = (iso: string) => { if (!iso) return '—'; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}` }

// KIA Logo — hosted in Supabase Storage. Update path here if logo is moved.
const KIA_LOGO_DATA_URI = 'https://xwyiatmeyonodgncobps.supabase.co/storage/v1/object/public/comprobantes/assets/22527_Kia_Logo.jpg'

// Legitimacion de Capitales: WHITELIST. Solo fondos recibidos fisicamente en
// divisas (efectivo USD) o USDT. Wires/Zelles quedan fuera (van en la
// Declaracion de Pagos por Zelle/Transferencias); Bs/Retencion/financiamiento
// nunca aplican. Case-insensitive para tolerar 'efectivo'/'Efectivo'/'USDT'.
const isPagoCashUSD = (p: any) => {
  const m = String(p?.metodo || '').toLowerCase()
  return m.includes('efectivo') || m.includes('usdt') || m.includes('cash')
}

const s: any = {
  btnGray: { padding: '10px 24px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' },
  btnGreen: { padding: '10px 24px', background: '#1a7a4a', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase' as const, letterSpacing: '1px' },
  input: { width: '100%', padding: '10px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '13px', outline: 'none', boxSizing: 'border-box' as const },
  label: { fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1.5px', display: 'block', marginBottom: '6px' },
}

export default function NotaEntregaPrint({ deal, onPrint, onDismiss }: { deal: any, onPrint: () => void, onDismiss: () => void }) {
  const [conductorAjeno, setConductorAjeno] = useState(false)
  const [conductorNombre, setConductorNombre] = useState('')
  const [conductorCedula, setConductorCedula] = useState('')
  const [thirdPartyTxs, setThirdPartyTxs] = useState<any[]>([])

  useEffect(() => {
    if (!deal?.id) return
    supabase.from('bank_transactions').select('*').eq('deal_id', deal.id).eq('is_third_party', true)
      .then(({ data }: any) => setThirdPartyTxs(data || []))
  }, [deal?.id])

  const buildNotaHTML = () => {
    const conductorSection = conductorAjeno && conductorNombre ? `
      <div class="section driver-box">
        <div class="section-title" style="color:#BB162B">Persona Autorizada para Retirar — Authorized Pickup Person</div>
        <div class="grid2">
          <div class="field"><div class="field-label">Nombre Completo</div><div class="field-value">${conductorNombre}</div></div>
          <div class="field"><div class="field-label">Cédula de Identidad</div><div class="field-value">${conductorCedula || '—'}</div></div>
        </div>
        <p style="font-size:11px;color:#555;margin-top:8px;line-height:1.5;">Esta persona ha sido autorizada por el cliente para retirar el vehículo identificado en este documento.</p>
      </div>` : ''

    const signatories = conductorAjeno && conductorNombre
      ? `<div class="signatures">
          <div class="sig">${[deal.cliente_nombre, (deal as any).cliente_apellidos].filter(Boolean).join(' ') || '_______________'}<br><span style="font-size:9px;color:#999">CLIENTE</span></div>
          <div class="sig">${deal.vendedor || '_______________'}<br><span style="font-size:9px;color:#999">VENDEDOR</span></div>
          <div class="sig">_______________<br><span style="font-size:9px;color:#999">GERENCIA</span></div>
          <div class="sig">${conductorNombre}<br><span style="font-size:9px;color:#999">FIRMA — PERSONA QUE RETIRA</span></div>
        </div>`
      : `<div class="signatures" style="grid-template-columns:1fr 1fr 1fr">
          <div class="sig">${[deal.cliente_nombre, (deal as any).cliente_apellidos].filter(Boolean).join(' ') || '_______________'}<br><span style="font-size:9px;color:#999">CLIENTE</span></div>
          <div class="sig">${deal.vendedor || '_______________'}<br><span style="font-size:9px;color:#999">VENDEDOR</span></div>
          <div class="sig">_______________<br><span style="font-size:9px;color:#999">GERENCIA</span></div>
        </div>`

    return `<!DOCTYPE html><html><head><title>Nota de Entrega #${deal.negocio_num || '—'}</title><style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: Arial, sans-serif; font-size: 11px; color: #000; }
      @page { size: letter portrait; margin: 12mm 16mm; }
      .header { border-bottom: 3px solid #BB162B; padding-bottom: 10px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: flex-end; }
      .header-left { display: flex; align-items: center; gap: 12px; }
      .header-logo { height: 38px; width: auto; flex-shrink: 0; }
      .company { font-size: 22px; font-weight: 900; letter-spacing: 2px; color: #05141F; }
      .branch { font-size: 12px; font-weight: 700; color: #BB162B; letter-spacing: 1.5px; margin-top: 2px; }
      .doc-title { font-size: 16px; font-weight: 900; color: #05141F; text-align: right; }
      .doc-num { font-size: 11px; color: #666; text-align: right; margin-top: 2px; }
      .banner { background: #05141F; color: #fff; padding: 8px 14px; border-radius: 6px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; }
      .banner-label { font-size: 8px; color: rgba(255,255,255,0.6); text-transform: uppercase; letter-spacing: 1px; }
      .banner-value { font-size: 13px; font-weight: 900; }
      .section { margin-bottom: 14px; }
      .section-title { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; color: #BB162B; border-bottom: 1px solid #eee; padding-bottom: 4px; margin-bottom: 8px; }
      .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
      .field { margin-bottom: 8px; }
      .field-label { font-size: 8px; color: #999; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 2px; }
      .field-value { font-size: 12px; font-weight: 600; color: #000; border-bottom: 1px solid #ddd; padding-bottom: 3px; min-height: 18px; }
      .driver-box { background: #fafafa; border: 1px solid #e0e0e0; border-radius: 6px; padding: 10px 14px; }
      .notice { background: #f9f9f9; border: 1px solid #eee; border-radius: 4px; padding: 8px 12px; margin-bottom: 14px; font-size: 10px; color: #555; line-height: 1.55; }
      .checklist { border: 1px solid #ddd; border-radius: 5px; padding: 10px 14px; margin-bottom: 14px; }
      .checklist-item { display: flex; align-items: flex-start; gap: 10px; padding: 6px 0; border-bottom: 1px solid #f0f0f0; }
      .checklist-item:last-child { border-bottom: none; }
      .checkbox { width: 14px; height: 14px; border: 1.5px solid #333; border-radius: 2px; flex-shrink: 0; margin-top: 1px; }
      .checklist-label { font-size: 11px; font-weight: 600; color: #000; line-height: 1.3; }
      .checklist-sub { font-size: 9px; color: #777; margin-top: 1px; }
      .signatures { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 20px; margin-top: 36px; }
      .sig { text-align: center; border-top: 1px solid #000; padding-top: 6px; font-size: 9px; color: #333; font-weight: 600; }
      .footer { margin-top: 16px; padding-top: 8px; border-top: 1px solid #eee; text-align: center; font-size: 8px; color: #aaa; }
    </style></head><body>
    <div class="header">
      <div class="header-left">
        <img class="header-logo" src="${KIA_LOGO_DATA_URI}" alt="KIA" />
        <div><div class="company">KIA MARACAY</div><div class="branch">MOTOCENTRO II</div></div>
      </div>
      <div><div class="doc-title">NOTA DE ENTREGA</div><div class="doc-num">Negocio #${deal.negocio_num || '—'} · ${deal.fecha_entrega ? fmtDate(deal.fecha_entrega) : new Date().toLocaleDateString('es-VE')}</div></div>
    </div>
    <div class="banner">
      <div><div class="banner-label">Fecha de Entrega</div><div class="banner-value">${deal.fecha_entrega ? fmtDate(deal.fecha_entrega) : '—'}</div></div>
      <div><div class="banner-label">Vendedor</div><div class="banner-value">${deal.vendedor || '—'}</div></div>
      <div><div class="banner-label">Banco</div><div class="banner-value">${deal.banco || '—'}</div></div>
    </div>
    <div class="section">
      <div class="section-title">Datos del Cliente</div>
      <div class="grid2">
        <div class="field"><div class="field-label">Nombre Completo</div><div class="field-value">${[deal.cliente_nombre, (deal as any).cliente_apellidos].filter(Boolean).join(' ') || '—'}</div></div>
        <div class="field"><div class="field-label">RIF / Cédula</div><div class="field-value">${deal.cliente_rif_tipo || 'V'}-${deal.cliente_rif || '—'}</div></div>
        ${(deal as any).cliente_telefono ? `<div class="field"><div class="field-label">Teléfono</div><div class="field-value">${(deal as any).cliente_telefono}</div></div>` : ''}
        ${(deal as any).cliente_email ? `<div class="field"><div class="field-label">Email</div><div class="field-value">${(deal as any).cliente_email}</div></div>` : ''}
        ${(deal as any).cliente_direccion ? `<div class="field" style="grid-column:1/-1"><div class="field-label">Dirección</div><div class="field-value">${(deal as any).cliente_direccion}</div></div>` : ''}
      </div>
    </div>
    <div class="section">
      <div class="section-title">Datos del Vehículo</div>
      <div class="grid2">
        <div class="field"><div class="field-label">VIN</div><div class="field-value">${deal.vin || '—'}</div></div>
        <div class="field"><div class="field-label">Fecha de Factura</div><div class="field-value">${deal.fecha_factura ? fmtDate(deal.fecha_factura) : '—'}</div></div>
      </div>
    </div>
    ${conductorSection}
    <div class="notice">Por medio de la presente, se hace constar que el cliente identificado anteriormente ha recibido a su entera satisfacción el vehículo descrito, en las condiciones pactadas al momento de la negociación. KIA Maracay — Motocentro II queda exonerado de cualquier responsabilidad posterior a la fecha de entrega indicada en este documento.</div>
    <div class="section">
      <div class="section-title">Documentos y Accesorios Entregados</div>
      <div class="checklist">
        <div class="checklist-item"><div class="checkbox"></div><div><div class="checklist-label">Llave de Repuesto</div></div></div>
        <div class="checklist-item"><div class="checkbox"></div><div><div class="checklist-label">Libro de Garantía</div></div></div>
        <div class="checklist-item"><div class="checkbox"></div><div><div class="checklist-label">Certificado de Origen (Original) + INTTT (Copia)</div></div></div>
        <div class="checklist-item"><div class="checkbox"></div><div><div class="checklist-label">Factura de Compra</div><div class="checklist-sub">Original y Copia</div></div></div>
      </div>
    </div>
    ${signatories}
    <div class="footer">KIA Maracay — Motocentro II · Generado por AutoCore NPA · ${new Date().toLocaleDateString('es-VE')} ${new Date().toLocaleTimeString('es-VE')}</div>
    </body></html>`
  }

  const buildDeclaracionHTML = () => {
    // Total del formulario = SOLO los Zelles/Wires de terceros listados abajo
    // (bank_transactions con is_third_party). Antes sumaba todos los pagos USD
    // del negocio, inflando la declaracion con montos que no eran de terceros.
    const totalUSD = thirdPartyTxs.reduce((sum: number, t: any) => sum + (Number(t.monto_usd) || 0), 0)
    const today = new Date()
    const dayNum = today.getDate()
    const monthNames = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre']
    const monthName = monthNames[today.getMonth()]
    const yearNum = today.getFullYear()
    const payLines = Array.from({ length: 10 }, (_, i) => {
      const tp = thirdPartyTxs[i]
      if (tp) return '<div style="display:flex;gap:8px;margin-bottom:10px;align-items:flex-end"><span style="font-weight:700;width:24px;flex-shrink:0">' + (i+1) + '.-</span><span style="flex:1;font-size:11px;font-weight:600;border-bottom:1px solid #555">$' + (tp.monto_usd||0).toLocaleString('en-US',{minimumFractionDigits:2}) + (tp.tipo ? ' ('+tp.tipo+')' : '') + (tp.sender_name ? ' — '+tp.sender_name : '') + '</span></div>'
      return '<div style="display:flex;gap:8px;margin-bottom:10px;align-items:flex-end"><span style="font-weight:700;width:24px;flex-shrink:0">' + (i+1) + '.-</span><span style="flex:1;border-bottom:1px solid #333"></span></div>'
    }).join('')
    const emptyLines = Array.from({ length: 10 }, (_, i) => '<div style="display:flex;gap:8px;margin-bottom:10px;align-items:flex-end"><span style="font-weight:700;width:24px;flex-shrink:0">' + (i+1) + '.-</span><span style="flex:1;border-bottom:1px solid #333"></span></div>').join('')
    const vMarca = (deal as any).vehiculo_marca || 'KIA'
    const vModelo = (deal as any).vehiculo_modelo || ''
    const vColor = (deal as any).vehiculo_color || ''
    const vPlaca = (deal as any).vehiculo_placa || ''
    const vAnio = (deal as any).vehiculo_año || ''
    const vClase = (deal as any).vehiculo_clase || ''
    const vUso = (deal as any).vehiculo_uso || 'PARTICULAR'
    const cApellidos = (deal as any).cliente_apellidos || ''
    const cDir = (deal as any).cliente_direccion || '_________________________________'
    const cTel = (deal as any).cliente_telefono || '______________'
    const cEmail = (deal as any).cliente_email || '______________'
    const cEC = (deal as any).cliente_estado_civil || '__________'
    return `<!DOCTYPE html><html><head><title>Declaración de Pagos</title><style>* { margin: 0; padding: 0; box-sizing: border-box; } body { font-family: Arial, sans-serif; font-size: 11px; color: #000; } @page { size: letter portrait; margin: 16mm 20mm; } .dec-header { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; padding-bottom: 10px; border-bottom: 2px solid #05141F; } .dec-logo { height: 30px; width: auto; flex-shrink: 0; } .dec-company { font-size: 10px; line-height: 1.55; } .dec-company-name { font-size: 12px; font-weight: 900; margin-bottom: 1px; } .title { text-align: center; font-size: 13px; font-weight: 900; text-transform: uppercase; letter-spacing: 1px; text-decoration: underline; margin-bottom: 16px; } .block { font-size: 11px; line-height: 1.9; margin-bottom: 14px; text-align: justify; } .ul { border-bottom: 1px solid #333; display: inline-block; min-width: 120px; } .sec { font-size: 10.5px; line-height: 1.75; margin-bottom: 12px; text-align: justify; } .sig { display: flex; align-items: flex-end; gap: 8px; margin-bottom: 10px; } .slab { font-size: 11px; font-weight: 700; white-space: nowrap; } .sln { flex: 1; border-bottom: 1px solid #333; height: 20px; }</style></head><body>
<div class="dec-header">
  <img class="dec-logo" src="${KIA_LOGO_DATA_URI}" alt="KIA" />
  <div class="dec-company">
    <div class="dec-company-name">MOTOCENTRO II, C.A</div>
    <div>RIF. J-07577719-0 · Av. Bolívar Oeste, Maracay, Edo. Aragua</div>
    <div>Telfs. (0424) 349.40.18 · E-mail: servicio@motocentro2.com</div>
  </div>
</div>
<div class="title">Declaracion de Pagos por Zelle / Transferencias</div>
<div class="block">Yo, <span class="ul" style="min-width:200px">${deal.cliente_nombre || ''} ${cApellidos}</span>, Venezolano, mayor de edad, identificado con la cédula de identidad N° <strong>${deal.cliente_rif_tipo || 'V'}-${deal.cliente_rif || '___'}</strong> con domicilio en: <span class="ul" style="min-width:300px">${cDir}</span>, teléfono: <span class="ul" style="min-width:100px">${cTel}</span>, correo electrónico <span class="ul" style="min-width:160px">${cEmail}</span> de estado civil <span class="ul" style="min-width:80px">${cEC}</span>, y civilmente hábil, por medio del presente documento <strong>DECLARO:</strong></div>
<div class="block"><strong>PRIMERO.</strong> Que he comprado a la sociedad de comercio <strong>MOTOCENTRO II, C.A</strong> domiciliada en Maracay, inscrita en el Registro Mercantil Segundo de la Circunscripción Judicial del Estado Aragua, bajo el N° 60 Tomo 364-A siendo su última reforma registrada ante el mismo Registro Mercantil en fecha 19/01/2012 bajo el N° 7 Tomo 7-A identificada con el RIF <strong>J-07577719-0</strong> un vehículo Marca: <span class="ul">${vMarca}</span> Modelo <span class="ul">${vModelo}</span> Año <span class="ul">${vAnio}</span>, Fabricación <span class="ul"></span>, Color <span class="ul">${vColor}</span>, Clase <span class="ul">${vClase}</span>, Placa <span class="ul">${vPlaca}</span>, Serial de Carrocería <span class="ul">${deal.vin || ''}</span>, Serial Motor <span class="ul"></span>, Tipo <span class="ul">${vUso}</span>, Uso <span class="ul">${vUso}</span> por un precio de <span class="ul">$${totalUSD.toLocaleString('en-US',{minimumFractionDigits:2})}</span> para cuyo pago he realizado los siguientes Zelle / Transferencias que provienen de mi cuenta personal:</div>
${payLines}
<div class="block" style="margin-top:8px">Y además, de conformidad con lo establecido en el artículo 1.283 del Código Civil se hacen por terceras personas autorizadas por mí, las siguientes transferencias bancarias utilizando el método instantáneo Zelle:</div>
${emptyLines}
<div class="sec" style="margin-top:8px"><strong><u>SEGUNDO:</u></strong> Acepto y convengo que: <strong>2.1.-</strong> MOTOCENTRO II, C. A ya identificada, no entregará factura ni vehículo hasta tanto no se hagan efectivas las transferencias vía Zelle realizadas a la cuenta de <strong>ROFRAMI MANAGEMENT LLC</strong> y la totalidad del pago del precio de la venta; <strong>2.2.-</strong> las terceras personas que realizaron los zelles no tienen ninguna acción ni reclamo contra MOTOCENTRO, C.A ni contra <strong>ROFRAMI MANAGEMENT LLC</strong> y estas no están obligadas a emitir recibos, soportes o notas por los pagos que realicen las terceras personas en mi nombre y autorizadas por mi persona, por cuanto no existe ninguna vinculación <strong>contractual con dichas sociedades de comercio</strong> y las terceras personas antes mencionadas, solo están efectuando el pago por cuenta y en descargo de mi persona, deudora de la obligación con MOTOCENTRO, C.A y no tienen interés en la causa de la deuda; <strong>2.3.-</strong> en caso de reverso, anulación, cancelación, rechazo, suspensión, devolución, bloqueo, cierre o intervención de algún Zelle o transferencia o la cuenta origen de los fondos, no se considerará válido el envío de dicho dinero a la cuenta destino y por ende no estaré solvente y liberado de la obligación de pago; y debo proceder de inmediato a pagar el monto adeudado, mas los costos o comisiones que puedan causarse y <strong>2.4.-</strong> Asumo toda la responsabilidad por los cargos o comisiones que puedan generarse por el uso de los ZELLE o TRANSFERENCIAS provenientes de terceros autorizados por mi persona.</div>
<div class="sec"><strong><u>TERCERO:</u></strong> Los fondos y recursos económicos con los que se paga el vehículo, provienen de terceros autorizados, así como de mi persona, son de origen licito y expresamente asumo la responsabilidad plena por cualquier inconveniente que pueda surgir en relación al origen del dinero, siendo responsable de todos los daños y perjuicios que pueda ocasionar a <strong>MOTOCENTRO II, C.A</strong> o a <strong>ROFRAMI MANAGEMENT LLC.</strong></div>
<div class="sec"><strong><u>CUARTO:</u></strong> Declaro que hago libre de coacción y apremio en la ciudad de Maracay, a los <span class="ul" style="min-width:30px">${dayNum}</span> días del mes de <span class="ul" style="min-width:70px">${monthName}</span> del año <span class="ul" style="min-width:50px">${yearNum}</span></div>
<div class="sig" style="margin-top:24px"><span class="slab">Nombre y Apellido</span><span style="margin-right:4px">✕</span><span>${deal.cliente_nombre || ''} ${cApellidos}</span><span class="sln"></span></div>
<div class="sig"><span class="slab">C.I</span><span style="margin-right:4px">✕</span><span>${deal.cliente_rif || ''}</span><span class="sln" style="flex:0.2"></span><span style="margin-left:40px;font-size:15px;font-style:italic;color:#555">Firma</span><span class="sln"></span></div>
</body></html>`
  }

  const buildLegitimacionHTML = () => {
    const pagosAll: any[] = Array.isArray(deal.pagos) ? deal.pagos : []
    const pagos = pagosAll.filter(isPagoCashUSD)
    const totalUSD = pagos.reduce((sum: number, p: any) => sum + (parseFloat(p.monto_usd) || 0), 0)
    // Format amount Venezuelan style: $22.000,00
    const totalFmt = totalUSD.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const words = numToWords(Math.floor(totalUSD)).toUpperCase()
    const cents = Math.round((totalUSD % 1) * 100)
    const wordsLine = cents > 0
      ? `${words} CON ${String(cents).padStart(2,'0')}/100 DÓLARES DE LOS ESTADOS UNIDOS DE AMÉRICA`
      : `${words} DÓLARES DE LOS ESTADOS UNIDOS DE AMÉRICA`

    return `<!DOCTYPE html>
<html><head><title>Legitimación de Capitales — ${deal.cliente_nombre || ''}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; font-size: 11.5px; color: #000; background: #fff; }
  @page { size: letter portrait; margin: 18mm 22mm 18mm 22mm; }

  .header { display: flex; align-items: flex-start; gap: 18px; margin-bottom: 40px; }
  .kia-logo {
    width: 88px; height: 32px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .kia-logo img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .company-block { font-size: 11px; line-height: 1.7; }
  .company-name { font-size: 13px; font-weight: 900; margin-bottom: 1px; }

  .doc-title {
    text-align: center; font-size: 12.5px; font-weight: 900;
    text-transform: uppercase; letter-spacing: 1px;
    text-decoration: underline; margin-bottom: 28px;
  }

  .payer-line { font-size: 12px; font-weight: 700; margin-bottom: 3px; }
  .payer-rif  { font-size: 11.5px; margin-bottom: 28px; }

  .body-text {
    font-size: 11.5px; line-height: 2; text-align: justify;
    margin-bottom: 28px;
  }

  .checkboxes { margin-left: 60px; margin-bottom: 28px; display: flex; flex-direction: column; gap: 2px; }
  .cb-row { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
  .cb-empty {
    width: 22px; height: 22px; border: 1.5px solid #333;
    flex-shrink: 0; background: #fff;
  }
  .cb-filled {
    width: 22px; height: 22px; border: 1.5px solid #555;
    flex-shrink: 0; background: #aaa;
  }
  .cb-label { font-size: 11.5px; }

  .amount-block { text-align: center; margin: 10px 0 6px; }
  .amount-label { font-size: 12px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.5px; }
  .amount-value { font-size: 13px; font-weight: 900; display: inline; }

  .amount-words {
    text-align: center; font-size: 12px; font-weight: 900;
    text-transform: uppercase; letter-spacing: 0.5px;
    margin: 8px 0 36px;
  }

  .sig-block { margin-top: 16px; }
  .sig-label { font-size: 11.5px; font-weight: 700; margin-bottom: 2px; }
  .sig-rif   { font-size: 11.5px; margin-top: 2px; }
  .sig-space { height: 52px; }

  .annex {
    margin-top: 36px; font-size: 10.5px; font-style: italic;
    color: #444; line-height: 1.7;
  }
  .annex strong { font-style: normal; font-weight: 700; }
</style>
</head><body>

  <!-- HEADER -->
  <div class="header">
    <div class="kia-logo">
      <img src="${KIA_LOGO_DATA_URI}" alt="KIA" />
    </div>
    <div class="company-block">
      <div class="company-name">MOTOCENTRO II, C.A</div>
      <div>RIF. J-07577719-0</div>
      <div>Av. Bolívar Oeste Edif. Motocentro Piso PB. Local 292 Sector La Romana, Maracay Edo. Aragua</div>
      <div>Telfs. (0424) 349.40.18 - (0424) 347.32.39 - (0424) 349.41.98</div>
      <div>E-mail: servicio@motocentro2.com</div>
    </div>
  </div>

  <!-- TITLE -->
  <div class="doc-title">Declaración de Origen y Destino Lícito de Fondos en Divisas</div>

  <!-- PAYER -->
  <div class="payer-line">Identificacion del pagador:${[deal.cliente_nombre, (deal as any).cliente_apellidos].filter(Boolean).join(' ') || '___________________________'}</div>
  <div class="payer-rif">CI/RIF: ${deal.cliente_rif_tipo || 'V'}.- ${deal.cliente_rif || '_______________'}${ (deal as any).cliente_estado_civil ? ' &nbsp;&nbsp; Estado Civil: ' + (deal as any).cliente_estado_civil : ''}</div>

  <!-- BODY TEXT -->
  <div class="body-text">
    El pagador declara y garantiza <strong>BAJO FE DE JURAMENTO</strong> que las divisas entregadas a <strong>MOTOCENTRO II , C.A</strong> (J-07577719-0), no
    provienen ni se destinan al ejercicio de ninguna actividad ilícita relacionada con la legitimacion de capitales o el
    financiamiento al terrorismo. De manera que libera a la empresa receptora de los fondos de cualquier responsabilidad
    civil, penal o administrativa que pudiera originarse del negocio juridico celebrado, con ocasion de:
  </div>

  <!-- CHECKBOXES -->
  <div class="checkboxes">
    <div class="cb-row"><div class="cb-empty"></div><div class="cb-label">Sevicios de Taller</div></div>
    <div class="cb-row"><div class="cb-empty"></div><div class="cb-label">Venta de repuestos</div></div>
    <div class="cb-row"><div class="cb-filled"></div><div class="cb-label">Venta de Vehiculo</div></div>
  </div>

  <!-- AMOUNT -->
  <div class="amount-block">
    <span class="amount-label">MONTO RECIBIDO EN DIVISAS: </span><span class="amount-value">$${totalFmt}</span>
  </div>
  <div class="amount-words">${wordsLine}</div>

  <!-- SIGNATURE -->
  <div class="sig-block">
    <div class="sig-label">Firma:</div>
    <div class="sig-space"></div>
    <div class="sig-rif">CI/RIF: ${deal.cliente_rif_tipo || 'V'}.- ${deal.cliente_rif || '_______________'}</div>
  </div>

  <!-- ANNEX -->
  <div class="annex">
    <em>Por favor adjuntar a esta declaratoria:</em><br>
    <strong>Copia legible de la cédula de identidad</strong><br>
    En caso de tratarse de personas juridicas adjuntar copia del RIF.
  </div>

</body></html>`
  }

  const handlePrintNota = () => {
    const printWindow = window.open('', '_blank')
    if (!printWindow) return
    printWindow.document.write(buildNotaHTML())
    printWindow.document.close()
    printWindow.focus()
    setTimeout(() => { printWindow.print(); onPrint() }, 500)
  }

  const handlePrintLegitimacion = () => {
    const printWindow = window.open('', '_blank')
    if (!printWindow) return
    printWindow.document.write(buildLegitimacionHTML())
    printWindow.document.close()
    printWindow.focus()
    setTimeout(() => printWindow.print(), 500)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '16px', padding: '32px', maxWidth: '520px', width: '100%' }}>
        <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>Documentos de Entrega</div>
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '24px', lineHeight: 1.6 }}>
          Negocio #{deal.negocio_num} — {deal.cliente_nombre}
        </div>

        {/* Driver toggle */}
        <div style={{ marginBottom: '20px', padding: '16px', background: 'var(--bg-deep)', borderRadius: '10px', border: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: conductorAjeno ? '16px' : 0 }}>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>¿Persona diferente al cliente retira el vehículo?</div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>Activa si un conductor o representante viene a buscar el carro</div>
            </div>
            <div
              onClick={() => { setConductorAjeno(v => !v); setConductorNombre(''); setConductorCedula('') }}
              style={{ width: '44px', height: '24px', borderRadius: '12px', background: conductorAjeno ? '#BB162B' : 'var(--border)', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}
            >
              <div style={{ position: 'absolute', top: '3px', left: conductorAjeno ? '23px' : '3px', width: '18px', height: '18px', borderRadius: '50%', background: '#fff', transition: 'left 0.2s', boxShadow: '0 1px 4px rgba(0,0,0,0.3)' }} />
            </div>
          </div>
          {conductorAjeno && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={s.label}>Nombre completo del conductor *</label>
                <input style={s.input} value={conductorNombre} onChange={e => setConductorNombre(e.target.value)} placeholder="Nombre y Apellido" />
              </div>
              <div>
                <label style={s.label}>Cédula de Identidad</label>
                <input style={s.input} value={conductorCedula} onChange={e => setConductorCedula(e.target.value)} placeholder="V-00.000.000" />
              </div>
            </div>
          )}
        </div>

        {/* Print buttons */}
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '10px', marginBottom: '16px' }}>
          <button
            onClick={handlePrintNota}
            disabled={conductorAjeno && !conductorNombre.trim()}
            style={{ ...s.btnGreen, opacity: conductorAjeno && !conductorNombre.trim() ? 0.5 : 1, cursor: conductorAjeno && !conductorNombre.trim() ? 'not-allowed' : 'pointer' }}
          >
            🖨 Imprimir Nota de Entrega
          </button>
          <button onClick={() => {
            const pw = window.open('', '_blank')
            if (!pw) return
            pw.document.write(buildDeclaracionHTML())
            pw.document.close()
            pw.focus()
            setTimeout(() => pw.print(), 500)
          }} style={{ ...s.btnGray, borderColor: 'rgba(245,158,11,0.5)', color: '#F59E0B' }}>
            📝 Declaración de Pagos (Zelle/Wire)
          </button>
          <button onClick={handlePrintLegitimacion} style={{ ...s.btnGray, borderColor: 'rgba(74,158,255,0.5)', color: '#4a9eff' }}>
            📋 Imprimir Legitimación de Capitales
          </button>
        </div>

        <button onClick={onDismiss} style={{ ...s.btnGray, width: '100%' }}>Cerrar</button>
      </div>
    </div>
  )
}

// Convert number to Spanish words (simplified for amounts)
function numToWords(n: number): string {
  const num = Math.floor(n)
  if (num === 0) return 'cero'
  const ones = ['','uno','dos','tres','cuatro','cinco','seis','siete','ocho','nueve','diez','once','doce','trece','catorce','quince','dieciséis','diecisiete','dieciocho','diecinueve','veinte','veintiuno','veintidós','veintitrés','veinticuatro','veinticinco','veintiséis','veintisiete','veintiocho','veintinueve']
  const tens = ['','','veinte','treinta','cuarenta','cincuenta','sesenta','setenta','ochenta','noventa']
  const hundreds = ['','cien','doscientos','trescientos','cuatrocientos','quinientos','seiscientos','setecientos','ochocientos','novecientos']
  const convert = (n: number): string => {
    if (n < 30) return ones[n]
    if (n < 100) { const t = Math.floor(n/10); const o = n%10; return o === 0 ? tens[t] : tens[t] + ' y ' + ones[o] }
    if (n < 1000) { const h = Math.floor(n/100); const r = n%100; return r === 0 ? hundreds[h] : (h === 1 ? 'ciento' : hundreds[h]) + ' ' + convert(r) }
    if (n < 1000000) { const m = Math.floor(n/1000); const r = n%1000; const ms = m === 1 ? 'mil' : convert(m) + ' mil'; return r === 0 ? ms : ms + ' ' + convert(r) }
    return n.toString()
  }
  return convert(num)
}
