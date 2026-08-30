export function calculateDailyAmount(principalCents:bigint,installments:number,multiplierBps=11800n):bigint{
  if(principalCents<=0n)throw new Error('principal must be positive');
  if(!Number.isInteger(installments)||installments<1)throw new Error('installments must be a positive integer');
  const total=(principalCents*multiplierBps+9999n)/10000n;
  return (total+BigInt(installments)-1n)/BigInt(installments);
}

export function assertBalanced(entries:bigint[]):void{
  if(entries.reduce((sum,value)=>sum+value,0n)!==0n)throw new Error('Unbalanced ledger transaction');
}
