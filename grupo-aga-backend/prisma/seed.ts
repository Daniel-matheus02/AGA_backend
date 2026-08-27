import 'dotenv/config';
import * as argon2 from 'argon2';
import { createHash } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

const must = (name:string) => {
  const value=process.env[name];
  if(!value) throw new Error(`${name} is required for seed`);
  return value;
};
const hash=(value:string)=>createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
const prisma=new PrismaClient({adapter:new PrismaPg({connectionString:must('DATABASE_URL')})});

async function main(){
  const tenant=await prisma.tenant.upsert({where:{slug:'grupo-aga'},update:{name:'Grupo AGA',active:true},create:{name:'Grupo AGA',slug:'grupo-aga'}});
  const merchant=await prisma.merchant.upsert({
    where:{tenantId_cnpjHash:{tenantId:tenant.id,cnpjHash:hash('12.345.678/0001-90')}},
    update:{active:true},
    create:{tenantId:tenant.id,legalName:'Rota Norte Serviços Automotivos LTDA',tradeName:'Auto Center Rota Norte',cnpjHash:hash('12.345.678/0001-90'),feeBps:300}
  });
  const [adminHash,merchantHash,clientHash]=await Promise.all([
    argon2.hash(must('SEED_ADMIN_PASSWORD'),{type:argon2.argon2id,memoryCost:65536,timeCost:3,parallelism:1}),
    argon2.hash(must('SEED_MERCHANT_PASSWORD'),{type:argon2.argon2id,memoryCost:65536,timeCost:3,parallelism:1}),
    argon2.hash(must('SEED_CLIENT_PASSWORD'),{type:argon2.argon2id,memoryCost:65536,timeCost:3,parallelism:1}),
  ]);
  const admin=await prisma.user.upsert({where:{tenantId_email:{tenantId:tenant.id,email:must('SEED_ADMIN_EMAIL').toLowerCase()}},update:{passwordHash:adminHash,status:'ACTIVE'},create:{tenantId:tenant.id,role:'ADMIN',status:'ACTIVE',name:'Administrador AGA',email:must('SEED_ADMIN_EMAIL').toLowerCase(),passwordHash:adminHash}});
  const merchantUser=await prisma.user.upsert({where:{tenantId_email:{tenantId:tenant.id,email:must('SEED_MERCHANT_EMAIL').toLowerCase()}},update:{passwordHash:merchantHash,status:'ACTIVE',merchantId:merchant.id},create:{tenantId:tenant.id,merchantId:merchant.id,role:'MERCHANT',status:'ACTIVE',name:'Lojista Rota Norte',email:must('SEED_MERCHANT_EMAIL').toLowerCase(),passwordHash:merchantHash}});
  const client=await prisma.user.upsert({where:{tenantId_email:{tenantId:tenant.id,email:must('SEED_CLIENT_EMAIL').toLowerCase()}},update:{passwordHash:clientHash,status:'ACTIVE'},create:{tenantId:tenant.id,role:'CLIENT',status:'ACTIVE',name:'Gabriel Silva',email:must('SEED_CLIENT_EMAIL').toLowerCase(),cpfHash:hash('992.950.592-04'),passwordHash:clientHash}});
  await prisma.creditAccount.upsert({where:{userId:client.id},update:{limitCents:600000n,usedCents:115000n,blockedCents:0n},create:{userId:client.id,limitCents:600000n,usedCents:115000n}});
  const products=[
    ['Troca de óleo premium','Manutenção',7990n],['Revisão preventiva','Serviços',14990n],['Kit relação','Peças',21990n],['Cesta básica família','Alimentação',12990n]
  ] as const;
  for(const [name,category,priceCents] of products){
    const found=await prisma.product.findFirst({where:{tenantId:tenant.id,merchantId:merchant.id,name}});
    if(!found) await prisma.product.create({data:{tenantId:tenant.id,merchantId:merchant.id,name,category,priceCents,description:`Oferta demonstrativa: ${name}`}});
  }
  const tracker=await prisma.tracker.upsert({where:{externalId:'AGA-7829'},update:{userId:client.id,status:'ONLINE',lastSeenAt:new Date(),lastLatitude:'-3.092300',lastLongitude:'-60.023500',lastSpeedKph:'0',batteryPct:92},create:{tenantId:tenant.id,userId:client.id,externalId:'AGA-7829',plate:'QZA-4A21',vehicleModel:'Honda CG 160',status:'ONLINE',lastSeenAt:new Date(),lastLatitude:'-3.092300',lastLongitude:'-60.023500',lastSpeedKph:'0',batteryPct:92}});
  const count=await prisma.trackingPoint.count({where:{trackerId:tracker.id}});
  if(count===0) await prisma.trackingPoint.create({data:{trackerId:tracker.id,latitude:'-3.092300',longitude:'-60.023500',speedKph:'0',batteryPct:92,ignitionOn:false,recordedAt:new Date()}});

  const policy=await prisma.insurancePolicy.upsert({
    where:{providerReference:'AGA-DEMO-POLICY-001'},
    update:{status:'ACTIVE',trackerId:tracker.id,endsAt:new Date(Date.now()+365*86400_000)},
    create:{tenantId:tenant.id,userId:client.id,trackerId:tracker.id,provider:'SEGURADORA_DEMO',providerReference:'AGA-DEMO-POLICY-001',status:'ACTIVE',coverage:{collision:true,theft:true,robbery:true,thirdParty:true,assistance24h:true},startsAt:new Date(),endsAt:new Date(Date.now()+365*86400_000)}
  });
  const paymentCount=await prisma.payment.count({where:{tenantId:tenant.id,userId:client.id}});
  if(paymentCount===0){
    await prisma.payment.createMany({data:Array.from({length:10},(_,i)=>({tenantId:tenant.id,userId:client.id,amountCents:4930n,dueDate:new Date(Date.now()+(i+1)*86400_000)}))});
  }
  console.log({tenant:tenant.slug,admin:admin.email,merchant:merchantUser.email,client:client.email,policy:policy.providerReference});
}
main().finally(()=>prisma.$disconnect());
