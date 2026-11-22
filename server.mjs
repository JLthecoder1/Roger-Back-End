import express from 'express'
import {startRiskBuzzer} from './risk-buzzer.mjs'
import cors from 'cors'
import {randomUUID} from 'node:crypto'
import {db} from './db.mjs'
import {activateRisk,checkpoint,clean,HttpError,officerName,recordCheck,reportTask,snapshot,startRound,finishRound,uuid} from './rounds.mjs'
import {announceRisk,runTool,secretMatches,startVoice,stopVoice} from './voice.mjs'

if(!process.env.DATABASE_URL) throw new Error('Configure DATABASE_URL.')
const panelCode=process.env.PANEL_ACCESS_CODE
const patrolCode=process.env.PATROL_ACCESS_CODE
if(panelCode&&panelCode===patrolCode) throw new Error('Use códigos diferentes para painel e ronda.')
const localPort=Number(process.env.ROGER_LOCAL_PORT??4001)
const localOrigins=new Map([
 ['http://localhost:3000','painel'],['http://127.0.0.1:3000','painel'],
 ['http://localhost:5173','ronda'],['http://127.0.0.1:5173','ronda'],
])
const app=express()
app.disable('x-powered-by')
const origins=(process.env.FRONTEND_ORIGINS??'http://localhost:3000,http://localhost:5173').split(',').map(s=>s.trim())
app.use(cors({origin:[...origins,...localOrigins.keys()]}))
app.use(express.json({limit:'16kb'}))
app.use('/api',(_req,res,next)=>{res.set('Cache-Control','no-store');next()})
app.get('/health',async(_req,res)=>{await db.query('SELECT 1');res.json({ok:true})})
app.post('/api/voice/tools/:id/:name',async(req,res)=>res.json(await runTool(req.params.id,req.params.name,req.get('Authorization'),req.body??{})))
app.use('/api',(req,_res,next)=>{
 const auth=req.get('Authorization')
 const localRole=req.socket.localPort===localPort?localOrigins.get(req.get('Origin')):null
 req.role=localRole||(panelCode&&secretMatches(auth,'Bearer '+panelCode)?'painel':patrolCode&&secretMatches(auth,'Bearer '+patrolCode)?'ronda':null)
 next(req.role?undefined:new HttpError(401,'Código de acesso inválido.'))
})
function panel(req){
 if(req.role!=='painel') throw new HttpError(403,'Ação reservada à portaria.')
}
app.get('/api/round',async(req,res)=>{
 if(req.role==='ronda'){
  let officer=req.query.officer?officerName(req.query.officer):null
  if(req.query.voiceSession){
   const {rows}=await db.query("SELECT officer FROM roger.voice_sessions WHERE id=$1 AND role='ronda' AND expires_at>now()",[uuid(req.query.voiceSession)])
   officer=rows[0]?.officer??officer
  }
  if(!officer)return res.json({officer:null,round:null,checkpoints:[],checks:[],tasks:[],latest_task_reports:[],alerts:[]})
  const data=await snapshot(null,officer)
  return res.json({officer,riskAlertId:data.riskAlertId,round:data.round,checkpoints:data.checkpoints,checks:data.checks,tasks:data.tasks,latest_task_reports:data.latest_task_reports,alerts:[]})
 }
 res.json(await snapshot())
})
app.post('/api/round/start',async(req,res)=>res.status(201).json(await startRound(req.body?.officer)))
app.post('/api/round/finish',async(req,res)=>res.json(await finishRound(req.body?.id,req.role==='ronda'?officerName(req.body?.officer):null)))
for(const path of ['/checkpoints','/checkpoints/delete','/checkpoints/assign','/checkpoint-tasks','/checkpoint-tasks/status','/checkpoint-tasks/delete']){
 app.post('/api'+path,async(req,res)=>{panel(req);res.json(await checkpoint(path,req.body??{}))})
}
app.post('/api/task-reports',async(req,res)=>{
 if(req.role!=='ronda') throw new HttpError(403,'Registro reservado ao rondista.')
 res.json(await reportTask({...req.body,officer:officerName(req.body?.officer)}))
})
for(const path of ['/checks','/checkpoints/status']){
 app.post('/api'+path,async(req,res)=>{
  if(path!=='/checks') panel(req)
  const body=req.body??{}
  const roundId=body.roundId??(await snapshot()).round?.id
  if(!roundId) throw new HttpError(409,'Inicie uma ronda antes de registrar a inspeção.')
  res.json(await recordCheck({roundId,id:body.id,done:path==='/checks'?true:body.done,officer:req.role==='ronda'?officerName(body.officer):null}))
 })
}
app.post('/api/alerts/risk',async(req,res)=>{
 if(req.role!=='ronda') throw new HttpError(403,'Protocolo reservado ao rondista.')
 res.status(201).json(await activateRisk(req.body?.officer))
})
app.post('/api/alerts',async(req,res)=>{
 const roundId=req.body?.roundId?uuid(req.body.roundId):null
 const result=await db.query('INSERT INTO roger.alerts(id,round_id,message) VALUES($1,$2,$3) RETURNING *',[randomUUID(),roundId,clean(req.body?.message,300)])
 res.status(201).json(result.rows[0])
})
app.post('/api/alerts/acknowledge',async(req,res)=>{
 panel(req)
 const result=await db.query('UPDATE roger.alerts SET acknowledged_at=COALESCE(acknowledged_at,now()) WHERE id=$1 RETURNING *',[uuid(req.body?.id)])
 if(!result.rowCount) throw new HttpError(404,'Alerta não encontrado.')
 res.json(result.rows[0])
})
app.post('/api/voice/start',async(req,res)=>res.status(201).json(await startVoice(req.role,{withAvatar:req.body?.withAvatar!==false,officer:req.body?.officer})))
app.post('/api/voice/announce-risk',async(req,res)=>{
 panel(req)
 res.json(await announceRisk(req.body?.sessionId,req.body?.alertIds))
})
app.post('/api/voice/stop',async(req,res)=>res.json(await stopVoice(req.body?.id)))
app.use((_req,_res,next)=>next(new HttpError(404,'Rota inexistente.')))
app.use((error,_req,res,_next)=>{
 const status=error.status??(error.code==='23503'?400:500)
 if(status===500) console.error('Erro interno:',error.code??error.name)
 res.status(status).json({error:status===500?'API indisponível.':status===400&&!(error instanceof HttpError)?'Dados inválidos.':error.message})
})
startRiskBuzzer()
const port=Number(process.env.PORT??4000)
if(port===localPort) throw new Error('Use portas diferentes para PORT e ROGER_LOCAL_PORT.')
app.listen(port,'0.0.0.0',()=>console.log('API ROGER ativa na porta '+port))
app.listen(localPort,'127.0.0.1',()=>console.log('Acesso local sem código na porta '+localPort))
