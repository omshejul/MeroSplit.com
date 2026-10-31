import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { directTransfers, combineTransfers, reverseTransfers, proposeTransfers, type Amounts, type Transfer } from '../src/accounting.ts';
import { previewPending } from '../src/ledger.ts';
import { explainTransfer } from '../src/balanceExplanation.ts';
import type { Group, Command, Expense } from '../src/types.ts';
const cases = JSON.parse(readFileSync(new URL('../../../fixtures/direct-debts.json', import.meta.url), 'utf8'));
for (const row of cases) test(`Direct debt Python/TypeScript parity: ${row.id}`, () => {
  const expenses = row.bills.map(([paid, shares]: [Amounts, Amounts]) => ({ paid, shares }));
  const payments = row.payments.map(([sender, recipient, amount]: string[]) => ({ sender, recipient, amount }));
  assert.deepEqual(directTransfers(expenses, payments, undefined, row.checkpoint), row.expected);
  assert.deepEqual(combineTransfers([...row.expected, ...reverseTransfers(row.expected)]), []);
});
const expense = (id: string, paid: Amounts, shares: Amounts): Expense => ({ id, paid, shares, total: Object.values(paid).reduce((n,v)=> n+BigInt(v),0n).toString(), split: {mode:'exact', values:shares}, version:1, date:'2026-10-31', description:id, category:'general', notes:'', deleted:false });
function chain(): Group {
  const expenses=[expense('one', {B:'50000'},{A:'50000'}), expense('two',{C:'50000'},{B:'50000'})];
  return {id:'g', name:'Trip', version:3, participants:['A','B','C'].map(id=>({id,name:id})), expenses, settlements:[], transfers:directTransfers(expenses,[]), balances:{A:'-50000',B:'0',C:'50000'}, activity:[], simplify_debts:false};
}
test('direct explanation preserves both sides of a zero-net participant',()=>{
  const group=chain();
  for(const row of group.transfers) assert.deepEqual(explainTransfer(group,group,'B',row).plan,group.transfers);
});
test('bounded summary pending bill edit only changes that bill, retaining unrelated debts',()=>{
  const group=chain(); group.read_mode='summary'; group.expenses=group.expenses.slice(0,1);
  const input={...group.expenses[0],total:'60000',paid:{B:'60000'},split:{mode:'exact',values:{A:'60000'}}};
  const command:Command={command_id:'cmd',group_id:'g',base_version:3,path:'/groups/g/expenses/one',method:'PUT',body:input,state:'pending',error:null};
  const result=previewPending(group,[command]);
  assert.deepEqual(result.transfers,[{sender:'A',recipient:'B',amount:'60000'},{sender:'B',recipient:'C',amount:'50000'}]);
  assert.deepEqual(group.balances,{A:'-50000',B:'0',C:'50000'});
});
test('pending direct payments and reversals offset exactly once',()=>{
  const group=chain(), payment={id:'p',sender:'A',recipient:'B',amount:'20000'};
  const cmd:Command={command_id:'cmd',group_id:'g',base_version:3,path:'/groups/g/settlements',method:'POST',body:payment,state:'pending',error:null};
  const paid=previewPending(group,[cmd,cmd]);
  assert.equal(paid.transfers[0].amount,'30000');
  assert.deepEqual(previewPending(paid,[{...cmd,path:'/groups/g/settlements/p/reverse',body:{}}]).transfers,group.transfers);
});
test('checkpoint closes old simplified history while new bill deltas remain direct',()=>{
  const group=chain(); group.settlements=[{id:'p',sender:'A',recipient:'C',amount:'50000'}];
  group.balances={A:'0',B:'0',C:'0'}; group.debt_checkpoint=directTransfers(group.expenses,group.settlements); group.transfers=[];
  const edited={...group.expenses[0],total:'60000',paid:{B:'60000'},split:{mode:'exact',values:{A:'60000'}}};
  const result=previewPending(group,[{command_id:'x',group_id:'g',path:'/groups/g/expenses/one',method:'PUT',body:edited,state:'pending',error:null}]);
  assert.deepEqual(result.transfers,[{sender:'A',recipient:'B',amount:'10000'}]);
  assert.deepEqual(explainTransfer(group,result,'A',result.transfers[0],[{command_id:'x',group_id:'g',path:'/groups/g/expenses/one',method:'PUT',body:edited,state:'pending',error:null}]).plan,result.transfers);
});
