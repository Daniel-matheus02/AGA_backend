import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../common/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CreateOrderDto, CreateProductDto, CreateCategoryDto, AdminCreateProductDto } from './dto';
import { MarketplaceService } from './marketplace.service';
@ApiTags('marketplace')
@Controller('marketplace')
export class MarketplaceController{
  constructor(private readonly service:MarketplaceService){}
  @Get('products') list(@CurrentUser()u:AuthenticatedUser,@Query('category')c?:string){return this.service.listProducts(u,c)}
  @Get('categories') categories(@CurrentUser()u:AuthenticatedUser){return this.service.listCategories(u)}
  @Roles('ADMIN') @Idempotent() @Post('categories') category(@CurrentUser()u:AuthenticatedUser,@Body()d:CreateCategoryDto){return this.service.createCategory(u,d)}
  @Roles('ADMIN') @Idempotent() @Post('admin/products') adminProduct(@CurrentUser()u:AuthenticatedUser,@Body()d:AdminCreateProductDto){return this.service.createAdminProduct(u,d)}
  @Roles('MERCHANT') @Idempotent() @Post('products') product(@CurrentUser()u:AuthenticatedUser,@Body()d:CreateProductDto){return this.service.createProduct(u,d)}
  @Roles('CLIENT','MERCHANT') @Idempotent() @Post('orders') order(@CurrentUser()u:AuthenticatedUser,@Body()d:CreateOrderDto){return this.service.createOrder(u,d)}
  @Roles('CLIENT') @Idempotent() @Post('orders/:id/authorize') authorize(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string){return this.service.authorize(u,id)}
  @Roles('CLIENT') @Idempotent() @Post('orders/:id/reject') reject(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string){return this.service.reject(u,id)}
  @Roles('CLIENT') @Get('orders/me') clientOrders(@CurrentUser()u:AuthenticatedUser){return this.service.listClientOrders(u)}
  @Roles('MERCHANT') @Get('merchant/orders') merchantOrders(@CurrentUser()u:AuthenticatedUser){return this.service.listMerchantOrders(u)}
  @Roles('MERCHANT') @Get('merchant/settlements') settlements(@CurrentUser()u:AuthenticatedUser){return this.service.listSettlements(u)}
}
