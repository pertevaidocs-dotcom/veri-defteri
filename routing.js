'use strict';
function ensureTravelTables(){
  for(const [kind,name,headers] of [['hotels','Oteller',['Şehir','Otel','Kalınan gece','Gecelik tutar']],['flights','Uçuşlar',['Kalkış','Varış','Bilet türü','Fiyat']]]){
    if(!db.tabs.some(t=>t.kind===kind))db.tabs.push({id:id(),kind,name,columns:headers.map(name=>({id:id(),name,meaning:name})),rows:Array.from({length:8},blank)});
  }
}
function routingTargets(){return db.tabs.filter(t=>t.kind!=='unmatched'&&t.columns.length>=2&&!t.columns.some(c=>/^Başlık\s+\d+$/i.test(c.name))).map(t=>({id:t.id,name:t.name,snapshot:JSON.stringify(t),columns:t.columns.map((c,i)=>({index:i,name:c.name})).filter(c=>t.kind==='purchases'?c.index<4:!isAuditHeading(c.name))})).filter(t=>t.columns.length>=2);}
function isAuditHeading(name){return /^(?:kayıt tarihi|orijinal cümle|cümle)$/iu.test(name.trim());}
function isDateHeading(name){return /tarih|date/iu.test(name);}
function routingMessages(targets,request){const t=targets[0],table=db.tabs.find(tab=>tab.id===t.id);return [{role:'system',content:table?.kind==='purchases'?PURCHASE_PROMPT:SHORT_ENTRY_PROMPT},{role:'user',content:JSON.stringify({context:{columns:t.columns.map(c=>c.name)},request})}];}
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
  const tables=[];let tokens=0;job.inputChars=0;
  for(let i=0;i<targets.length;i++){
    if(job.closed)throw Error('İşlem durduruldu.');
    const spec=targets[i],messages=routingMessages([spec],request);job.phase='Tablo karşılaştırılıyor: '+spec.name;job.routingStep=(i+1)+'/'+targets.length+' · '+spec.name;
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
function offerUnmatchedSave(request,originId,originSnapshot){
  const button=el('button','Cümleyi Eşleşmeyenler’e kaydet');button.className='secondary';
  button.onclick=()=>{
    if(active!==originId||JSON.stringify(current())!==originSnapshot){aiStatus('Tablo değişti. Cümleyi tekrar gönder.');return;}
    const plan=routePurchase(baseRoutingPlan([['','','','','','']]),request);
    plan.message='Model yanıtı geçersiz olduğu için otomatik eşleştirme yapılamadı. İstersen orijinal cümleyi Eşleşmeyenler’e kaydetmek için onayla.';
    aiPlan={plan,tabId:originId,snapshot:originSnapshot};showPlan();
  };
  $('#ai-result').append(el('p','Cümleni saklamak istersen Eşleşmeyenler’e kayıt önerisi hazırlayabilirsin.'),button);
}
function baseRoutingPlan(rows){return {action:'append',tab_name:'',headers:[],meanings:[],rows,filters:[],aggregate:'none',aggregate_column:-1,message:''};}
function evaluateRouting(content,targets,request){
  const raw=parseAIResponse(content);
  if(!Array.isArray(raw?.tables)||raw.tables.length!==targets.length)throw Error('Model tüm tabloları karşılaştırılabilir biçimde döndürmedi. Hiçbir kayıt değiştirilmedi.');
  const source=sourceText(request).replace(/\s+/g,' ').trim(),numbers=[...request.matchAll(/\d+(?:[.,]\d+)*/g)].map(m=>numeric(m[0])),money=monetaryEvidence(request),candidates=[];
  raw.tables.forEach((values,i)=>{
    const spec=targets[i],t=db.tabs.find(t=>t.id===spec.id);
    if(!t||JSON.stringify(t)!==spec.snapshot)throw Error('Karşılaştırma sırasında bir tablo değişti. Yeniden dene.');
    if(!Array.isArray(values)||values.length!==spec.columns.length||values.some(v=>typeof v!=='string'||v.length>2000))throw Error('Model tablo alanlarını eşleştiremedi. Hiçbir kayıt değiştirilmedi.');
    // Airport/flight fields need journey evidence, not merely a city and a price.
    if(t.kind==='flights'&&!/uçak|uçuş|uçtum|uçtuk|bilet|havaliman|havaalan|kalkış|varış|ekonomi|business|gidiş|dönüş/iu.test(request)&&!/\p{L}+['’]?(?:dan|den|tan|ten)\s+\p{L}+['’]?(?:a|e|ya|ye)(?:\s|[.,]|$)/iu.test(request))return;
    if(t.kind==='hotels'){
      values=[...values];
      const nights=request.match(/\b\d+(?:[.,]\d+)?\s*gece\b/iu)?.[0]||'';
      const nightly=request.match(/(?:gecelik|geceliği|gece başına|gecesi|geceye)\s*(\d+(?:[.,]\d+)*\s*(?:TL|TRY|₺|lira|dolar|USD|EUR|euro|€|GBP|sterlin))/iu)?.[1]||'';
      spec.columns.forEach((c,j)=>{if(/gecelik/i.test(c.name))values[j]=nightly;else if(/gece/i.test(c.name))values[j]=nights;});
    }
    let row=Array(t.columns.length).fill('');
    spec.columns.forEach((column,j)=>{
      let value=values[j].trim();if(!value)return;
      const label=column.name,fact=sourceText(value).replace(/\s+/g,' ').trim(),number=value.match(/\d+(?:[.,]\d+)*/)?.[0];
      if(isDateHeading(label)){row[column.index]=value;return;}
      if(/tutar|fiyat|price|amount/i.test(label)){
        if(number===undefined||!money.numbers.includes(numeric(number)))return;
        if(/gecelik/i.test(label)&&!/(?:gecelik|gece başına|gecesi|geceye)/iu.test(request))return;
      }else if(number!==undefined){if(!numbers.includes(numeric(number)))return;
        if(/gece/i.test(label)&&!/(?:\d+(?:[.,]\d+)?\s*gece|gece\s*[:=]?\s*\d+)/iu.test(request))return;
      }else if(!fact||!source.includes(fact))return;
      row[column.index]=value;
    });
    if(spec.columns.filter(c=>!isDateHeading(c.name)&&row[c.index].trim()).length<2)return;let plan=baseRoutingPlan([row]),warnings=[];
    if(t.kind==='purchases'){
      const prepared=purchaseRows({rows:[row.slice(0,4)]},request);plan.rows=prepared.rows;plan.purchase=true;plan.purchaseExplicitDate=prepared.purchaseExplicitDate;
    }
    warnings=removeUnsupportedFacts(plan,t,request);validatePlan(plan,t);
    const matched=spec.columns.filter(c=>!isDateHeading(c.name)&&!isAuditHeading(c.name)&&plan.rows[0][c.index].trim());
    if(matched.length>=2)candidates.push({spec,plan,warnings,count:matched.length,matched:matched.map(c=>c.name)});
  });
  const max=Math.max(0,...candidates.map(c=>c.count));return candidates.filter(c=>c.count===max);
}
function presentRouting(content,targets,request,originId,originSnapshot,metrics){
  const candidates=evaluateRouting(content,targets,request);
  if(active!==originId||JSON.stringify(current())!==originSnapshot)throw Error('Açık tablo işlem sırasında değişti. Yeniden dene.');
  function preview(candidate){
    const t=db.tabs.find(t=>t.id===candidate.spec.id);
    if(!t||JSON.stringify(t)!==candidate.spec.snapshot){aiStatus('Hedef tablo değişti. Yeniden dene.');return;}
    active=t.id;render();candidate.plan.message=t.name+' seçildi · '+candidate.count+' eşleşen başlık: '+candidate.matched.join(', ')+'. Hücreleri kontrol et.';
    aiPlan={plan:candidate.plan,tabId:t.id,snapshot:JSON.stringify(t),warnings:candidate.warnings,metrics,evidence:{request,modelResponse:content,beforeChecks:structuredClone(candidate.plan),afterChecks:structuredClone(candidate.plan)}};showPlan();
  }
  if(!candidates.length){const p=routePurchase(baseRoutingPlan([['','','','','','']]),request);aiPlan={plan:p,tabId:originId,snapshot:originSnapshot,metrics};showPlan();aiStatus('İki başlık eşleşen tablo bulunamadı. Eşleşmeyenler önerisini kontrol et.');return;}
  if(candidates.length===1){preview(candidates[0]);aiStatus('En çok eşleşen tablo: '+candidates[0].spec.name+'. Öneriyi kontrol et.');return;}
  aiPlan=null;const box=$('#ai-result');box.replaceChildren();box.hidden=false;openOutput('Hangi tabloya kaydedilsin?');box.append(el('p',candidates.length+' tabloda '+candidates[0].count+' başlık eşleşti. Birini seç; ardından kayıt önerisini kontrol edip onaylayabilirsin.'));
  for(const candidate of candidates){const button=el('button',candidate.spec.name+' · '+candidate.matched.join(', '));button.className='secondary';button.onclick=()=>preview(candidate);box.append(button);}
  aiStatus('Eşit eşleşme var. Sonuç penceresinden bir tablo seç.');
}
