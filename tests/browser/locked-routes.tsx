// Real App + real local Supabase. Only navigation is driven by this visible QA panel.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import App from '../../src/App';
import type {Screen} from '../../src/types';
import '../../src/index.css';
function LocalRoutes(){
 const [id,setId]=useState(''),[result,setResult]=useState('');
 const local=['127.0.0.1','localhost'].includes(location.hostname);
 function route(screen:Screen){
  if(!local||!/^[0-9a-f-]{36}$/.test(id))return;
  const state={app:'staysee',screen,conversationId:id,memoryReturnScreen:'chat',notesReturnScreen:'chat',dynamicsReturnScreen:'chat',legalReturnScreen:'main'};
  history.pushState(state,'');window.dispatchEvent(new PopStateEvent('popstate',{state}));
 }
 function audit(){
  const app=document.querySelector('#app-view')!;
  setResult(JSON.stringify({secret:app.textContent?.includes('СЕКРЕТ'),exports:[...app.querySelectorAll('button')].filter(b=>/^(PDF|JSON|Скачать мои данные)$/.test(b.textContent??'')).map(b=>b.textContent),text:app.textContent}));
 }
 return <><div id="app-view"><App/></div>{local&&<aside style={{position:'fixed',bottom:0,zIndex:200,background:'white',color:'black',fontSize:12,width:'100%'}}>
  <label>UUID тестовой закрытой беседы<input aria-label="UUID тестовой закрытой беседы" value={id} onChange={e=>setId(e.target.value)}/></label>
  <button onClick={()=>route('chat')}>Прямой чат</button><button onClick={()=>route('memory')}>Прямая память</button><button onClick={()=>route('conversation-dynamics')}>Прямая динамика</button><button onClick={()=>route('conversation-notes')}>Прямые записки</button><button onClick={audit}>Проверить утечки</button>
  <output id="audit-result" style={{overflowWrap:'anywhere'}}>{result}</output>
 </aside>}</>;
}
createRoot(document.getElementById('root')!).render(<LocalRoutes/>);
