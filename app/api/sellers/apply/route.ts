import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, requireRole } from '@/lib/auth/server';
export async function POST(req: NextRequest) {
  try {
    const { appUser } = await requireRole(req, ['customer']); const b=await req.json();
    if(!b.businessName || !b.country || !b.contactPhone) return NextResponse.json({error:'businessName, country and contactPhone are required'},{status:400});
    const db=getAdminClient();
    const {data:existing}=await db.from('sellers').select('id,status').eq('user_id',appUser.id).maybeSingle();
    if(existing) return NextResponse.json({seller:existing,reused:true});
    const {data,error}=await db.from('sellers').insert({user_id:appUser.id,business_name:String(b.businessName).slice(0,160),tax_id:b.taxId??null,country:String(b.country).slice(0,80),status:'PENDING',bank_account_details:b.bankAccountDetails??null}).select('id,business_name,status,commission_rate').single();
    if(error) throw error; return NextResponse.json({seller:data},{status:201});
  } catch(e:any){const status=e?.message==='UNAUTHENTICATED'?401:e?.message==='FORBIDDEN'?403:500; return NextResponse.json({error:status===500?'Could not submit seller application':e.message},{status});}
}
