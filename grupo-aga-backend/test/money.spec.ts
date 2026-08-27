import { assertBalanced, calculateDailyAmount } from '../src/common/services/money';

describe('money invariants',()=>{
  it('rounds the daily installment upward without floats',()=>{
    expect(calculateDailyAmount(200000n,50)).toBe(4720n);
  });
  it('accepts a balanced ledger',()=>{
    expect(()=>assertBalanced([10000n,-9700n,-300n])).not.toThrow();
  });
  it('rejects an unbalanced ledger',()=>{
    expect(()=>assertBalanced([10000n,-9500n,-300n])).toThrow('Unbalanced');
  });
});
