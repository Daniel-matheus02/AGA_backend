# Implantação

## Pipeline sugerido

1. Instalar dependências com lockfile aprovado.
2. Executar `prisma validate` e `prisma generate`.
3. Rodar testes unitários e e2e.
4. SAST, dependency scan e secret scan.
5. Construir imagem imutável.
6. Assinar imagem e publicar no registry.
7. Executar `prisma migrate deploy` em job separado.
8. Implantar API com health checks.
9. Fazer smoke test.
10. Liberar tráfego gradualmente.

## Banco

- PostgreSQL gerenciado com alta disponibilidade.
- Conexão privada e SSL obrigatório.
- Pool de conexões dimensionado para o número de réplicas.
- PITR habilitado.
- Migrações destrutivas em duas fases.

## Redis

- Persistência AOF ou serviço gerenciado.
- TLS e autenticação.
- Política de memória monitorada.
- Redis Stream mantido com tamanho máximo e consumidor idempotente.

## Escala

A API pode ter várias réplicas. Antes disso, o worker de outbox deve ganhar lock distribuído ou ser executado em deployment separado com uma única réplica. Mesmo com lock, consumidores precisam tolerar eventos duplicados.
