import type { PaymentProvider } from './types';
import { paymobProvider } from './paymob';
import { piNetworkProvider } from './piNetwork';
const providers: Record<string, PaymentProvider> = { paymob: paymobProvider, pi_network: piNetworkProvider };
export function getPaymentProvider(id: string): PaymentProvider { const p = providers[id]; if (!p) throw new Error(`Unknown payment provider: ${id}`); return p; }
export function listAvailableProviders() { return Object.keys(providers); }
