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
function routingTargets(){const t=current();if(t.kind==='unmatched')return [];const columns=t.columns.map((c,i)=>({index:i,name:c.name})).filter(c=>!isAuditHeading(c.name)&&!isDateHeading(c.name));if(columns.length<2||columns.some(c=>/^Başlık\s+\d+$/i.test(c.name)))return [];return [{id:t.id,name:t.name,snapshot:JSON.stringify(t),columns}];}
function routingMessages(targets,request){const t=targets[0];return [{role:'system',content:SHORT_ENTRY_PROMPT},{role:'user',content:JSON.stringify({context:{columns:t.columns.map(c=>c.name)},request})}];}
function unwrapRoutingResponse(raw){
  if(raw&&Object.keys(raw).length===1&&raw.empty_response&&Object.keys(raw.empty_response).length===1&&Array.isArray(raw.empty_response.rows)&&raw.empty_response.rows.length===1&&Array.isArray(raw.empty_response.rows[0])&&raw.empty_response.rows[0].every(v=>v===''))return raw.empty_response;
  return raw;
}
function normalizeRoutingRow(raw,width){
  if(!Array.isArray(raw?.rows)||!raw.rows.length||raw.rows.length>10)throw Error('Model tek bir kayıt satırı döndürmedi.');
  const rows=raw.rows.map(row=>{
    if(!Array.isArray(row)||row.some(v=>typeof v!=='string')||row.length<width||row.slice(width).some(v=>v.trim()))throw Error('Model hücre sayısını eşleştiremedi; dolu alanlar atılmadı.');
    return row.slice(0,width).map(v=>v.trim());
  });
  if(rows.some(row=>JSON.stringify(row)!==JSON.stringify(rows[0])))throw Error('Model birden fazla farklı kayıt döndürdü. Bu girişte tek kayıt kullan.');
  return rows[0];
}
async function generateRouting(job,targets,request,progress){
  if(targets.length!==1)throw Error('Başlıkları tanımlanmış bir veri tablosu aç. Eşleşmeyenler’den bir cümleyi kopyalayıp o tabloda deneyebilirsin.');const tables=[];let tokens=0;job.inputChars=0;
  for(let i=0;i<targets.length;i++){
    if(job.closed)throw Error('İşlem durduruldu.');
    const spec=targets[i],messages=routingMessages([spec],request);job.phase='Açık tablo işleniyor: '+spec.name;job.routingStep=(i+1)+'/'+targets.length+' · '+spec.name;
    job.inputChars+=messages.reduce((n,m)=>n+m.content.length,0);progress();
    const stream=await job.engine.chat.completions.create({messages,temperature:0,max_tokens:180,stream:true,stream_options:{include_usage:true},extra_body:{enable_thinking:false}});
    let content='',finish;
    for await(const chunk of stream){
      if(job.closed)throw Error('İşlem durduruldu.');
      const piece=chunk.choices?.[0]?.delta?.content||'';if(piece&&job.firstMs===undefined)job.firstMs=Date.now()-job.started;
      content+=piece;job.content=content;job.chars+=piece.length;finish=chunk.choices?.[0]?.finish_reason||finish;
      if(chunk.usage)tokens+=chunk.usage.completion_tokens||0;progress();
    }
    if(job.closed)throw Error('İşlem durduruldu.');
    if(finish==='length')throw Error(spec.name+' yanıtı tamamlanamadı.');
    const raw=unwrapRoutingResponse(parsePurchaseResponse(content)),mapped=normalizeShortEntry(raw,{columns:spec.columns.map(c=>({name:c.name}))}),row=normalizeRoutingRow(mapped,spec.columns.length);
    if(row.some(v=>/^(?:cell|date|product|quantity|total amount)$/i.test(v.trim()))||row.every((v,j)=>normalized(v)===normalized(spec.columns[j].name)))throw Error(spec.name+' için model değerler yerine şablon veya başlık kopyaladı.');
    tables.push(row);
  }
  job.usage={completion_tokens:tokens};job.content=JSON.stringify({tables});return job.content;
}

