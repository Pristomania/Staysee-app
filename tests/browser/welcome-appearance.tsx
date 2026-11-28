import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AppProvider, useApp} from '../../src/context/AppContext';
import {ThemeProvider, useTheme, type ThemeName} from '../../src/context/ThemeContext';
import {WelcomeScreen} from '../../src/components/screens/WelcomeScreen';
import '../../src/index.css';

const themeNames:ThemeName[]=['light','deep','mist'];
const luminance=(rgb:number[])=>rgb.map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[0.2126,0.7152,0.0722][i],0);
const color=(value:string)=>(value.match(/[\d.]+/g)??[]).slice(0,3).map(Number);

export function Harness(){
  const {themeName,setTheme}=useTheme();
  const {currentScreen}=useApp();
  const [result,setResult]=useState('Не проверено');
  async function check(){
    const rows=[];
    for(const name of themeNames){
      setTheme(name);
      await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
      const buttons=[...document.querySelectorAll<HTMLButtonElement>('#fixture button')];
      const login=buttons.find(b=>b.textContent?.trim()==='Войти')!;
      const create=buttons.find(b=>b.textContent?.trim()==='Создать комнату')!;
      const nav=document.querySelector<HTMLElement>('#fixture nav[aria-label="Документы приложения"]')!;
      const bg=color(getComputedStyle(document.body).backgroundColor);
      const navStyle=getComputedStyle(nav), opacity=Number(navStyle.opacity);
      const fg=color(navStyle.color).map((v,i)=>v*opacity+bg[i]*(1-opacity));
      const contrast=(Math.max(luminance(fg),luminance(bg))+0.05)/(Math.min(luminance(fg),luminance(bg))+0.05);
      const metrics={theme:name,createBorder:parseFloat(getComputedStyle(create).borderTopWidth),loginHeight:login.getBoundingClientRect().height,createHeight:create.getBoundingClientRect().height,documentFont:parseFloat(navStyle.fontSize),createFont:parseFloat(getComputedStyle(create).fontSize),documentContrast:Number(contrast.toFixed(2)),documentLinks:nav.querySelectorAll('a').length};
      rows.push(metrics);
      if(metrics.createBorder<=0||metrics.createHeight>=metrics.loginHeight||metrics.documentFont>=metrics.createFont||contrast<4.5||metrics.documentLinks!==5){setResult('FAIL '+JSON.stringify(rows));return;}
      const expectedLinks=[['Оферта','https://stayseeai.online/offer.html'],['Политика данных','https://stayseeai.online/app-privacy.html'],['Согласие на обработку данных','https://stayseeai.online/consent.html'],['Тарифы','https://stayseeai.online/pricing.html'],['Контакты и реквизиты','https://stayseeai.online/contacts.html']];
      const links=[...nav.querySelectorAll('a')];
      if(expectedLinks.some(([label,href])=>!links.some(a=>a.textContent?.trim()===label&&a.href===href))){setResult('FAIL legal link labels/destinations');return;}
    }
    const buttons=[...document.querySelectorAll<HTMLButtonElement>('#fixture button')];
    for(const [label,screen]of [['Создать комнату','register'],['Войти','login']]){
      buttons.find(b=>b.textContent?.trim()===label)!.click();
      await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
      if(document.querySelector('output[aria-label="Экран перехода"]')?.textContent!==screen){setResult('FAIL navigation '+screen);return;}
    }
    setResult('PASS '+JSON.stringify(rows));
  }
  return <>
    <aside className="p-3 flex flex-wrap gap-3">
      {themeNames.map(name=><button key={name} onClick={()=>setTheme(name)}>{name}</button>)}
      <button onClick={()=>void check()}>Проверить иерархию</button>
      <output aria-label="Результат проверки">{result}</output>
      <output aria-label="Экран перехода">{currentScreen}</output>
      <span>Тема: {themeName}</span>
    </aside>
    <div id="fixture"><WelcomeScreen/></div>
  </>;
}
createRoot(document.getElementById('root')!).render(<ThemeProvider><AppProvider><Harness/></AppProvider></ThemeProvider>);
