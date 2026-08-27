# Contrato de eventos

Envelope:

```json
{
  "id": "uuid",
  "type": "order.authorized",
  "aggregateType": "Order",
  "aggregateId": "uuid",
  "payload": {},
  "audience": ["user:...", "merchant:...", "role:ADMIN"],
  "occurredAt": "2026-07-31T16:00:00.000Z"
}
```

Eventos iniciais:

- `credit.request.created`
- `credit.request.approved`
- `credit.request.rejected`
- `order.authorization.requested`
- `order.authorized`
- `order.rejected`
- `tracker.location.updated`
- `tracker.alert.created`
- `payment.schedule.created`
- `payment.intent.created`
- `payment.daily.paid`
- `payment.daily.failed`
- `protection.policy.requested`
- `protection.policy.activated`
- `protection.policy.status_changed`

Regras:

1. O nome do evento descreve algo que já aconteceu.
2. O payload é versionado quando houver mudança incompatível.
3. Consumidores deduplicam por `event.id`.
4. Dados secretos ou documentos não entram em eventos.
5. Eventos administrativos não devem ser enviados para salas de cliente ou lojista.
