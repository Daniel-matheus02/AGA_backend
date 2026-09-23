-- Cor da cerca digital (hex #rrggbb), escolhida pelo operador.
--
-- Puramente aditiva: uma coluna nova com DEFAULT, portanto não há perda de dados
-- nem necessidade de reset. As cercas que já existem ficam com o azul histórico
-- do desenho (#0967d8), que é exatamente o que o frontend desenhava antes desta
-- coluna existir — a migration não muda o aspeto de nenhuma cerca antiga.
--
-- O CHECK no formato é a mesma defesa em profundidade usada nos outros campos
-- livres: o DTO valida na borda da API, mas uma escrita direta no banco (script,
-- painel SQL) não deve conseguir gravar uma cor que o Google Maps rejeitaria em
-- silêncio — o mapa simplesmente não desenharia a cerca e o erro seria invisível.
--
-- Idempotente (IF NOT EXISTS / DO $$ ... $$) pelo mesmo motivo da migration da
-- tabela: foi escrita à mão e reaplicá-la num banco onde a coluna já exista não
-- deve quebrar.

-- AddColumn
ALTER TABLE "Geofence" ADD COLUMN IF NOT EXISTS "color" TEXT NOT NULL DEFAULT '#0967d8';

-- AddCheckConstraint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Geofence_color_hex_check'
    ) THEN
        ALTER TABLE "Geofence"
            ADD CONSTRAINT "Geofence_color_hex_check"
            CHECK ("color" ~ '^#[0-9a-fA-F]{6}$');
    END IF;
END
$$;
