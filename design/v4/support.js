/* Standalone preview runtime for TrooPerformance design files (.dc.html).
   Renders the {{holes}}, <sc-for>, <sc-if> template with the file's Component class and keeps the DOM in sync with morphdom. */
document.write('<script src="./morphdom-umd.min.js"><\/script>');
(function(){
class DCLogic{constructor(p){this.props=p||{};this.state={}}setState(o){Object.assign(this.state,typeof o==='function'?o(this.state,this.props):o);window.__dcRender&&window.__dcRender()}forceUpdate(){window.__dcRender&&window.__dcRender()}}
window.DCLogic=DCLogic;
let H=[];
const EV={click:'click',change:'input',input:'input',submit:'submit',keydown:'keydown',focus:'focusin',blur:'focusout',mouseenter:'mouseover',mouseleave:'mouseout'};
function look(path,scope){path=path.trim();if(path==='true')return true;if(path==='false')return false;if(path==='null')return null;if(/^-?\d/.test(path))return +path;if(/^'.*'$/.test(path))return path.slice(1,-1);let v=scope;for(const k of path.split('.')){if(v==null)return undefined;v=v[k]}return v}
function subst(str,scope){const m=str.match(/^\s*\{\{([^}]+)\}\}\s*$/);if(m)return look(m[1],scope);return str.replace(/\{\{([^}]+)\}\}/g,(_,p)=>{const v=look(p,scope);return v==null?'':v})}
function proc(node,scope){
 for(const ch of [...node.childNodes]){
  if(ch.nodeType===3){if(ch.nodeValue.includes('{{'))ch.nodeValue=subst(ch.nodeValue,scope);continue}
  if(ch.nodeType!==1)continue;
  const tag=ch.tagName.toLowerCase();
  if(tag==='sc-for'){const list=subst(ch.getAttribute('list'),scope)||[];const as=ch.getAttribute('as');const frag=document.createDocumentFragment();
   list.forEach((it,i)=>{const c=ch.cloneNode(true);proc(c,Object.assign({},scope,{[as]:it,$index:i}));while(c.firstChild)frag.appendChild(c.firstChild)});ch.replaceWith(frag);continue}
  if(tag==='sc-if'){const v=subst(ch.getAttribute('value'),scope);if(!v){ch.remove();continue}proc(ch,scope);const f=document.createDocumentFragment();while(ch.firstChild)f.appendChild(ch.firstChild);ch.replaceWith(f);continue}
  for(const a of [...ch.attributes]){
   if(/^on[a-z]/i.test(a.name)){const fn=subst(a.value,scope);const ev=EV[a.name.slice(2).toLowerCase()]||a.name.slice(2).toLowerCase();ch.removeAttribute(a.name);if(typeof fn==='function'){H.push(fn);ch.setAttribute('data-on-'+ev,H.length-1)}continue}
   if(/^hint-/.test(a.name)){ch.removeAttribute(a.name);continue}
   if(a.value.includes('{{')){const v=subst(a.value,scope);if(v===false||v==null){ch.removeAttribute(a.name)}else ch.setAttribute(a.name,v===true?'true':String(v))}}
  proc(ch,scope)}
}
document.addEventListener('DOMContentLoaded',()=>{
 const s=document.querySelector('script[data-dc-script]');
 const Component=new Function('DCLogic',s.textContent+';return Component')(DCLogic);
 const x=document.querySelector('x-dc');const h=x.querySelector('helmet');if(h){[...h.childNodes].forEach(n=>document.head.appendChild(n));h.remove()}
 const tpl=x.innerHTML;const host=document.createElement('div');x.innerHTML='';x.appendChild(host);
 let props={};try{const pr=JSON.parse(s.getAttribute('data-props')||'{}');for(const k in pr){if(k[0]!=='$'&&pr[k]&&'default' in pr[k])props[k]=pr[k].default}}catch(e){}
 const inst=new Component(props);
 let pending=false;
 function render(){H=[];const t=document.createElement('div');t.innerHTML=tpl;proc(t,inst.renderVals());
  morphdom(host,t,{childrenOnly:true,onBeforeElUpdated:(f,n)=>{if(f.tagName==='CANVAS')return false;if((f.tagName==='INPUT'||f.tagName==='TEXTAREA')&&f===document.activeElement){n.value=f.value}return true}})}
 window.__dcRender=()=>{if(pending)return;pending=true;requestAnimationFrame(()=>{pending=false;render()})};
 render();
 ['click','input','submit','keydown','focusin','focusout','mouseover','mouseout'].forEach(ev=>document.addEventListener(ev,e=>{
  const el=e.target.closest&&e.target.closest('[data-on-'+ev+']');if(!el)return;
  if(ev==='click'&&el.tagName==='A'&&!el.getAttribute('href'))e.preventDefault();
  if(ev==='submit')e.preventDefault();
  const fn=H[+el.getAttribute('data-on-'+ev)];if(fn)fn(e)},true));
 if(inst.componentDidMount)inst.componentDidMount();
 window.addEventListener('pagehide',()=>{inst.componentWillUnmount&&inst.componentWillUnmount()});
});
})();
