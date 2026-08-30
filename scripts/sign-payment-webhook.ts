import { createHmac, randomUUID } from 'node:crypto';
const secret=process.env.PAYMENT_WEBHOOK_SECRET;
if(!secret)throw new Error('PAYMENT_WEBHOOK_SECRET is required');
const providerReference=process.argv[2];
if(!providerReference)throw new Error('Usage: tsx scripts/sign-payment-webhook.ts <providerReference>');
const body=JSON.stringify({providerReference,status:'PAID',occurredAt:new Date().toISOString()});
const timestamp=Math.floor(Date.now()/1000).toString();
const signature=createHmac('sha256',secret).update(`${timestamp}.`).update(body).digest('hex');
console.log(`curl -X POST http://localhost:3000/v1/payments/provider/webhook \\
  -H 'Content-Type: application/json' \\
  -H 'X-AGA-Timestamp: ${timestamp}' \\
  -H 'X-AGA-Event-Id: ${randomUUID()}' \\
  -H 'X-AGA-Signature: sha256=${signature}' \\
  --data '${body}'`);
