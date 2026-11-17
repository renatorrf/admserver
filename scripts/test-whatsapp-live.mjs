import { parseEnv } from 'node:util';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const { fetch, AbortSignal } = globalThis;

const env = {...parseEnv(readFileSync('.env','utf8')),...process.env};
const option = name => process.argv[process.argv.indexOf(name)+1];
const waba = option('--waba');
const to = option('--to');
if (!/^[0-9]{5,32}$/.test(waba ?? '') || (process.argv.includes('--send') && !/^55[1-9]\d{9,10}$/.test(to ?? ''))) {
  throw new Error('Informe --waba ID. Envio real exige --send --to 55DDDNUMERO autorizado para testes.');
}
const base = 'https://graph.facebook.com/'+env.WHATSAPP_GRAPH_API_VERSION;
const headers = {Authorization:'Bearer '+env.WHATSAPP_ACCESS_TOKEN,'Content-Type':'application/json'};
async function call(path,body) {
  const response = await fetch(base+'/'+path,{headers,method:body?'POST':'GET',redirect:'error',
    signal:AbortSignal.timeout(15000),...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();
  if (!response.ok) throw new Error('Meta: HTTP '+response.status+' codigo '+String(data.error?.code ?? 'desconhecido'));
  return data;
}
const templates=await call(waba+'/message_templates?fields=name,status,language,category,components&limit=100');
const specs=[
  {name:env.WHATSAPP_FIRST_ACCESS_TEMPLATE,count:1,params:['Teste de integração ADM Taxi']},
  {name:env.WHATSAPP_RIDE_TEMPLATE,count:5,params:['Teste de integração ADM Taxi','TESTE - sem corrida real',
    'Origem fictícia para teste','Destino fictício para teste','https://admbrasil-taxi.web.app/']},
];
const evidence={testedAt:new Date().toISOString(),templates:[]};
for (const spec of specs) {
  const template=templates.data?.find(t=>t.name===spec.name && t.language===env.WHATSAPP_TEMPLATE_LANGUAGE && t.status==='APPROVED');
  const body=template?.components?.find(c=>c.type==='BODY');
  const variables=new Set(body?.text?.match(/{{\d+}}/g) ?? []);
  if (!template || variables.size!==spec.count || template.components.some(c=>c.type==='BUTTONS')
    || template.components.some(c=>c.type==='HEADER' && (c.format!=='TEXT' || /{{/.test(c.text)))) {
    throw new Error('Modelo aprovado com contrato inesperado: '+spec.name);
  }
  const result={name:template.name,category:template.category,language:template.language,status:template.status,variables:spec.count};
  console.log(JSON.stringify(result));
  if(process.argv.includes('--send')) {
    const delivery=await call(env.WHATSAPP_PHONE_NUMBER_ID+'/messages',{messaging_product:'whatsapp',
      to,type:'template',template:{name:spec.name,language:{code:env.WHATSAPP_TEMPLATE_LANGUAGE},
        components:[{type:'body',parameters:spec.params.map(text=>({type:'text',text}))}]}});
    result.messageId=delivery.messages?.[0]?.id;
    result.apiAccepted=Boolean(result.messageId);
    console.log(JSON.stringify({template:spec.name,apiAccepted:result.apiAccepted,messageId:result.messageId}));
  }
  evidence.templates.push(result);
}
mkdirSync('.artifacts',{recursive:true});
writeFileSync(process.argv.includes('--send') ? '.artifacts/whatsapp-live-test.json' : '.artifacts/whatsapp-template-check.json',
  JSON.stringify(evidence,null,2)+'\n');
