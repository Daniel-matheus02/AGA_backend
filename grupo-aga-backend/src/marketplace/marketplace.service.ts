import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { EventsService } from '../events/events.service';
import { AuthenticatedUser } from '../common/auth.types';
import { CreateOrderDto, CreateProductDto, CreateCategoryDto, AdminCreateProductDto } from './dto';
import { assertBalanced } from '../common/services/money';

@Injectable()
export class MarketplaceService {
  constructor(private readonly prisma:PrismaService,private readonly events:EventsService){}

  listProducts(user:AuthenticatedUser,category?:string){
    return this.prisma.product.findMany({where:{tenantId:user.tenantId,active:true,...(category?{category}:{})},include:{merchant:{select:{id:true,tradeName:true}}},orderBy:{createdAt:'desc'},take:200});
  }

  listCategories(user:AuthenticatedUser){
    return this.prisma.product.groupBy({
      by:['category'],
      where:{tenantId:user.tenantId},
      _count:{_all:true},
      orderBy:{category:'asc'},
    });
  }

  async createCategory(user:AuthenticatedUser,dto:CreateCategoryDto){
    // Uma categoria só existe no schema através de produtos. Insere um produto
    // "placeholder" inativo nessa nova categoria para que ela apareça na curadoria.
    const merchant=await this.prisma.merchant.findFirst({where:{tenantId:user.tenantId,active:true}});
    if(!merchant) throw new BadRequestException('Nenhum lojista ativo disponível');
    const name='Oferta em '+dto.name;
    const existing=await this.prisma.product.findFirst({where:{tenantId:user.tenantId,merchantId:merchant.id,name}});
    if(existing) throw new BadRequestException('Categoria já existe');
    return this.prisma.product.create({data:{tenantId:user.tenantId,merchantId:merchant.id,name,category:dto.name,priceCents:0n,description:'Categoria criada para o marketplace.',active:false}});
  }

  async createAdminProduct(user:AuthenticatedUser,dto:AdminCreateProductDto){
    const merchant=await this.prisma.merchant.findFirst({where:{id:dto.merchantId,tenantId:user.tenantId}});
    if(!merchant) throw new BadRequestException('Lojista não encontrado');
    return this.prisma.product.create({data:{tenantId:user.tenantId,merchantId:merchant.id,name:dto.name,description:dto.description,category:dto.category,priceCents:BigInt(dto.priceCents)}});
  }

  async createProduct(user:AuthenticatedUser,dto:CreateProductDto){
    if(user.role==='MERCHANT'&&!user.merchantId) throw new ForbiddenException('Merchant membership required');
    const merchantId=user.role==='MERCHANT'?user.merchantId:undefined;
    if(!merchantId) throw new BadRequestException('merchantId is required for admin-created products in this starter');
    return this.prisma.product.create({data:{tenantId:user.tenantId,merchantId,name:dto.name,description:dto.description,category:dto.category,priceCents:BigInt(dto.priceCents)}});
  }

  async createOrder(user:AuthenticatedUser,dto:CreateOrderDto){
    const product=await this.prisma.product.findFirst({where:{id:dto.productId,tenantId:user.tenantId,active:true},include:{merchant:true}});
    if(!product) throw new NotFoundException('Product not found');
    let clientId:string;
    if(user.role==='CLIENT') clientId=user.sub;
    else if(user.role==='MERCHANT') {
      if(product.merchantId!==user.merchantId) throw new ForbiddenException('Product does not belong to this merchant');
      if(!dto.clientId) throw new BadRequestException('clientId is required');
      clientId=dto.clientId;
    } else throw new ForbiddenException();
    const client=await this.prisma.user.findFirst({where:{id:clientId,tenantId:user.tenantId,role:'CLIENT',status:'ACTIVE'}});
    if(!client) throw new NotFoundException('Client not found');
    const fee=product.priceCents*BigInt(product.merchant.feeBps)/10000n;
    const net=product.priceCents-fee;
    return this.prisma.$transaction(async tx=>{
      const order=await tx.order.create({data:{tenantId:user.tenantId,clientId,merchantId:product.merchantId,productId:product.id,amountCents:product.priceCents,feeCents:fee,netCents:net,authorizationExpiresAt:new Date(Date.now()+10*60_000)}});
      await tx.notification.create({data:{userId:clientId,type:'ORDER_AUTHORIZATION_REQUIRED',title:'Autorize sua compra',body:`${product.name} no valor de R$ ${(Number(product.priceCents)/100).toFixed(2)}.`,data:{orderId:order.id}}});
      await this.events.append({tenantId:user.tenantId,type:'order.authorization.requested',aggregateType:'Order',aggregateId:order.id,payload:{orderId:order.id,clientId,merchantId:product.merchantId,productId:product.id,amountCents:product.priceCents.toString(),expiresAt:order.authorizationExpiresAt.toISOString()},audience:[`user:${clientId}`,`merchant:${product.merchantId}`,'role:ADMIN']},tx);
      return order;
    });
  }

