'use strict';
function ensureTravelTables(){
  for(const [kind,name,headers] of [['hotels','Oteller',['Şehir','Otel','Kalınan gece','Gecelik tutar']],['flights','Uçuşlar',['Kalkış','Varış','Bilet türü','Fiyat']]]){
    if(!db.tabs.some(t=>t.kind===kind))db.tabs.push({id:id(),kind,name,columns:headers.map(name=>({id:id(),name,meaning:name})),rows:Array.from({length:8},blank)});
  }
}

function isAuditHeading(name){return /^(?:kayıt tarihi|orijinal cümle|cümle)$/iu.test(name.trim());}
function isDateHeading(name){return /tarih|date/iu.test(name);}
function ensureTableMetadata(t){
 const get=name=>{let c=t.columns.find(c=>c.name.toLocaleLowerCase('tr')===name.toLocaleLowerCase('tr'));if(!c){c={id:id(),name,meaning:name};t.columns.push(c);}return c;};
 if(t.kind==='unmatched'){const date=get('Kayıt tarihi');t.columns=[date,...t.columns.filter(c=>c!==date)];return t;}
 const date=get('Tarih'),entered=get('Kayıt tarihi'),original=get('Orijinal cümle');t.columns=[date,...t.columns.filter(c=>![date,entered,original].includes(c)),entered,original];return t;
}
function ensureAllMetadata(){db.tabs.forEach(ensureTableMetadata);}
function fillEntryMetadata(plan,t,request){const date=purchaseDate(request);plan.audit=true;plan.autoEntryDate=!date.explicit;plan.rows.forEach(row=>t.columns.forEach((c,i)=>{if(c.name==='Tarih')row[i]=date.value;if(c.name==='Kayıt tarihi')row[i]=localDay();if(c.name==='Orijinal cümle')row[i]=request;}));return plan;}
function stampEntryMetadata(plan,t){const day=localDay();plan.rows.forEach(row=>t.columns.forEach((c,i)=>{if(c.name==='Kayıt tarihi')row[i]=day;if(c.name==='Tarih'&&plan.autoEntryDate)row[i]=day;}));}

function routingTargets(){const t=current();if(t.kind==='unmatched')return [];const columns=t.columns.map((c,index)=>({index,name:c.name})).filter(c=>!isAuditHeading(c.name));if(!columns.length||columns.some(c=>/^Başlık\s+\d+$/i.test(c.name)))return [];return [{id:t.id,name:t.name,snapshot:JSON.stringify(t),columns}];}
function routingMessages(targets,request){const spec=targets[0];return [{role:'system',content:'Extract facts from the Turkish sentence into the given headings IN ORDER. Return JSON only with rows: an array of string arrays. One string per heading. Missing information is an empty string. Do not copy heading names as values. Do not invent facts. /no_think'},{role:'user',content:JSON.stringify({today:localDay(),headings:spec.columns.map(c=>c.name),sentence:request})}];}
function parseRawRows(content,width){
 let text=String(content).replace(/<think>[\s\S]*?<\/think>/g,'').trim();const fence=text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);if(fence)text=fence[1];let raw;try{raw=JSON.parse(text);}catch{throw Error('Modelin ham yanıtı geçerli JSON değil. Hiçbir değer düzeltilmedi.');}
 if(!raw||!Array.isArray(raw.rows)||!raw.rows.length||raw.rows.length>50||raw.rows.some(row=>!Array.isArray(row)||row.length!==width||row.some(value=>typeof value!=='string'||value.length>2000)))throw Error('Modelin ham yanıtı beklenen hücre biçiminde değil. Yanıt değiştirilmeden aşağıda gösteriliyor.');return raw.rows;
}
async function generateRouting(job,targets,request,progress){
 if(targets.length!==1)throw Error('Başlıkları tanımlanmış bir veri tablosu aç.');const spec=targets[0],messages=routingMessages(targets,request);job.phase='Modelin ham yanıtı bekleniyor: '+spec.name;job.routingStep=spec.name;job.inputChars=messages.reduce((sum,m)=>sum+m.content.length,0);
 const stream=await job.engine.chat.completions.create({messages,temperature:0,max_tokens:250,stream:true,stream_options:{include_usage:true},extra_body:{enable_thinking:false}});let content='',finish;
 for await(const chunk of stream){if(job.closed)throw Error('İşlem durduruldu.');const piece=chunk.choices?.[0]?.delta?.content||'';if(piece&&job.firstMs===undefined)job.firstMs=Date.now()-job.started;content+=piece;job.content=content;job.chars+=piece.length;finish=chunk.choices?.[0]?.finish_reason||finish;if(chunk.usage)job.usage=chunk.usage;progress();}
 if(job.closed)throw Error('İşlem durduruldu.');if(finish==='length')throw Error('Model yanıtı uzunluk sınırında kesildi. Ham yanıt değiştirilmedi.');return content;
}
function presentRouting(content,targets,request,originId,originSnapshot,metrics){
 const t=current();if(active!==originId||JSON.stringify(t)!==originSnapshot)throw Error('İşlem sırasında tablo değişti. Tekrar dene.');const spec=targets[0],rows=parseRawRows(content,spec.columns.length);
 const mapped=rows.map(values=>{const row=Array(t.columns.length).fill('');spec.columns.forEach((c,i)=>row[c.index]=values[i]);t.columns.forEach((c,i)=>{if(c.name==='Kayıt tarihi')row[i]=localDay();if(c.name==='Orijinal cümle')row[i]=request;});return row;});
 const plan=baseRoutingPlan(mapped);plan.audit=true;plan.rawModel=true;plan.message='Kuralsız deneme: Tarih dahil modelin ürettiği hücreler aynen gösteriliyor. Alan silme, düzeltme ve iki eşleşme kontrolü uygulanmadı. Kayıt tarihi ve orijinal cümle uygulama tarafından eklendi.';
 aiPlan={plan,tabId:originId,snapshot:originSnapshot,metrics,evidence:{request,modelResponse:content,beforeChecks:{rows:structuredClone(rows)},afterChecks:{rows:structuredClone(rows)}}};showPlan();aiStatus('Ham model önerisi hazır. Hücreler kod tarafından değiştirilmedi.');
}
function baseRoutingPlan(rows){return {action:'append',tab_name:'',headers:[],meanings:[],rows,filters:[],aggregate:'none',aggregate_column:-1,message:''};}
function inboxPlan(request){return routePurchase(baseRoutingPlan([['','','','','','']]),request);}
function offerUnmatchedSave(request,originId,originSnapshot){const button=el('button','Cümleyi Eşleşmeyenler’e kaydet');button.className='secondary';button.onclick=()=>{if(active!==originId||JSON.stringify(current())!==originSnapshot){aiStatus('Tablo değişti. Tekrar dene.');return;}aiPlan={plan:inboxPlan(request),tabId:originId,snapshot:originSnapshot};showPlan();};$('#ai-result').append(button);}
