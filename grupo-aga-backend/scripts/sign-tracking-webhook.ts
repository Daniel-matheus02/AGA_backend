import { createHmac, randomUUID } from 'node:crypto';
const secret=process.env.TRACKING_WEBHOOK_SECRET;
if(!secret)throw new Error('TRACKING_WEBHOOK_SECRET is required');
const body=JSON.stringify({trackerExternalId:'AGA-7829',latitude:-3.0923,longitude:-60.0235,speedKph:32.4,heading:90,ignitionOn:true,batteryPct:91,recordedAt:new Date().toISOString()});
const timestamp=Math.floor(Date.now()/1000).toString();
const signature=createHmac('sha256',secret).update(`${timestamp}.`).update(body).digest('hex');
console.log(`curl -X POST http://localhost:3000/v1/tracking/provider/webhook \\\n  -H 'Content-Type: application/json' \\\n  -H 'X-AGA-Timestamp: ${timestamp}' \\\n  -H 'X-AGA-Event-Id: ${randomUUID()}' \\\n  -H 'X-AGA-Signature: sha256=${signature}' \\\n  --data '${body}'`);
