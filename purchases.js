'use strict';
const PURCHASE_HEADERS=['Tarih','Ürün','Miktar','Tutar','Kayıt tarihi','Orijinal cümle'];
const PURCHASE_PROMPT='Extract purchases from Turkish text. JSON only: {"rows":[["date","product","quantity","total amount"]]}. Four string cells per row, in that exact order. Unknown or unmentioned values are empty strings. Never invent facts, prices, quantities or products. Preserve quantity units and currency. A destination or verb is not a product or quantity. Extract all sentences. Dates may be left as written. Do not add registration date or original text; the app handles them. Unrelated text: return {"rows":[["","","",""]]}. /no_think';
function localDay(date=new Date()){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
function makePurchases(){return {id:id(),name:'Alışverişler',kind:'purchases',columns:PURCHASE_HEADERS.map(name=>({id:id(),name,meaning:name})),rows:Array.from({length:8},blank)};}
function ensurePurchases(){let tab=db.tabs.find(t=>t.kind==='purchases');if(!tab){tab=makePurchases();db.tabs.unshift(tab);}return tab;}
function ensureUnmatched(){let tab=db.tabs.find(t=>t.kind==='unmatched');if(!tab){tab={id:id(),name:'Eşleşmeyenler',kind:'unmatched',columns:[{id:id(),name:'Cümle',meaning:'Cümle'}],rows:[]};db.tabs.push(tab);}return tab;}
function parsePurchaseResponse(content){
  try{return parseAIResponse(content);}catch(error){
    // Only recover the exact empty-row typo observed on-device. No nonempty
    // values, additional fields, prose or truncated output may be repaired.
    let text=String(content).replace(/<think>[\s\S]*?<\/think>/g,'').trim();
    const fence=text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);if(fence)text=fence[1].trim();
    if(/^\{\s*"rows"\s*:\s*\[\s*\[\s*""(?:\s*,\s*""){0,5}\s*\]\s*\]\s*"?\s*\}\s*$/.test(text))return {rows:[['','','','']]};
    throw error;
  }
}
function purchaseDate(request,now=new Date()){
  const text=request.toLocaleLowerCase('tr'),day=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const offset=/\bevvelsi\s+gün\b/u.test(text)?-2:/(^|\s)dün(?=\s|[.,]|$)/u.test(text)?-1:/(^|\s)yarın(?=\s|[.,]|$)/u.test(text)?1:/(^|\s)bugün(?=\s|[.,]|$)/u.test(text)?0:null;
  if(offset!==null){day.setDate(day.getDate()+offset);return {value:localDay(day),explicit:true};}
  const months=['ocak','şubat','mart','nisan','mayıs','haziran','temmuz','ağustos','eylül','ekim','kasım','aralık'];
  let y,m,d,match=text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if(match){[,y,m,d]=match;}else if((match=text.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/))){[,d,m,y]=match;}
  else if((match=text.match(new RegExp('\\b(\\d{1,2})\\s+('+months.join('|')+')(?:\\s+(\\d{4}))?','u')))){d=match[1];m=months.indexOf(match[2])+1;y=match[3]||now.getFullYear();}
  if(match){const parsed=new Date(Number(y),Number(m)-1,Number(d));if(parsed.getFullYear()!==Number(y)||parsed.getMonth()!==Number(m)-1||parsed.getDate()!==Number(d))throw Error('Metindeki tarih geçerli değil. Tarihi düzeltip tekrar dene.');return {value:localDay(parsed),explicit:true};}
  if(/(?:^|\s)(?:geçen|önceki|haftaya|pazartesi|salı|çarşamba|perşembe|cuma|cumartesi|pazar|tarih)(?=\s|[.,]|$)/u.test(text))throw Error('Bu tarih ifadesini gün/ay/yıl olarak yazabilir misin? Kayıt değiştirilmedi.');
  return {value:localDay(now),explicit:false};
}
function purchaseRows(raw,request,now=new Date()){
  if(Array.isArray(raw?.rows)&&raw.rows.length===1&&Array.isArray(raw.rows[0])&&raw.rows[0].length>=1&&raw.rows[0].length<=6&&raw.rows[0].every(v=>v===''))raw={rows:[['','','','']]};
  if(!raw||!Array.isArray(raw.rows)||raw.rows.length!==1||!Array.isArray(raw.rows[0])||raw.rows[0].length!==4||raw.rows[0].some(v=>typeof v!=='string'))throw Error('Bu sürümde her girişte tek alışveriş cümlesi kullan. Model dört alan döndürmeli. Hiçbir kayıt değiştirilmedi.');
  const row=raw.rows[0].map(v=>v.trim()),date=purchaseDate(request,now),source=sourceText(request);
  // Only accept product words grounded in the current request, never a previous row.
  if(row[1]&&!source.includes(sourceText(row[1]).trim()))row[1]='';
  if(/^(?:gitti|aldı|aldim|aldım|markete?|mağaza|dükkan)$/iu.test(row[1]))row[1]='';
  const quantities=countedUnits(request,'kg|kilo(?:gram)?|gram|gr|adet|tane|litre|lt|paket|kutu|şişe|çuval|metre');
  if(quantities.length===1)row[2]=quantities[0].text;
  else if(row[2]){const number=row[2].match(/\d+(?:[.,]\d+)?/),unit=number?quantities.find(q=>q.value===numeric(number[0])):quantities.find(q=>sourceText(q.source).trim()===sourceText(row[2]).trim());if(unit)row[2]=unit.text;else if(!source.includes(sourceText(row[2]).trim())||!number)row[2]='';}
  if(row[3]){const amount=numeric(row[3].replace(/[^\d.,-]/g,''));if(amount===null||!monetaryEvidence(request).numbers.includes(amount))row[3]='';}
  return {rows:[[date.value,row[1],row[2],row[3],localDay(now),request]],purchaseExplicitDate:date.explicit};
}
function routePurchase(plan,request){
  const matched=plan.rows[0].slice(1,4).filter(v=>v.trim()).length;
  if(matched>=2){plan.message='Alışveriş önerisi hazır. Ürün, miktar ve tutardan '+matched+' alan eşleşti. Tarih bu sayıya dahil değil.';plan.purchase=true;return plan;}
  const inbox=db.tabs.find(t=>t.kind==='unmatched');
  return {...plan,action:'create_tab',tab_name:inbox?.name||'Eşleşmeyenler',headers:['Kayıt tarihi','Cümle'],meanings:['Kayıt tarihi','Cümle'],rows:[[localDay(),request]],audit:true,destinationId:inbox?.id||null,unmatched:true,message:'Ürün, miktar ve tutardan en az iki alan eşleşmedi. Cümlenin tamamı Eşleşmeyenler’e kaydedilecek.'};
}

function turkishCount(text){
 const words=sourceText(text).trim().split(/\s+/),ones=['sifir','bir','iki','uc','dort','bes','alti','yedi','sekiz','dokuz'],tens=['on','yirmi','otuz','kirk','elli','altmis','yetmis','seksen','doksan'];
 if(words.length===1&&words[0]==='yarim')return 0.5;
 let half=0;if(words.at(-1)==='bucuk'){half=0.5;words.pop();}
 const small=t=>{if(!t.length)return 0;if(t.length===1){if(ones.includes(t[0]))return ones.indexOf(t[0]);if(tens.includes(t[0]))return (tens.indexOf(t[0])+1)*10;}if(t.length===2&&tens.includes(t[0])&&ones.indexOf(t[1])>0)return (tens.indexOf(t[0])+1)*10+ones.indexOf(t[1]);return null;};
 const group=t=>{const i=t.indexOf('yuz');if(i<0)return small(t);if(t.lastIndexOf('yuz')!==i||i>1)return null;const prefix=i===0?1:ones.indexOf(t[0]),tail=small(t.slice(i+1));return prefix>0&&tail!==null?prefix*100+tail:null;};
 if(!words.length)return null;const k=words.indexOf('bin');let value;if(k<0)value=group(words);else{if(words.lastIndexOf('bin')!==k)return null;const high=k===0?1:group(words.slice(0,k)),low=group(words.slice(k+1));value=high>0&&low!==null?high*1000+low:null;}return value===null?null:value+half;
}
function countedUnits(request,units){
 const word='(?:sıfır|sifir|bir|iki|üç|uc|dört|dort|beş|bes|altı|alti|yedi|sekiz|dokuz|on|yirmi|otuz|kırk|kirk|elli|altmış|altmis|yetmiş|yetmis|seksen|doksan|yüz|yuz|bin|yarım|yarim|buçuk|bucuk)';
 const expression=new RegExp('(?:^|[^\\p{L}\\p{N}])((?:\\d+(?:[.,]\\d+)?|'+word+'(?:\\s+'+word+')*)\\s*('+units+'))(?=$|[^\\p{L}])','giu');
 const result=[];for(const match of request.matchAll(expression)){const unit=match[2],amount=match[1].slice(0,match[1].length-unit.length).trim(),value=/^\d/.test(amount)?numeric(amount):turkishCount(amount);if(value!==null)result.push({value,unit,text:String(value).replace('.',',')+' '+unit,source:match[1]});}return result;
}
function nightQuantity(request){return countedUnits(request,'gece')[0]?.text||'';}
