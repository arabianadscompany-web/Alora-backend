import { createClient, type User } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export function getAdminClient() { return supabaseAdmin; }

export async function requireAuth(req: NextRequest): Promise<User> {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) throw new Error('UNAUTHENTICATED');
  const token = auth.slice(7).trim();
  if (!token) throw new Error('UNAUTHENTICATED');
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new Error('UNAUTHENTICATED');
  return data.user;
}

export async function requireRole(req: NextRequest, roles: string[]) {
  const user = await requireAuth(req);
  const { data, error } = await supabaseAdmin.from('users').select('id, role').eq('auth_id', user.id).single();
  if (error || !data || !roles.includes(data.role)) throw new Error('FORBIDDEN');
  return { authUser: user, appUser: data };
}
