import {useEffect,useState} from 'react';
import {useTheme} from '../context/ThemeContext';

/** Initial verification only; a quiet refresh of a verified plan never mounts this screen. */
export function PlanVerificationNotice({failed,onRetry}:{failed:boolean;onRetry:()=>void}){
 const {theme}=useTheme();
 const [slow,setSlow]=useState(false);
 useEffect(()=>{const timer=window.setTimeout(()=>setSlow(true),8000);return()=>window.clearTimeout(timer);},[]);
 return <div className={`min-h-screen ${theme.bg} ${theme.textPrimary} flex items-center justify-center p-6`}>
  <section className="max-w-sm space-y-4 text-center" role="status" aria-live="polite">
   <p>{failed?'Не удалось проверить доступ. Проверьте интернет и попробуйте снова.':'Проверяем доступ…'}</p>
   {!failed&&slow&&<p className="text-sm opacity-80">Проверка идёт дольше обычного.</p>}
   {(failed||slow)&&<button type="button" className="underline p-2" onClick={onRetry}>Повторить проверку</button>}
  </section>
 </div>;
}
