import assert from 'node:assert/strict';
import {test} from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ThemeProvider} from '../src/context/ThemeContext';
import {PlanVerificationNotice} from '../src/components/PlanVerificationNotice';
(globalThis as unknown as {React:typeof React}).React=React;
function markup(failed:boolean){
 const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>null}});
 try{return renderToStaticMarkup(React.createElement(ThemeProvider,{children:React.createElement(PlanVerificationNotice,{failed,onRetry:()=>{throw Error('render cannot invoke retry');}})}));}
 finally{if(original)Object.defineProperty(globalThis,'localStorage',original);else Reflect.deleteProperty(globalThis,'localStorage');}
}
test('an initial-plan failure offers a retry instead of leaving a silent spinner',()=>{
 const html=markup(true);
 assert.match(html,/Не удалось проверить доступ/);assert.match(html,/>Повторить проверку<\/button>/);assert.match(html,/role="status"/);
 assert.doesNotMatch(html,/Оплатить|Доступно после оплаты/);
});
test('a new initial-plan check describes verification without prematurely claiming failure or a slow response',()=>{
 const html=markup(false);assert.match(html,/Проверяем доступ/);assert.doesNotMatch(html,/Не удалось|дольше обычного|Повторить проверку/);
});