  async authorize(user:AuthenticatedUser,orderId:string){
    return this.prisma.$transaction(async tx=>{
      const order=await tx.order.findFirst({where:{id:orderId,tenantId:user.tenantId,clientId:user.sub},include:{product:true,merchant:true}});
      if(!order) throw new NotFoundException('Order not found');
      if(order.status!=='PENDING_CLIENT_AUTHORIZATION') throw new BadRequestException('Order is not pending authorization');
      if(order.authorizationExpiresAt<new Date()) throw new BadRequestException('Authorization expired');
      const updated=await tx.$queryRaw<Array<{id:string}>>`
        UPDATE "CreditAccount"
        SET "usedCents" = "usedCents" + ${order.amountCents}, "version" = "version" + 1, "updatedAt" = NOW()
        WHERE "userId" = ${user.sub}
          AND ("limitCents" - "usedCents" - "blockedCents") >= ${order.amountCents}
        RETURNING "id"`;
      if(updated.length!==1) throw new BadRequestException('Insufficient credit limit');
      const approved=await tx.order.update({where:{id:order.id},data:{status:'AUTHORIZED',authorizedAt:new Date()}});
      const ledger=await tx.ledgerTransaction.create({data:{referenceType:'ORDER',referenceId:order.id,description:`Marketplace order ${order.id}`}});
      await tx.ledgerEntry.createMany({data:[
        {transactionId:ledger.id,accountCode:`CLIENT_RECEIVABLE:${user.sub}`,amountCents:order.amountCents},
        {transactionId:ledger.id,accountCode:`MERCHANT_PAYABLE:${order.merchantId}`,amountCents:-order.netCents},
        {transactionId:ledger.id,accountCode:'PLATFORM_FEE_REVENUE',amountCents:-order.feeCents},
      ]});
      assertBalanced([order.amountCents,-order.netCents,-order.feeCents]);
      await tx.settlement.create({data:{merchantId:order.merchantId,orderId:order.id,grossCents:order.amountCents,feeCents:order.feeCents,netCents:order.netCents,scheduledFor:new Date(Date.now()+86400_000)}});
      await tx.notification.create({data:{userId:user.sub,type:'ORDER_AUTHORIZED',title:'Compra autorizada',body:`Sua compra de ${order.product.name} foi aprovada.`,data:{orderId:order.id}}});
      await this.events.append({tenantId:user.tenantId,type:'order.authorized',aggregateType:'Order',aggregateId:order.id,payload:{orderId:order.id,clientId:user.sub,merchantId:order.merchantId,amountCents:order.amountCents.toString(),netCents:order.netCents.toString()},audience:[`user:${user.sub}`,`merchant:${order.merchantId}`,'role:ADMIN','role:FINANCE']},tx);
      return approved;
    },{isolationLevel:'Serializable'});
  }

  async reject(user:AuthenticatedUser,orderId:string){
    const order=await this.prisma.order.findFirst({where:{id:orderId,clientId:user.sub,tenantId:user.tenantId}});
    if(!order) throw new NotFoundException('Order not found');
    if(order.status!=='PENDING_CLIENT_AUTHORIZATION') throw new BadRequestException('Order is not pending authorization');
    const updated=await this.prisma.order.update({where:{id:orderId},data:{status:'REJECTED'}});
    await this.events.append({tenantId:user.tenantId,type:'order.rejected',aggregateType:'Order',aggregateId:orderId,payload:{orderId,clientId:user.sub,merchantId:order.merchantId},audience:[`user:${user.sub}`,`merchant:${order.merchantId}`,'role:ADMIN']});
    return updated;
  }

  listClientOrders(user:AuthenticatedUser){return this.prisma.order.findMany({where:{clientId:user.sub},include:{product:true,merchant:{select:{tradeName:true}}},orderBy:{createdAt:'desc'},take:100})}
  listMerchantOrders(user:AuthenticatedUser){if(!user.merchantId)throw new ForbiddenException();return this.prisma.order.findMany({where:{merchantId:user.merchantId},include:{product:true,client:{select:{name:true,email:true}}},orderBy:{createdAt:'desc'},take:200})}
  listSettlements(user:AuthenticatedUser){if(!user.merchantId)throw new ForbiddenException();return this.prisma.settlement.findMany({where:{merchantId:user.merchantId},include:{order:{include:{product:true}}},orderBy:{createdAt:'desc'},take:200})}
}
