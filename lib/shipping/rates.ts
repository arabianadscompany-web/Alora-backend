export type ShippingQuote = { fee: number; currency: 'EGP' | 'USD'; carrier: string; zone: string; estimatedDays: string };

const EGYPT: Record<string, ShippingQuote> = {
  cairo: { fee: 50, currency: 'EGP', carrier: 'BOSTA', zone: 'GREATER_CAIRO_GIZA', estimatedDays: '1-2 business days' },
  giza: { fee: 50, currency: 'EGP', carrier: 'BOSTA', zone: 'GREATER_CAIRO_GIZA', estimatedDays: '1-2 business days' },
  alexandria: { fee: 70, currency: 'EGP', carrier: 'BOSTA', zone: 'DELTA_CANAL', estimatedDays: '2-3 business days' },
  dakahlia: { fee: 70, currency: 'EGP', carrier: 'BOSTA', zone: 'DELTA_CANAL', estimatedDays: '2-3 business days' },
  sharqia: { fee: 70, currency: 'EGP', carrier: 'BOSTA', zone: 'DELTA_CANAL', estimatedDays: '2-3 business days' },
  gharbia: { fee: 70, currency: 'EGP', carrier: 'BOSTA', zone: 'DELTA_CANAL', estimatedDays: '2-3 business days' },
  monufia: { fee: 70, currency: 'EGP', carrier: 'BOSTA', zone: 'DELTA_CANAL', estimatedDays: '2-3 business days' },
  qalyubia: { fee: 70, currency: 'EGP', carrier: 'BOSTA', zone: 'DELTA_CANAL', estimatedDays: '2-3 business days' },
  ismailia: { fee: 70, currency: 'EGP', carrier: 'BOSTA', zone: 'DELTA_CANAL', estimatedDays: '2-3 business days' },
  suez: { fee: 70, currency: 'EGP', carrier: 'BOSTA', zone: 'DELTA_CANAL', estimatedDays: '2-3 business days' },
  port_said: { fee: 70, currency: 'EGP', carrier: 'BOSTA', zone: 'DELTA_CANAL', estimatedDays: '2-3 business days' },
  behira: { fee: 70, currency: 'EGP', carrier: 'BOSTA', zone: 'DELTA_CANAL', estimatedDays: '2-3 business days' },
  kfr_el_sheikh: { fee: 70, currency: 'EGP', carrier: 'BOSTA', zone: 'DELTA_CANAL', estimatedDays: '2-3 business days' },
  damietta: { fee: 70, currency: 'EGP', carrier: 'BOSTA', zone: 'DELTA_CANAL', estimatedDays: '2-3 business days' },
  fayoum: { fee: 90, currency: 'EGP', carrier: 'BOSTA', zone: 'UPPER_EGYPT_RED_SEA', estimatedDays: '2-4 business days' },
  beni_suef: { fee: 90, currency: 'EGP', carrier: 'BOSTA', zone: 'UPPER_EGYPT_RED_SEA', estimatedDays: '2-4 business days' },
  minya: { fee: 90, currency: 'EGP', carrier: 'BOSTA', zone: 'UPPER_EGYPT_RED_SEA', estimatedDays: '2-4 business days' },
  assiut: { fee: 90, currency: 'EGP', carrier: 'BOSTA', zone: 'UPPER_EGYPT_RED_SEA', estimatedDays: '2-4 business days' },
  sohag: { fee: 90, currency: 'EGP', carrier: 'BOSTA', zone: 'UPPER_EGYPT_RED_SEA', estimatedDays: '2-4 business days' },
  qena: { fee: 90, currency: 'EGP', carrier: 'BOSTA', zone: 'UPPER_EGYPT_RED_SEA', estimatedDays: '2-4 business days' },
  luxor: { fee: 90, currency: 'EGP', carrier: 'BOSTA', zone: 'UPPER_EGYPT_RED_SEA', estimatedDays: '2-4 business days' },
  aswan: { fee: 90, currency: 'EGP', carrier: 'BOSTA', zone: 'UPPER_EGYPT_RED_SEA', estimatedDays: '3-5 business days' },
  red_sea: { fee: 90, currency: 'EGP', carrier: 'BOSTA', zone: 'UPPER_EGYPT_RED_SEA', estimatedDays: '3-5 business days' },
};

export function calculateShipping(input: { country: string; governorate?: string; city?: string; currency?: 'EGP' | 'USD' }): ShippingQuote {
  const country = input.country.trim().toLowerCase();
  if (country === 'egypt' || country === 'eg' || country === 'egy') {
    const key = (input.governorate || input.city || '').trim().toLowerCase().replace(/\s+/g, '_');
    const quote = EGYPT[key];
    if (!quote) return { fee: 90, currency: 'EGP', carrier: 'BOSTA', zone: 'REMOTE_EGYPT', estimatedDays: '3-5 business days' };
    return quote;
  }
  const zone = ['saudi arabia','sa','uae','united arab emirates','kuwait','qatar','bahrain','oman'].includes(country)
    ? { name: 'GCC_MIDDLE_EAST', fee: 35, days: '3-6 business days' }
    : ['france','germany','italy','spain','netherlands','belgium','united kingdom','uk'].includes(country)
      ? { name: 'EUROPE', fee: 55, days: '4-8 business days' }
      : { name: 'NORTH_AMERICA_OTHER', fee: 75, days: '5-10 business days' };
  return { fee: zone.fee, currency: input.currency === 'USD' ? 'USD' : 'EGP', carrier: 'DHL', zone: zone.name, estimatedDays: zone.days };
}
