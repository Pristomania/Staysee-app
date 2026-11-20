import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {PLAN_RECHECK_MS,shouldRecheckOnTick} from '../src/lib/planRefreshPolicy';

// Coming back to the tab used to re-read the plan in the STRICT way, which marks the plan unverified for the length of the request:
// every screen of a conversation and the list turned into "checking" at each return, and one failed request left them so.
// The strict way is kept for a real jump of the clock (the snapshot controller watches that itself); everything else reads quietly.
const plan=readFileSync(new URL('../src/context/PlanContext.tsx',import.meta.url),'utf8');

test('the plan context never asks for the strict re-read by itself',()=>{
 assert.equal(/requireFresh/.test(plan),false,'returning to the tab, a shown page and coming online read the plan quietly');
});

test('an open tab asks the server again every so often, so a revoked right does not stay on a screen',()=>{
 assert.match(plan,/PLAN_RECHECK_MS/);
 assert.match(plan,/setInterval/);
 assert.match(plan,/clearInterval/,'and the timer is cleaned up');
 assert.ok(PLAN_RECHECK_MS>=15_000&&PLAN_RECHECK_MS<=60_000,'between 15 and 60 seconds: prompt enough, cheap enough');
});

test('only a visible tab asks',()=>{
 assert.equal(shouldRecheckOnTick('visible'),true);
 assert.equal(shouldRecheckOnTick('hidden'),false);
 assert.equal(shouldRecheckOnTick('prerender'),false);
});
