import { Injectable, Logger } from '@nestjs/common';
import { EventsService } from '../events/events.service';

/**
 * Eventos de ciclo de vida do módulo `auth`.
 *
 * Existe para que trocar a senha possa derrubar as *outras* sessões e avisá-las
 * sem que o módulo `auth` precise conhecer o realtime: ele só anexa um evento ao
 * outbox e o dispatcher entrega. Quem precisar revogar sessões de fora (o painel
 * `db-admin`, por exemplo) também pode publicar por aqui.
 */
@Injectable()
export class AuthEventsService {
  private readonly logger = new Logger(AuthEventsService.name);

  constructor(private readonly events: EventsService) {}

  /**
   * Avisa cada sessão recém-revogada, para o app encerrar na hora em vez de só
   * descobrir quando o access token expirar.
   *
   * Best-effort de propósito: a revogação já está gravada no banco, e um evento
   * que não sai não deve derrubar a operação que o disparou.
   */
  async publishSessionRevoked(input: {
    tenantId: string;
    userId: string;
    reason: string;
    sessionIds: string[];
  }): Promise<void> {
    try {
      await Promise.all(
        input.sessionIds.map((sessionId) =>
          this.events.append({
            tenantId: input.tenantId,
            type: 'session.revoked',
            aggregateType: 'Session',
            aggregateId: sessionId,
            payload: { sessionId, userId: input.userId, reason: input.reason },
            audience: [`user:${input.userId}`],
          }),
        ),
      );
    } catch (error) {
      this.logger.warn(
        `Não foi possível publicar session.revoked para ${input.userId}: ${String(error)}`,
      );
    }
  }
}
