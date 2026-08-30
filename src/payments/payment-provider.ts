import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

export interface PaymentIntentResult { providerReference:string; checkoutUrl:string|null; expiresAt:Date; mode:'sandbox'|'external'; }

@Injectable()
export class PaymentProvider {
  constructor(private readonly config:ConfigService){}
  async createIntent(payment:{id:string;amountCents:bigint;userId:string}):Promise<PaymentIntentResult>{
    const mode=this.config.get<'sandbox'|'external'>('PAYMENT_PROVIDER_MODE')??'sandbox';
    if(mode==='external') throw new ServiceUnavailableException('Configure the production payment provider adapter before enabling external mode');
    const providerReference=`sandbox_${randomUUID()}`;
    return {providerReference,checkoutUrl:`https://sandbox-payments.invalid/checkout/${providerReference}`,expiresAt:new Date(Date.now()+15*60_000),mode:'sandbox'};
  }
}
