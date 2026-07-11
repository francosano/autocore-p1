import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function POST(req: NextRequest) {
  try {
    const { email, role, full_name, crm_role, npa_can_view_crm } = await req.json()

    if (!email || !role) {
      return NextResponse.json({ error: 'Email y rol son requeridos' }, { status: 400 })
    }

    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // Verify caller is authenticated
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

    const token = authHeader.replace('Bearer ', '')
    const { data: { user: caller }, error: authError } = await supabaseAdmin.auth.getUser(token)
    if (authError || !caller) return NextResponse.json({ error: 'Token inválido' }, { status: 401 })

    // Verify caller has admin/manager role
    const { data: roleData } = await supabaseAdmin
      .from('user_roles')
      .select('role')
      .eq('user_id', caller.id)
      .single()

    const allowedRoles = ['admin', 'manager', 'administrador', 'gerente']
    if (!roleData || !allowedRoles.includes(roleData.role)) {
      return NextResponse.json({ error: 'Sin permisos para invitar usuarios' }, { status: 403 })
    }

    // Send invitation email via Supabase Auth
    const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo: (process.env.NEXT_PUBLIC_SITE_URL || req.nextUrl.origin) + '/dashboard',
      data: { full_name: full_name || '' }
    })

    if (error) return NextResponse.json({ error: error.message }, { status: 400 })

    // Pre-assign role and CRM settings
    if (data.user) {
      await supabaseAdmin.from('user_roles').upsert({
        user_id: data.user.id,
        email: email.trim(),
        full_name: full_name?.trim() || null,
        role,
        crm_role: npa_can_view_crm ? (crm_role || null) : null,
        npa_can_view_crm: !!npa_can_view_crm,
        is_active: true,
      }, { onConflict: 'user_id' })

      // Pre-create permissions row based on role defaults
      // (useNPAPermissions will fall back to ROLE_DEFAULTS if no row exists,
      //  but we create it so admins can customize later)
      await supabaseAdmin.from('user_permissions').upsert({
        user_id: data.user.id,
        npa_can_view_crm: !!npa_can_view_crm,
      }, { onConflict: 'user_id' })
    }

    return NextResponse.json({ success: true, userId: data.user?.id })
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Error interno' }, { status: 500 })
  }
}