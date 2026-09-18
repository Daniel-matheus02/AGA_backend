-- Cerca digital (geofencing) e estado por rastreador.
--
-- Duas tabelas novas, puramente aditivas: não altera nenhuma coluna existente,
-- portanto não há risco de perda de dados nem necessidade de reset.
--
-- "Geofence"."vertices" guarda o polígono como JSONB no formato
-- [{ "lat": -3.11, "lng": -60.02 }, ...]. Não é PostGIS porque a instância
-- Postgres de produção (Railway) não tem a extensão `postgis` habilitada e o
-- Prisma 7 não expõe tipo geometry nativo (exigiria Unsupported(...) +
-- $queryRaw). O volume é de dezenas de cercas por tenant, avaliadas a cada
-- ping recebido — o custo de ray casting em memória é irrelevante nessa escala.
--
-- "TrackerGeofenceState" guarda o último estado conhecido de cada par
-- (rastreador, cerca) para que o alerta dispare apenas na TRANSIÇÃO
-- dentro<->fora. Sem esta tabela, cada ping dentro da cerca geraria um alerta.
--
-- ON DELETE CASCADE nas duas pontas: remover um rastreador ou uma cerca apaga
-- o estado correspondente, evitando linhas órfãs que fariam o próximo ping
-- "lembrar" de um estado que já não existe.
--
-- Idempotente (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS) porque esta migration
-- foi escrita à mão, sem o diff automático do `migrate dev`: reaplicá-la num
-- banco onde a tabela já exista não deve quebrar.

-- CreateTable
CREATE TABLE IF NOT EXISTS "Geofence" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'POLYGON',
    "vertices" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Geofence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TrackerGeofenceState" (
    "trackerId" TEXT NOT NULL,
    "geofenceId" TEXT NOT NULL,
    "isInside" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackerGeofenceState_pkey" PRIMARY KEY ("trackerId","geofenceId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Geofence_tenantId_active_idx" ON "Geofence"("tenantId", "active");

-- AddForeignKey
ALTER TABLE "Geofence" DROP CONSTRAINT IF EXISTS "Geofence_tenantId_fkey";
ALTER TABLE "Geofence" ADD CONSTRAINT "Geofence_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackerGeofenceState" DROP CONSTRAINT IF EXISTS "TrackerGeofenceState_trackerId_fkey";
ALTER TABLE "TrackerGeofenceState" ADD CONSTRAINT "TrackerGeofenceState_trackerId_fkey" FOREIGN KEY ("trackerId") REFERENCES "Tracker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackerGeofenceState" DROP CONSTRAINT IF EXISTS "TrackerGeofenceState_geofenceId_fkey";
ALTER TABLE "TrackerGeofenceState" ADD CONSTRAINT "TrackerGeofenceState_geofenceId_fkey" FOREIGN KEY ("geofenceId") REFERENCES "Geofence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
