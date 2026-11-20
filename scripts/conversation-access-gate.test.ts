import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createElement} from 'react';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ConversationAccessGate} from '../src/components/ConversationAccessGate';
(globalThis as unknown as {React:typeof React}).React=React;
test('protected content never renders before fresh access check or while billing unverified',()=>{
 for(const verified of [true,false]){
  const html=renderToStaticMarkup(createElement(ConversationAccessGate,{
   identityKey:'uid:free',verified,conversationId:'room',requirePaid:false,
   readAccess:async()=>({allowed:true,paidFeatures:true,fullAccess:true}),
   onInvalidate:()=>{},onBack:()=>{},onPlans:()=>{},
  },createElement('p',null,'PRIVATE TRANSCRIPT')));
  assert.equal(html.includes('PRIVATE TRANSCRIPT'),false);
  assert.equal(html.includes('Проверяем доступ'),true);
 }
});

// ── No flash when moving between the screens of one conversation ────────────────────────────────────────────
// The gate used to show a dark "Проверяем доступ…" screen on EVERY move (chat → memory → chat), until the server answered.
import {accessGateKey,forgetAccessYes,gateView,isAccessRemembered,rememberAccessYes,shouldApplyAccessResult} from '../src/lib/accessGate';

const yes={allowed:true,paidFeatures:true,fullAccess:true};
const free={allowed:true,paidFeatures:false,fullAccess:false};
const locked={allowed:false,paidFeatures:false,fullAccess:false};

test('the "checking" screen appears only if the check takes noticeable time, and still tells what is going on',()=>{
 const html=renderToStaticMarkup(createElement(ConversationAccessGate,{
  identityKey:'uid:flash:1',verified:true,conversationId:'room-a',requirePaid:false,
  readAccess:async()=>yes,onInvalidate:()=>{},onBack:()=>{},onPlans:()=>{},
 },createElement('p',null,'PRIVATE TRANSCRIPT')));
 assert.equal(html.includes('PRIVATE TRANSCRIPT'),false);
 assert.equal(html.includes('Проверяем доступ'),true,'the words are there for a screen reader and for a slow check');
 assert.match(html,/gate-delayed/,'but the screen fades in late, so a fast check is never seen');
});

test('a locked room or a failed check is shown at once, not delayed',()=>{
 const key=accessGateKey('uid:flash:2',true,'room-b',false);
 forgetAccessYes(key);
 assert.equal(gateView({current:{access:locked,error:false},remembered:false,verified:true,conversationId:'room-b',requirePaid:false}),'denied');
 assert.equal(gateView({current:{access:null,error:true},remembered:false,verified:true,conversationId:'room-b',requirePaid:false}),'error');
});

test('a fresh yes for the same person, plan state, room and screen lets the screen open at once',()=>{
 const key=accessGateKey('uid:flash:3',true,'room-c',false);
 forgetAccessYes(key);
 assert.equal(isAccessRemembered(key),false,'nothing is remembered before a check said yes');
 rememberAccessYes(key);
 assert.equal(isAccessRemembered(key),true);
 const html=renderToStaticMarkup(createElement(ConversationAccessGate,{
  identityKey:'uid:flash:3',verified:true,conversationId:'room-c',requirePaid:false,
  readAccess:async()=>yes,onInvalidate:()=>{},onBack:()=>{},onPlans:()=>{},
 },createElement('p',null,'ROOM TEXT')));
 assert.equal(html.includes('ROOM TEXT'),true);
 assert.equal(html.includes('Проверяем доступ'),false);
});

test('the memory of a yes is short and exact: another room, another screen kind, another plan state, or time passing forgets it',()=>{
 const key=accessGateKey('uid:flash:4',true,'room-d',false);
 rememberAccessYes(key,1_000);
 assert.equal(isAccessRemembered(key,1_000+19_000),true);
 assert.equal(isAccessRemembered(key,1_000+21_000),false,'after 20 seconds it is asked again');
 assert.equal(isAccessRemembered(accessGateKey('uid:flash:4',true,'room-OTHER',false),1_000),false,'another room');
 assert.equal(isAccessRemembered(accessGateKey('uid:flash:4',true,'room-d',true),1_000),false,'a paid-only screen is another question');
 assert.equal(isAccessRemembered(accessGateKey('uid:flash:4:revoked',true,'room-d',false),1_000),false,'a changed plan state is another person-state');
 assert.equal(isAccessRemembered(accessGateKey('uid:flash:4',false,'room-d',false),1_000),false,'while the plan is not verified, nothing is remembered');
});

test('what the screen shows: a "no" always wins over a remembered yes, and nothing opens while the plan is unverified',()=>{
 const base={conversationId:'room-e',requirePaid:false};
 assert.equal(gateView({...base,verified:false,current:null,remembered:true}),'checking','unverified plan: never open');
 assert.equal(gateView({...base,verified:true,current:null,remembered:false}),'checking');
 assert.equal(gateView({...base,verified:true,current:null,remembered:true}),'open','remembered yes opens at once');
 assert.equal(gateView({...base,verified:true,current:{access:yes,error:false},remembered:false}),'open');
 assert.equal(gateView({...base,verified:true,current:{access:locked,error:false},remembered:true}),'denied','the server said no: no beats the memory');
 assert.equal(gateView({conversationId:'room-e',requirePaid:true,verified:true,current:{access:free,error:false},remembered:true}),'denied','a paid-only screen needs paid features');
 assert.equal(gateView({conversationId:null,requirePaid:false,verified:true,current:{access:locked,error:false},remembered:false}),'open','no room asked: the list-level answer is enough');
});

test('a failed re-check does not throw out a person who was just let in, but a real "no" does',()=>{
 assert.equal(shouldApplyAccessResult(null,true),false,'network trouble after a fresh yes: stay');
 assert.equal(shouldApplyAccessResult(null,false),true,'network trouble with no earlier yes: say so');
 assert.equal(shouldApplyAccessResult(locked,true),true,'a real no is always applied');
 assert.equal(shouldApplyAccessResult(yes,true),true);
});
