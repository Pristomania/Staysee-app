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
