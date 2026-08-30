import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { RedisService } from '../redis/redis.service';
import { AuthenticatedUser } from '../common/auth.types';
import { PrismaService } from '../database/prisma.service';

@WebSocketGateway({ namespace: '/events' })
export class RealtimeGateway implements OnGatewayConnection {
  @WebSocketServer() server: Server;
  constructor(private readonly jwt: JwtService, private readonly config: ConfigService, private readonly redis: RedisService, private readonly prisma:PrismaService) {}

  async onModuleInit() {
    await this.redis.subscriber.subscribe('aga:events:realtime', raw => {
      const event = JSON.parse(raw) as { type:string; audience:string[] };
      for (const room of event.audience ?? []) this.server?.to(room).emit(event.type, event);
      this.server?.to('role:ADMIN').emit('domain.event', event);
    });
  }

  async handleConnection(client: Socket) {
    try {
      const authHeader = client.handshake.headers.authorization;
      const token = client.handshake.auth?.token || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined);
      if (!token) throw new Error('missing token');
      const payload = await this.jwt.verifyAsync<AuthenticatedUser>(token, {
        secret: this.config.getOrThrow('JWT_ACCESS_SECRET'),
        issuer: this.config.getOrThrow('JWT_ISSUER'),
        audience: this.config.getOrThrow('JWT_AUDIENCE'),
      });
      const session=await this.prisma.session.findUnique({where:{id:payload.sessionId},include:{user:{select:{status:true}}}});
      if(!session||session.revokedAt||session.expiresAt<new Date()||session.user.status!=='ACTIVE') throw new Error('invalid session');
      client.data.user = payload;
      await client.join(`user:${payload.sub}`);
      await client.join(`role:${payload.role}`);
      await client.join(`tenant:${payload.tenantId}`);
      if (payload.merchantId) await client.join(`merchant:${payload.merchantId}`);
      client.emit('connected', { userId: payload.sub, role: payload.role });
    } catch { client.disconnect(true); }
  }
}
