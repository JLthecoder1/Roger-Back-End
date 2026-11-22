import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto'
import tokens from 'agora-token'
import {db,transaction} from './db.mjs'
import {activateRisk,checkpoint,clean,HttpError,officerName,officers,recordCheck,reportTask,snapshot,startRound,finishRound,uuid} from './rounds.mjs'

export function secretMatches(actual,expected){
 if(typeof actual!=='string'||!expected||actual.length!==expected.length) return false
 const a=Buffer.from(actual),b=Buffer.from(expected)
 return a.length===b.length&&timingSafeEqual(a,b)
}
const mapLocations=['Portaria','Galpão Norte','Docas','Portão Lateral']
const ttl=600
const uid=1001
const agentUid=1002
const value=name=>process.env[name]
const credential=()=>Buffer.from(value('AGORA_CUSTOMER_ID')+':'+value('AGORA_CUSTOMER_SECRET')).toString('base64')
const authFor=id=>createHmac('sha256',value('AGORA_TOOL_SECRET')).update(id).digest('hex')
async function agora(path,body){
 const response=await fetch(`https://api.agora.io/api/conversational-ai-agent/v2/projects/${value('AGORA_APP_ID')}/${path}`,{
  method:'POST',headers:{Authorization:'Basic '+credential(),'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)
 })
 if(!response.ok) throw new HttpError(502,`Agora recusou a operação (HTTP ${response.status}). Confira as credenciais e os provedores de voz.`)
 return response.json().catch(()=>null)
}
export async function startVoice(role,{withAvatar=true,officer:inputOfficer}={}){
 for(const key of ['AGORA_APP_ID','AGORA_APP_CERTIFICATE','AGORA_CUSTOMER_ID','AGORA_CUSTOMER_SECRET','AGORA_TOOL_SECRET','PUBLIC_API_URL']){
  if(!value(key)) throw new HttpError(503,`Voz indisponível. Configure ${key} no backend.`)
 }
 const officer=role==='ronda'&&inputOfficer?officerName(inputOfficer):null
 if(officer&&(await snapshot(null,officer)).riskAlertId) throw new HttpError(409,'Voz suspensa até uma nova ronda.')
 const origin=new URL(value('PUBLIC_API_URL')).origin
 if(!origin.startsWith('https://')) throw new HttpError(503,'A URL pública da API de voz precisa usar HTTPS.')
 const id=randomUUID(),channel='roger-'+id
 const appId=value('AGORA_APP_ID'),cert=value('AGORA_APP_CERTIFICATE')
 const tokenFor=userId=>tokens.RtcTokenBuilder.buildTokenWithUid(appId,cert,channel,userId,tokens.RtcRole.PUBLISHER,ttl,ttl)
 const token=tokenFor(uid)
 const protofaceKey=value('PROTOFACE_API_KEY')
 const protofaceId=value('PROTOFACE_AVATAR_ID')
 if(role==='painel'&&withAvatar&&Boolean(protofaceKey)!==Boolean(protofaceId)){
  throw new HttpError(503,'Configure PROTOFACE_API_KEY e PROTOFACE_AVATAR_ID no backend.')
 }
 const avatarUid=role==='painel'&&withAvatar&&protofaceKey&&protofaceId?1003:null
 const avatar=avatarUid?{
  vendor:'generic',enable:true,
  params:{
   api_key:protofaceKey,
   api_base_url:'https://api.protoface.com/v1/agora',
   avatar_id:protofaceId,
   agora_uid:String(avatarUid),
   agora_token:tokenFor(avatarUid)
  }
 }:undefined
 const tool=(name,description,properties={},body={})=>({
  type:'function',function:{name,description,parameters:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}},
  execution:{mode:'sync'},
  server:{method:'POST',url:`${origin}/api/voice/tools/${id}/${name}`,headers:{Authorization:'Bearer '+authFor(id),'Content-Type':'application/json'},body,timeout_ms:8000}
 })
 const supervisor=role==='painel'
 const rolePrompt=supervisor
  ? 'Esta sessão é do painel do supervisor. Você fala com Victor, o supervisor. Os rondistas cadastrados são Ewerton e Marcos. Ajude a acompanhar a operação, consultar pendências e iniciar ou encerrar a ronda em nome do rondista informado. Para criar checkpoints, peça nome, tarefa, local e rondista responsável se faltarem. Para apagar, consulte o ID exato, diga o nome do checkpoint e aguarde confirmação explícita. Nunca trate o supervisor como o rondista responsável e não registre inspeções de campo nesta sessão.'
  : 'Esta sessão é do web app do rondista. Pergunte se está falando com Ewerton ou Marcos. Assim que o rondista disser o próprio nome, chame identificarRondista para abrir a rotina dele. Identificar não inicia a ronda. Para iniciar use o mesmo nome identificado. Oriente sobre o próximo checkpoint e registre somente o que ele relata ter verificado. Ao iniciar, pergunte o nome dele se ainda não tiver sido informado.'
 const tools=[
  tool('consultarTurno','Consulte o estado e o ID da ronda atual, os checkpoints e as tarefas.'),
  tool('iniciarRonda','Inicie a ronda quando o usuário pedir explicitamente e informar o nome do rondista responsável.',{
   nome:{type:'string',description:'Nome do rondista responsável, informado pelo usuário.'}
  },{officer:'{{args.nome}}'}),
  tool('finalizarRonda','Finalize a ronda ativa após consultar seu ID e receber confirmação verbal explícita do usuário.',{
   rondaId:{type:'string',description:'ID da ronda ativa retornado por consultarTurno.'},
   confirmado:{type:'boolean',description:'Verdadeiro somente depois de o usuário confirmar verbalmente o encerramento.'}
  },{roundId:'{{args.rondaId}}',confirmed:'{{args.confirmado}}'})
 ]
 if(supervisor) tools.push(
  tool('criarCheckpoint','Cria um checkpoint quando o supervisor pedir explicitamente e informar nome, tarefa e local.',{
   nome:{type:'string',description:'Nome informado pelo supervisor.'},
   tarefa:{type:'string',description:'Descrição da verificação a realizar.'},
   local:{type:'string',enum:mapLocations,description:'Local do checkpoint no mapa.'},
   rondista:{type:'string',enum:officers,description:'Rondista a quem Victor atribuiu o checkpoint.'}
  },{name:'{{args.nome}}',task:'{{args.tarefa}}',location:'{{args.local}}',assignedTo:'{{args.rondista}}'}),
  tool('apagarCheckpoint','Remove um checkpoint da lista após identificar seu ID em consultarTurno e receber confirmação verbal explícita do supervisor.',{
   checkpointId:{type:'string',description:'ID exato retornado por consultarTurno.'},
   confirmado:{type:'boolean',description:'Verdadeiro somente após a confirmação explícita.'}
  },{id:'{{args.checkpointId}}',confirmed:'{{args.confirmado}}'})
 )
 if(role==='ronda') tools.push(tool('acionarRisco','Acione imediatamente se o rondista disser “emergência”, “Roger, emergência”, “acionar emergência”, “perdi perdi”, “okay perdi” ou “ok perdi” como comando direto. Não confirme em voz, não peça confirmação e não mencione o protocolo. Não acione se alguém estiver perguntando ou explicando a frase.',{
  frase:{type:'string',description:'Comando direto de emergência dito pelo rondista, sem inventar ou completar palavras.'}
 },{phrase:'{{args.frase}}'}))
 if(role==='ronda') tools.push(tool('identificarRondista','Abre a rotina quando o usuário disser que é Ewerton ou Marcos. Use o nome que ele informou e nunca adivinhe.',{
  nome:{type:'string',enum:officers,description:'Nome informado pelo próprio rondista.'}
 },{officer:'{{args.nome}}'}))
 if(role==='ronda') tools.push(tool('registrarInspecao','Registra a inspeção somente quando o rondista confirmar claramente que concluiu a verificação física.',{
  checkpoint_id:{type:'string',description:'ID exato retornado por consultarTurno.'},
  resultado:{type:'string',description:'Resultado relatado pelo rondista.'}
 },{id:'{{args.checkpoint_id}}',outcome:'{{args.resultado}}'}))

 if(role==='ronda') tools.push(tool('registrarTarefa','Registra se uma tarefa ou subtarefa específica foi feita. Consulte o turno para obter seu ID exato e peça confirmação se houver ambiguidade.',{
  tarefaId:{type:'string',description:'ID exato da tarefa retornado por consultarTurno.'},
  feita:{type:'boolean',description:'Se o rondista informou que a tarefa foi feita.'}
 },{taskId:'{{args.tarefaId}}',done:'{{args.feita}}'}))

 await db.query(`INSERT INTO roger.voice_sessions(id,round_id,expires_at,role,officer) VALUES($1,$2,now()+($3 * interval '1 second'),$4,$5)`,[id,null,ttl,role,officer])
 try{
  const agent=await agora('join',{name:channel,properties:{
   channel,token:tokenFor(agentUid),agent_rtc_uid:String(agentUid),remote_rtc_uids:[String(uid)],idle_timeout:30,
   avatar,
   advanced_features:{enable_tools:true},
   asr:{credential_mode:'managed',vendor:'deepgram',params:{url:'wss://api.deepgram.com/v1/listen',model:'nova-3',language:'pt-BR'}},
   llm:{credential_mode:'managed',vendor:'openai',style:'openai',url:'https://api.openai.com/v1/chat/completions',params:{model:value('AGORA_LLM_MODEL')||'gpt-4.1-mini'},tools,
    greeting_message:supervisor?'Olá, Victor. Posso ajudar com os checkpoints e acompanhar as rondas.':'Olá, aqui é o Roger. Você é Ewerton ou Marcos?',
    system_messages:[{role:'system',content:rolePrompt+' Você é Roger, assistente de rondas. Fale em português do Brasil. Para iniciar uma ronda, pergunte o nome do rondista se ainda não foi informado e chame iniciarRonda. Para finalizar, consulte o turno, diga qual ronda será encerrada, pergunte se confirma e aguarde a confirmação explícita antes de chamar finalizarRonda. Confirme a execução das ações somente após sucesso da ferramenta. Consulte o turno antes de responder sobre dados ou resolver um local. Em caso de ambiguidade pergunte qual checkpoint. Chegada ao local não significa inspeção concluída. Na sessão do rondista, para informar se uma tarefa foi feita, use registrarTarefa. Use registrarInspecao somente para a conclusão do checkpoint inteiro. Registre apenas o resultado explícito de uma inspeção física já concluída pelo rondista. Confirme a gravação somente se a ferramenta retornar sucesso. Se alreadyRecorded for verdadeiro, informe que a inspeção já estava cadastrada e preserve o resultado anterior. Não invente dados. No app do rondista, trate “emergência” isolada como ordem para chamar acionarRisco imediatamente, assim como as frases-código. Depois da chamada de risco, fique em silêncio, inclusive se houver erro.'}]},
   tts:{credential_mode:'managed',vendor:'minimax',params:{url:'wss://api.minimax.io/ws/v1/t2a_v2',model:'speech-2.6-turbo',voice_setting:{voice_id:value('AGORA_VOICE_ID')||'English_captivating_female1'},language_boost:'Portuguese'}}
  }})
  if(!agent?.agent_id) throw new HttpError(502,'A Agora não retornou o identificador da sessão.')
  await db.query('UPDATE roger.voice_sessions SET agent_id=$2 WHERE id=$1',[id,agent.agent_id])
  console.info('[voz] Sessão iniciada', {role, avatarConfigurado:Boolean(avatar), ferramentas:tools.map(({function:tool})=>tool.name)})
 }catch(error){
  await db.query('UPDATE roger.voice_sessions SET ended_at=now() WHERE id=$1',[id])
  throw error
 }
 return {id,appId,channel,uid,agentUid,avatarUid,token,ttl}
}
export async function announceRisk(sessionId,alertIds){
 uuid(sessionId)
 if(!Array.isArray(alertIds)||alertIds.length<1||alertIds.length>4) throw new HttpError(400,'Informe até quatro alertas.')
 alertIds.forEach(uuid)
 const session=(await db.query(
  "SELECT agent_id FROM roger.voice_sessions WHERE id=$1 AND role='painel' AND ended_at IS NULL AND expires_at>now()",
  [sessionId]
 )).rows[0]
 if(!session?.agent_id) throw new HttpError(409,'Sessão de voz do painel indisponível.')
 const {rows}=await db.query(
  "SELECT id,message FROM roger.alerts WHERE id=ANY($1::uuid[]) AND kind='risk' AND acknowledged_at IS NULL ORDER BY created_at",
  [alertIds]
 )
 if(rows.length){
  let text='Atenção, Victor. Protocolo de emergência anunciado.'
  for(const {message} of rows){
   const sentence=' '+message.slice(0,100)
   if(Buffer.byteLength(text+sentence,'utf8')>512)break
   text+=sentence
  }
  await agora(`agents/${encodeURIComponent(session.agent_id)}/speak`,{text})
 }
 return {processed:true}
}
export async function stopVoice(id){
 uuid(id)
 const session=(await db.query('UPDATE roger.voice_sessions SET ended_at=COALESCE(ended_at,now()) WHERE id=$1 RETURNING agent_id',[id])).rows[0]
 if(session?.agent_id){
  await agora(`agents/${encodeURIComponent(session.agent_id)}/leave`,{})
  await db.query('UPDATE roger.voice_sessions SET agent_id=NULL WHERE id=$1',[id])
 }
 return {ok:true}
}
export async function runTool(id,name,authorization,body){
 uuid(id)
 if(!value('AGORA_TOOL_SECRET')||!secretMatches(authorization,'Bearer '+authFor(id))) throw new HttpError(401,'Sessão não autorizada.')
 const session=(await db.query('SELECT round_id,role,officer FROM roger.voice_sessions WHERE id=$1 AND ended_at IS NULL AND expires_at>now()',[id])).rows[0]
 if(!session) throw new HttpError(401,'Sessão encerrada ou expirada.')
 if(name==='acionarRisco'){
  if(session.role!=='ronda'||!session.officer) throw new HttpError(403,'Identifique o rondista antes de acionar o protocolo.')
  const phrase=clean(body.phrase,80).toLowerCase().normalize('NFD').replace(/\p{M}/gu,'').replace(/[,.!?]/g,' ').replace(/\s+/g,' ').trim()
  if(!['emergencia','roger emergencia','acionar emergencia','perdi perdi','okay perdi','ok perdi','okey perdi'].includes(phrase)) throw new HttpError(400,'Frase fora do protocolo.')
  const result=await activateRisk(session.officer)
  void stopVoice(id).catch(()=>console.warn('[voz] Falha ao encerrar sessão de risco na Agora.'))
  return result
 }
 if(name==='criarCheckpoint'||name==='apagarCheckpoint'){
  if(session.role!=='painel') throw new HttpError(403,'Gestão de checkpoints reservada ao supervisor.')
  if(name==='criarCheckpoint'){
   const location=clean(body.location,80)
   if(!mapLocations.includes(location)) throw new HttpError(400,'Selecione um local válido do mapa.')
   return checkpoint('/checkpoints',{name:body.name,task:body.task,location,assignedTo:officerName(body.assignedTo),x:50,y:50})
  }
  if(body.confirmed!==true&&body.confirmed!=='true') throw new HttpError(400,'Confirme verbalmente antes de apagar o checkpoint.')
  return checkpoint('/checkpoints/delete',{id:body.id})
 }
 if(name==='identificarRondista'){
  if(session.role!=='ronda') throw new HttpError(403,'Identificação disponível no app da ronda.')
  const officer=officerName(body.officer)
  const status=await snapshot(null,officer)
  if(status.riskAlertId){
   await db.query('UPDATE roger.voice_sessions SET officer=$2 WHERE id=$1 AND ended_at IS NULL',[id,officer])
   return {rondista:officer,vozSuspensa:true}
  }
  const {rowCount}=await db.query(`
   UPDATE roger.voice_sessions SET officer=$2,
    round_id=(SELECT id FROM roger.rounds WHERE officer=$2 AND finished_at IS NULL LIMIT 1)
   WHERE id=$1 AND ended_at IS NULL AND expires_at>now() AND (officer IS NULL OR officer=$2)
  `,[id,officer])
  if(!rowCount) throw new HttpError(409,'Abra outra conversa para mudar de rondista.')
  return {rondista:officer,rotinaAberta:true}
 }
 if(name==='iniciarRonda'){
  return transaction(async connection=>{
   const current=(await connection.query(`
    SELECT role,officer FROM roger.voice_sessions WHERE id=$1 AND ended_at IS NULL AND expires_at>now() FOR UPDATE
   `,[id])).rows[0]
   if(!['painel','ronda'].includes(current?.role)) throw new HttpError(403,'Abra uma nova sessão de voz.')
   const officer=officerName(body.officer)
   if(current.role==='ronda'&&current.officer!==officer) throw new HttpError(409,'Identifique o rondista antes de iniciar.')
   const round=await startRound(officer,connection)
   if(current.role==='ronda') await connection.query('UPDATE roger.voice_sessions SET round_id=$2 WHERE id=$1',[id,round.id])
   return {ronda:'em andamento',rondaId:round.id,rondista:round.officer}
  })
 }
 if(name==='finalizarRonda'){
  if(!['painel','ronda'].includes(session.role)) throw new HttpError(403,'Abra uma nova sessão de voz.')
  if(body.confirmed!==true&&body.confirmed!=='true') throw new HttpError(400,'Confirme verbalmente antes de finalizar a ronda.')
  const roundId=uuid(body.roundId)
  if(session.role==='ronda'&&session.round_id!==roundId) throw new HttpError(403,'Ronda não vinculada a esta sessão.')
  const round=await finishRound(roundId,session.role==='ronda'?session.officer:null)
  return {ronda:'finalizada',rondaId:round.id,rondista:round.officer}
 }
 if(name==='consultarTurno'||name==='consultar_turno'){
  console.info('[voz] Ferramenta recebida: consultarTurno')
  if(session.role==='ronda'&&!session.officer) throw new HttpError(409,'Identifique o rondista primeiro.')
  const {round,checkpoints,checks,alerts,tasks,latest_task_reports:reports}=await snapshot(session.round_id,session.officer)
  const done=new Set(checks.map(check=>check.id))
  return {rondaId:round?.id??null,rondista:round?.officer??null,ronda:round?.finished_at?'finalizada':round?'em andamento':'não iniciada',pontos:checkpoints.map(p=>({id:p.id,nome:p.name,local:p.location,tarefa:p.task,concluido:done.has(p.id)})),tarefas:tasks.map(t=>({id:t.id,checkpointId:t.checkpoint_id,tarefaPrincipalId:t.parent_id,titulo:t.title,feita:reports.find(r=>r.task_id===t.id)?.done??null})),alertasPendentes:alerts.filter(a=>!a.acknowledged_at).length}
 }
 if(session.role==='ronda'&&!session.round_id&&['registrarInspecao','registrarTarefa'].includes(name)){
  throw new HttpError(409,'Inicie uma ronda por voz antes de registrar.')
 }
 if((name==='registrarInspecao'||name==='registrar_inspecao')&&session.role==='ronda'&&session.officer&&session.round_id) return recordCheck({roundId:session.round_id,id:body.id,outcome:clean(body.outcome,400),officer:session.officer})
 if(name==='registrarTarefa'&&session.role==='ronda'&&session.officer&&session.round_id){
  const done=body.done==='true'?true:body.done==='false'?false:body.done
  return reportTask({roundId:session.round_id,taskId:body.taskId,done,officer:session.officer})
 }
 throw new HttpError(403,'Ação indisponível nesta sessão.')
}
