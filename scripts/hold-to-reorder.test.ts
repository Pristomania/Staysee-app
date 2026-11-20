import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHoldToReorder} from '../src/lib/holdToReorder';
test('long hold can move to top only after activation and valid drop',()=>{
 let scheduled:(()=>void)|null=null;const moved:string[]=[];
 const g=createHoldToReorder({schedule:fn=>{scheduled=fn;return 1;},cancel:()=>{scheduled=null;},isTop:y=>y>=10&&y<=90,onMove:id=>moved.push(id),onArmed:()=>{}});
 g.start('own',0,200,true);assert.deepEqual(moved,[]);scheduled!();assert.equal(g.isArmed(),true);
 assert.equal(g.end(50),true);assert.deepEqual(moved,['own']);assert.equal(g.isArmed(),false);
});
test('normal scrolling and free-plan gesture never reorder',()=>{
 let scheduled:(()=>void)|null=null;const moved:string[]=[];
 const g=createHoldToReorder({schedule:fn=>{scheduled=fn;return 1;},cancel:()=>{scheduled=null;},isTop:()=>true,onMove:id=>moved.push(id),onArmed:()=>{}});
 g.start('own',0,200,true);g.move(0,220);assert.equal(scheduled,null);assert.equal(g.end(50),false);
 g.start('locked',0,200,false);assert.equal(scheduled,null);assert.deepEqual(moved,[]);
});