function baseRoutingPlan(rows){return {action:'append',tab_name:'',headers:[],meanings:[],rows,filters:[],aggregate:'none',aggregate_column:-1,message:''};}
function inboxPlan(request){return routePurchase(baseRoutingPlan([['','','','','','']]),request);}
function offerUnmatchedSave(request,originId,originSnapshot){const button=el('button','Cümleyi Eşleşmeyenler’e kaydet');button.className='secondary';button.onclick=()=>{if(active!==originId||JSON.stringify(current())!==originSnapshot){aiStatus('Tablo değişti. Tekrar dene.');return;}aiPlan={plan:inboxPlan(request),tabId:originId,snapshot:originSnapshot};showPlan();};$('#ai-result').append(button);}
function evaluateRouting(content,targets,request){
 const raw=parseAIResponse(content);if(targets.length!==1||!Array.isArray(raw?.tables)||raw.tables.length!==1)throw Error('Açık tablo için geçerli yanıt alınamadı.');
 const spec=targets[0],t=current();if(t.id!==spec.id||JSON.stringify(t)!==spec.snapshot)throw Error('İşlem sırasında tablo değişti. Tekrar dene.');
 const values=raw.tables[0];if(!Array.isArray(values)||values.length!==spec.columns.length||values.some(v=>typeof v!=='string'||v.length>2000))throw Error('Model hücreleri eşleştiremedi.');
 const row=Array(t.columns.length).fill(''),source=sourceText(request),money=monetaryEvidence(request),numbers=[...request.matchAll(/\d+(?:[.,]\d+)*/g)].map(m=>numeric(m[0]));
 spec.columns.forEach((c,j)=>{let value=values[j].trim();if(!value)return;const number=value.match(/\d+(?:[.,]\d+)*/)?.[0],moneyField=/tutar|fiyat|price|amount/iu.test(c.name);if(/\d.*(?:TL|TRY|₺|lira|dolar|USD|EUR|euro|€|GBP|sterlin)/iu.test(value)&&!moneyField)return;if(/şehir|otel|kalkış|varış|bilet türü/iu.test(c.name)&&!moneyField&&number!==undefined&&!/\p{L}/u.test(value))return;if(moneyField){if(number===undefined||!money.numbers.includes(numeric(number)))return;}else if(!source.includes(sourceText(value).trim())&&(number===undefined||!numbers.includes(numeric(number))))return;
 if(/gece/iu.test(c.name)&&!moneyField){value=nightQuantity(request);}
 row[c.index]=value;});
 // Recover explicit unit-tagged hotel data when a small model swapped columns.
 if(t.kind==='hotels')spec.columns.forEach(c=>{if(/gece/iu.test(c.name)&&!/gecelik/iu.test(c.name))row[c.index]=nightQuantity(request);if(/gecelik/iu.test(c.name)){const explicit=request.match(/(?:gecelik|geceliği|gece başına|gecesi|geceye)\s*(\d+(?:[.,]\d+)*\s*(?:TL|TRY|₺|lira|dolar|USD|EUR|euro|€|GBP|sterlin))/iu)?.[1];if(explicit)row[c.index]=explicit;}});
 let plan=baseRoutingPlan([row]);if(t.kind==='purchases'){const read=name=>row[t.columns.findIndex(c=>c.name===name)]||'';plan.rows=purchaseRows({rows:[['',read('Ürün'),read('Miktar'),read('Tutar')]]},request).rows;}
 const warnings=removeUnsupportedFacts(plan,t,request),matched=spec.columns.filter(c=>plan.rows[0][c.index]?.trim());if(matched.length<2)return [];fillEntryMetadata(plan,t,request);validatePlan(plan,t);return [{spec,plan,warnings,count:matched.length,matched:matched.map(c=>c.name)}];
}
function presentRouting(content,targets,request,originId,originSnapshot,metrics){
 const result=evaluateRouting(content,targets,request)[0];if(active!==originId||JSON.stringify(current())!==originSnapshot)throw Error('Açık tablo değişti. Tekrar dene.');
 if(!result){aiPlan={plan:inboxPlan(request),tabId:originId,snapshot:originSnapshot,metrics};showPlan();aiStatus('Açık tabloda iki alan eşleşmedi. Eşleşmeyenler önerisini kontrol et.');return;}
 result.plan.message=current().name+' · '+result.count+' eşleşen başlık: '+result.matched.join(', ')+'.';aiPlan={plan:result.plan,tabId:originId,snapshot:originSnapshot,warnings:result.warnings,metrics,evidence:{request,modelResponse:content,beforeChecks:structuredClone(result.plan),afterChecks:structuredClone(result.plan)}};showPlan();aiStatus('Açık tablo için öneri hazır.');
}
