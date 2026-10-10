import {NextRequest,NextResponse} from 'next/server';
import {getAdminClient} from '@/lib/auth/server';
export async function POST(req:NextRequest){try{const b=await req.json();const email=String(b.email??'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return NextResponse.json({error:'Invalid email'},{status:400});const {error}=await getAdminClient().from('newsletter_subs').upsert({email},{onConflict:'email'});if(error)throw error;return NextResponse.json({ok:true});}catch{return NextResponse.json({error:'Subscription failed'},{status:500});}}
