import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/auth/server';
export async function GET(req:NextRequest){const expected=process.env.CRON_SECRET;if(!expected||req.headers.get('authorization')!==`Bearer ${expected}`)return NextResponse.json({error:'Unauthorized'},{status:401});const {data,error}=await getAdminClient().rpc('release_expired_reservations');if(error)return NextResponse.json({error:'Reservation cleanup failed'},{status:500});return NextResponse.json({released:data??0});}
