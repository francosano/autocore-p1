// TARGET: C:\Users\Franco Sano\Documents\autocore\autocore-npa\app\sesiones\page.tsx
// Manager-only view of login_audit. RLS already restricts reads to is_manager(),
// this gate is UI-level defense in depth.
// ADJUST LINE 8 to your actual supabase client import if different.
'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase';

type AuditRow = {
  id: number;
  email: string | null;
  app: string;
  event: string;
  ip: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  isp: string | null;
  user_agent: string | null;
  created_at: string;
};

export default function SesionesPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [filtroUsuario, setFiltroUsuario] = useState('');
  const [filtroApp, setFiltroApp] = useState('');
  const [dias, setDias] = useState(7);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setErrorMsg('');
      try {
        const { data: userData } = await (supabase as any).auth.getUser();
        const uid = userData?.user?.id || '';
        // Gerencia-only page (was a hardcoded Motocentro manager email in NPA).
        const { data: roleRow } = await (supabase as any)
          .from('user_roles').select('role').eq('user_id', uid).single();
        if (!['admin', 'administrador', 'manager'].includes(roleRow?.role || '')) {
          setDenied(true);
          setLoading(false);
          return;
        }
        const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
        const { data, error } = await (supabase as any)
          .from('login_audit')
          .select('*')
          .gte('created_at', desde)
          .order('created_at', { ascending: false })
          .limit(1000);
        if (error) {
          setErrorMsg(error.message || 'Error consultando login_audit');
        } else if (Array.isArray(data)) {
          setRows(data as AuditRow[]);
        }
      } catch (e: any) {
        setErrorMsg(e?.message || 'Error inesperado');
      }
      setLoading(false);
    }
    load();
  }, [dias]);

  const usuarios = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => {
      if (r.email) set.add(r.email);
    });
    return Array.from(set).sort();
  }, [rows]);

  const visibles = useMemo(() => {
    return rows.filter((r) => {
      if (filtroUsuario && r.email !== filtroUsuario) return false;
      if (filtroApp && r.app !== filtroApp) return false;
      return true;
    });
  }, [rows, filtroUsuario, filtroApp]);

  // Simple highlight: rows whose country differs from the user's most common country.
  const paisHabitual = useMemo(() => {
    const conteo: Record<string, Record<string, number>> = {};
    rows.forEach((r) => {
      if (!r.email || !r.country) return;
      conteo[r.email] = conteo[r.email] || {};
      conteo[r.email][r.country] = (conteo[r.email][r.country] || 0) + 1;
    });
    const top: Record<string, string> = {};
    Object.keys(conteo).forEach((email) => {
      let best = '';
      let n = 0;
      Object.keys(conteo[email]).forEach((pais) => {
        if (conteo[email][pais] > n) {
          n = conteo[email][pais];
          best = pais;
        }
      });
      top[email] = best;
    });
    return top;
  }, [rows]);

  function fecha(iso: string) {
    const d = new Date(iso);
    return d.toLocaleString('es-VE', {
      timeZone: 'America/Caracas',
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  if (denied) {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600 }}>Sesiones</h1>
        <p>Acceso restringido.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>
        Sesiones y accesos
      </h1>
      <p style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
        Registro de inicios de sesion con ubicacion (hora de Venezuela). Filas en
        rojo: pais distinto al habitual del usuario.
      </p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <select
          value={filtroUsuario}
          onChange={(e) => setFiltroUsuario(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #ccc', borderRadius: 6 }}
        >
          <option value="">Todos los usuarios</option>
          {usuarios.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <select
          value={filtroApp}
          onChange={(e) => setFiltroApp(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #ccc', borderRadius: 6 }}
        >
          <option value="">NPA y Portal</option>
          <option value="npa">Solo NPA</option>
          <option value="portal">Solo Portal</option>
        </select>
        <select
          value={String(dias)}
          onChange={(e) => setDias(Number(e.target.value))}
          style={{ padding: '6px 10px', border: '1px solid #ccc', borderRadius: 6 }}
        >
          <option value="1">Ultimas 24 horas</option>
          <option value="7">Ultimos 7 dias</option>
          <option value="30">Ultimos 30 dias</option>
          <option value="90">Ultimos 90 dias</option>
        </select>
        <span style={{ alignSelf: 'center', fontSize: 13, color: '#666' }}>
          {visibles.length} registros
        </span>
      </div>

      {errorMsg && (
        <div
          style={{
            background: '#fef2f2',
            border: '1px solid #fca5a5',
            borderRadius: 8,
            padding: 12,
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          {errorMsg}
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 14 }}>Cargando...</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
                <th style={{ padding: 8 }}>Fecha</th>
                <th style={{ padding: 8 }}>Usuario</th>
                <th style={{ padding: 8 }}>App</th>
                <th style={{ padding: 8 }}>Ciudad</th>
                <th style={{ padding: 8 }}>Pais</th>
                <th style={{ padding: 8 }}>IP</th>
                <th style={{ padding: 8 }}>Proveedor</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((r) => {
                const inusual =
                  r.email &&
                  r.country &&
                  paisHabitual[r.email] &&
                  paisHabitual[r.email] !== r.country;
                return (
                  <tr
                    key={r.id}
                    style={{
                      borderBottom: '1px solid #eee',
                      background: inusual ? '#fef2f2' : 'transparent',
                    }}
                    title={r.user_agent || ''}
                  >
                    <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                      {fecha(r.created_at)}
                    </td>
                    <td style={{ padding: 8 }}>{r.email || '-'}</td>
                    <td style={{ padding: 8, textTransform: 'uppercase' }}>{r.app}</td>
                    <td style={{ padding: 8 }}>{r.city || '-'}</td>
                    <td
                      style={{
                        padding: 8,
                        fontWeight: inusual ? 700 : 400,
                        color: inusual ? '#b91c1c' : 'inherit',
                      }}
                    >
                      {r.country || '-'}
                    </td>
                    <td style={{ padding: 8, fontFamily: 'monospace' }}>{r.ip || '-'}</td>
                    <td style={{ padding: 8 }}>{r.isp || '-'}</td>
                  </tr>
                );
              })}
              {visibles.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: 16, color: '#666' }}>
                    Sin registros en el periodo seleccionado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}