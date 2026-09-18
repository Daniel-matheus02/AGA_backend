-- Remoção lógica de usuário: estado da última remoção, para a central
-- administrativa exibir quem removeu o acesso, quando e por quê.
ALTER TABLE "User"
  ADD COLUMN "lastBlockedAt" TIMESTAMP(3),
  ADD COLUMN "lastBlockReason" TEXT;
