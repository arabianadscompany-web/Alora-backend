import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/auth/server';
import { inquirePaymobMerchantOrder } from '@/lib/payments/paymob';

function statusOf(x:any){
  if(x?.is_refunded) return (x.refunded_amount_cents ?? 0) >= (x.amount_cents ?? 0) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  if(x?.is_voided || x?.is_void) return 'VOIDED';
  if(x?.pending) return 'PENDING';
  if(x?.success===true) return 'PAID';
  if(x?.success===false) return 'FAILED';
  return null;
}
export async function GET(req:NextRequest){
  if(!process.env.CRON_SECRET || req.headers.get('authorization')!==`Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({error:'Unauthorized'},{status:401});
  const db=getAdminClient();
  const {data:orders,error}=await db.from('orders').select('id,total_cents,currency,status').in('status',['PENDING_PAYMENT','PAYMENT_PROCESSING']).lt('created_at',new Date(Date.now()-2*60*1000).toISOString()).limit(50);
  if(error) return NextResponse.json({error:'Could not load pending orders'},{status:500});
  let reconciled=0;
  for(const order of orders??[]){
    try{
      const tx:any=await inquirePaymobMerchantOrder(order.id);
      if(!tx?.id || Number(tx.amount_cents)!==Number(order.total_cents) || tx.currency!==order.currency) continue;
      const status=statusOf(tx); if(!status) continue;
      const {data:attempt}=await db.from('payment_attempts').select('id').eq('order_id',order.id).eq('provider','paymob').maybeSingle();
      const {data:recorded}=await db.from('payment_transactions').upsert({order_id:order.id,payment_attempt_id:attempt?.id??null,provider:'PAYMOB',transaction_id:String(tx.id),provider_order_id:tx.order?.id?String(tx.order.id):null,status,amount_cents:tx.amount_cents,currency:tx.currency,hmac_verified:false,payload:tx,updated_at:new Date().toISOString()},{onConflict:'provider,transaction_id'}).select('id').single();
      if(recorded){await db.rpc('apply_payment_event',{p_order_id:order.id,p_payment_transaction_id:recorded.id,p_status:status}); reconciled++;}
    }catch(e){console.error('[payment reconcile]',order.id,e);}
  }
  return NextResponse.json({ok:true,reconciled,checked:orders?.length??0});
}
