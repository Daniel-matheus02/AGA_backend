-- Incorporar à migration inicial após revisão. Não executar cegamente em produção.

ALTER TABLE "Merchant"
  ADD CONSTRAINT "Merchant_feeBps_range" CHECK ("feeBps" BETWEEN 0 AND 10000);

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_price_positive" CHECK ("priceCents" > 0);

ALTER TABLE "CreditAccount"
  ADD CONSTRAINT "CreditAccount_nonnegative" CHECK ("limitCents" >= 0 AND "usedCents" >= 0 AND "blockedCents" >= 0),
  ADD CONSTRAINT "CreditAccount_within_limit" CHECK ("usedCents" + "blockedCents" <= "limitCents");

ALTER TABLE "CreditRequest"
  ADD CONSTRAINT "CreditRequest_amount_positive" CHECK ("amountCents" > 0 AND "dailyAmountCents" > 0),
  ADD CONSTRAINT "CreditRequest_installments_range" CHECK ("dailyInstallments" BETWEEN 1 AND 365);

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_amount_positive" CHECK ("amountCents" > 0),
  ADD CONSTRAINT "Order_fee_nonnegative" CHECK ("feeCents" >= 0 AND "netCents" >= 0),
  ADD CONSTRAINT "Order_amount_balanced" CHECK ("amountCents" = "feeCents" + "netCents");

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_amount_positive" CHECK ("amountCents" > 0);

ALTER TABLE "Settlement"
  ADD CONSTRAINT "Settlement_amounts_valid" CHECK (
    "grossCents" > 0 AND "feeCents" >= 0 AND "netCents" >= 0
    AND "grossCents" = "feeCents" + "netCents"
  );

ALTER TABLE "TrackingPoint"
  ADD CONSTRAINT "TrackingPoint_latitude" CHECK ("latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "TrackingPoint_longitude" CHECK ("longitude" BETWEEN -180 AND 180),
  ADD CONSTRAINT "TrackingPoint_speed" CHECK ("speedKph" BETWEEN 0 AND 350),
  ADD CONSTRAINT "TrackingPoint_battery" CHECK ("batteryPct" IS NULL OR "batteryPct" BETWEEN 0 AND 100);

CREATE OR REPLACE FUNCTION aga_validate_ledger_balance() RETURNS TRIGGER AS $$
DECLARE
  tx_id text;
  total numeric;
BEGIN
  tx_id := COALESCE(NEW."transactionId", OLD."transactionId");
  SELECT COALESCE(SUM("amountCents"), 0) INTO total
  FROM "LedgerEntry" WHERE "transactionId" = tx_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'Unbalanced ledger transaction %, total %', tx_id, total;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "LedgerEntry_balance_check"
AFTER INSERT OR UPDATE OR DELETE ON "LedgerEntry"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aga_validate_ledger_balance();
