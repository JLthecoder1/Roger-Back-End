import {randomUUID} from 'node:crypto'
import {db,transaction} from './db.mjs'
import {signalRiskBuzzer} from './risk-buzzer.mjs'

export class HttpError extends Error {
 constructor(status,message){super(message);this.status=status}
}
export function clean(value,max){
 if(typeof value!=='string'||!value.trim()||value.trim().length>max) throw new HttpError(400,'Confira os campos informados.')
 return value.trim()
}
export function uuid(value){
 if(typeof value!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw new HttpError(400,'Identificador inválido.')
 return value
}

export const officers=['Ewerton','Marcos']
export function officerName(input){
 const name=clean(input,80).toLowerCase()
 const officer=officers.find(candidate=>candidate.toLowerCase()===name)
 if(!officer) throw new HttpError(400,'Informe Ewerton ou Marcos.')
 return officer
}
export async function startRound(officer, connection=db){
 const result=await connection.query('INSERT INTO roger.rounds(id,officer) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING *',[randomUUID(),officerName(officer)])
 if(!result.rowCount) throw new HttpError(409,'Já existe uma ronda em andamento.')
 return result.rows[0]
}
export async function finishRound(id,officer=null){
 const result=await db.query('UPDATE roger.rounds SET finished_at=now() WHERE id=$1 AND finished_at IS NULL AND ($2::text IS NULL OR officer=$2) RETURNING *',[uuid(id),officer])
 if(!result.rowCount) throw new HttpError(409,'Ronda já encerrada ou inexistente.')
 return result.rows[0]
}
function riskMessage(officer){
 return `Rondista ${officer} acionou o protocolo de risco.`
}

export async function activateRisk(officer){
 officer=officerName(officer)
 const message=riskMessage(officer)
 const result=await transaction(async connection=>{
  await connection.query('SELECT pg_advisory_xact_lock(42703,hashtext($1))',[officer])
  const round=(await connection.query(
   'SELECT id,started_at,finished_at FROM roger.rounds WHERE officer=$1 ORDER BY (finished_at IS NULL) DESC,started_at DESC LIMIT 1 FOR UPDATE',[officer]
  )).rows[0]
  const active=round&&!round.finished_at?round:null
  const existing=(await connection.query(`
   SELECT id FROM roger.alerts WHERE kind='risk' AND (
    round_id=$1 OR (round_id IS NULL AND message=$2 AND ($3::timestamptz IS NULL OR created_at >= $3))
   ) ORDER BY created_at DESC LIMIT 1
  `,[active?.id??null,message,round?.started_at??null])).rows[0]
  if(existing)return {alertId:existing.id,novo:false}
  const alertId=randomUUID()
  await connection.query("INSERT INTO roger.alerts(id,round_id,message,kind) VALUES($1,$2,$3,'risk')",[alertId,active?.id??null,message])
  return {alertId,novo:true}
 })
 if(result.novo)signalRiskBuzzer(result.alertId)
 return {riscoAtivado:true,...result}
}
export async function snapshot(pinnedRound=null,officer=null){
 const result=await db.query(`
  WITH current_round AS (
    SELECT * FROM roger.rounds WHERE ($1::uuid IS NULL OR id=$1) AND ($2::text IS NULL OR officer=$2)
    ORDER BY (finished_at IS NULL) DESC,started_at DESC LIMIT 1
  )
  SELECT
   (SELECT row_to_json(r) FROM current_round r) AS round,
   (SELECT a.id FROM roger.alerts a WHERE a.kind='risk' AND (
    a.round_id=(SELECT id FROM current_round) OR
    ($3::text IS NOT NULL AND a.round_id IS NULL AND a.message=$3
     AND a.created_at >= COALESCE((SELECT started_at FROM current_round),'-infinity'::timestamptz))
   ) ORDER BY a.created_at DESC LIMIT 1) AS "riskAlertId",
   COALESCE((SELECT json_agg(p ORDER BY p.created_at,p.id) FROM roger.checkpoints p WHERE NOT p.archived AND ($2::text IS NULL OR p.assigned_to=$2)),'[]') AS checkpoints,
   COALESCE((SELECT json_agg(c ORDER BY c.created_at DESC) FROM roger.checks c JOIN current_round r ON r.id=c.round_id JOIN roger.checkpoints p ON p.id=c.id WHERE NOT p.archived AND ($2::text IS NULL OR p.assigned_to=$2)),'[]') AS checks,
   COALESCE((SELECT json_agg(t ORDER BY t.created_at) FROM roger.checkpoint_tasks t JOIN roger.checkpoints p ON p.id=t.checkpoint_id WHERE NOT p.archived AND ($2::text IS NULL OR p.assigned_to=$2) AND t.archived_at IS NULL),'[]') AS tasks,
   COALESCE((SELECT json_agg(t ORDER BY t.created_at DESC,t.id DESC) FROM (
     SELECT t.* FROM roger.task_reports t JOIN current_round r ON r.id=t.round_id ORDER BY t.created_at DESC,t.id DESC LIMIT 100
   ) t),'[]') AS task_reports,
   COALESCE((SELECT json_agg(t ORDER BY t.created_at DESC,t.id DESC) FROM (
     SELECT DISTINCT ON (t.task_id) t.* FROM roger.task_reports t JOIN current_round r ON r.id=t.round_id
     ORDER BY t.task_id,t.created_at DESC,t.id DESC
   ) t),'[]') AS latest_task_reports,
   COALESCE((SELECT json_agg(t ORDER BY t.created_at DESC,t.id DESC) FROM (
     SELECT * FROM roger.task_reports ORDER BY created_at DESC,id DESC LIMIT 100
   ) t),'[]') AS task_history,
   COALESCE((SELECT json_agg(a ORDER BY a.created_at DESC) FROM (SELECT * FROM roger.alerts ORDER BY created_at DESC LIMIT 100) a),'[]') AS alerts,
   COALESCE((SELECT json_agg(h ORDER BY h.created_at DESC) FROM (
     SELECT c.*,p.name FROM roger.checks c JOIN roger.checkpoints p ON p.id=c.id ORDER BY c.created_at DESC LIMIT 100
   ) h),'[]') AS history
 `,[pinnedRound,officer,officer?riskMessage(officer):null])
 return result.rows[0]
}

export async function recordCheck({roundId,id,done=true,outcome=null,officer=null}){
 uuid(roundId)
 id=clean(id,20)
 if(typeof done!=='boolean') throw new HttpError(400,'Status inválido.')
 return transaction(async connection=>{
  const round=(await connection.query('SELECT * FROM roger.rounds WHERE id=$1 FOR UPDATE',[roundId])).rows[0]
  if(!round||round.finished_at) throw new HttpError(409,'A ronda vinculada precisa estar em andamento.')
  if(officer&&round.officer!==officer) throw new HttpError(403,'Esta ronda pertence a outro agente.')
  const point=(await connection.query('SELECT name FROM roger.checkpoints WHERE id=$1 AND NOT archived AND ($2::text IS NULL OR assigned_to=$2) FOR SHARE',[id,officer])).rows[0]
  if(!point) throw new HttpError(404,'Checkpoint não encontrado.')
  if(done){
   const saved=await connection.query('INSERT INTO roger.checks(round_id,id,officer,outcome) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING outcome',[roundId,id,round.officer,outcome])
   const recorded=saved.rows[0]??(await connection.query('SELECT outcome FROM roger.checks WHERE round_id=$1 AND id=$2',[roundId,id])).rows[0]
   return {id,name:point.name,done,outcome:recorded.outcome,alreadyRecorded:!saved.rowCount}
  }
  await connection.query('DELETE FROM roger.checks WHERE round_id=$1 AND id=$2',[roundId,id])
  return {id,name:point.name,done}
 })
}
export async function reportTask({roundId,taskId,done,officer=null}){
 uuid(roundId)
 uuid(taskId)
 if(typeof done!=='boolean') throw new HttpError(400,'Informe se a tarefa foi feita.')
 return transaction(async connection=>{
  const round=(await connection.query('SELECT officer FROM roger.rounds WHERE id=$1 AND finished_at IS NULL FOR UPDATE',[roundId])).rows[0]
  if(!round) throw new HttpError(409,'Inicie uma ronda antes de registrar a tarefa.')
  if(officer&&round.officer!==officer) throw new HttpError(403,'Esta ronda pertence a outro agente.')
  const task=(await connection.query(`
   SELECT t.title,p.name,p.location FROM roger.checkpoint_tasks t
   JOIN roger.checkpoints p ON p.id=t.checkpoint_id
   WHERE t.id=$1 AND t.archived_at IS NULL AND NOT p.archived AND ($2::text IS NULL OR p.assigned_to=$2) FOR SHARE OF t,p
  `,[taskId,officer])).rows[0]
  if(!task) throw new HttpError(404,'Tarefa indisponível.')
  const last=(await connection.query(`
   SELECT * FROM roger.task_reports WHERE round_id=$1 AND task_id=$2
   ORDER BY created_at DESC,id DESC LIMIT 1
  `,[roundId,taskId])).rows[0]
  if(last?.done===done) return last
  return (await connection.query(`
   INSERT INTO roger.task_reports(id,round_id,task_id,task_title,checkpoint_name,location,officer,done)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
  `,[randomUUID(),roundId,taskId,task.title,task.name,task.location,round.officer,done])).rows[0]
 })
}
export async function checkpoint(path,body){
 if(path==='/checkpoints'){
  const {x,y}=body
  if(![x,y].every(n=>Number.isFinite(n)&&n>=0&&n<=100)) throw new HttpError(400,'Informe uma posição válida.')
  const id='CP-'+randomUUID().slice(0,8).toUpperCase()
  await db.query('INSERT INTO roger.checkpoints(id,name,task,x,y,location,assigned_to) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,clean(body.name,80),clean(body.task,160),x,y,clean(body.location,80),body.assignedTo==null?null:officerName(body.assignedTo)])
  return {id}
 }
 if(path==='/checkpoints/assign'){
  const id=clean(body.id,20)
  const assignedTo=body.assignedTo===null?null:officerName(body.assignedTo)
  if(!(await db.query('UPDATE roger.checkpoints SET assigned_to=$2 WHERE id=$1 AND NOT archived',[id,assignedTo])).rowCount) throw new HttpError(404,'Checkpoint não encontrado.')
  return {id,assignedTo}
 }
 if(path==='/checkpoints/delete'){
  const id=clean(body.id,20)
  if(!(await db.query('UPDATE roger.checkpoints SET archived=true WHERE id=$1 AND NOT archived',[id])).rowCount) throw new HttpError(404,'Checkpoint não encontrado.')
  return {id}
 }
 if(path==='/checkpoint-tasks/delete'){
  const id=uuid(body.id)
  await transaction(async connection=>{
   const task=(await connection.query('SELECT id FROM roger.checkpoint_tasks WHERE id=$1 AND archived_at IS NULL FOR UPDATE',[id])).rows[0]
   if(!task) throw new HttpError(404,'Tarefa não encontrada.')
   await connection.query('UPDATE roger.checkpoint_tasks SET archived_at=now() WHERE (id=$1 OR parent_id=$1) AND archived_at IS NULL',[id])
  })
  return {id}
 }
 if(path==='/checkpoint-tasks'){
  const id=randomUUID()
  const point=clean(body.checkpointId,20)
  const parent=body.parentId==null?null:uuid(body.parentId)
  const result=await db.query(`
   INSERT INTO roger.checkpoint_tasks(id,checkpoint_id,parent_id,title)
   SELECT $1,p.id,$3,$4 FROM roger.checkpoints p WHERE p.id=$2 AND NOT p.archived
   AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM roger.checkpoint_tasks WHERE id=$3 AND checkpoint_id=p.id AND parent_id IS NULL AND archived_at IS NULL FOR SHARE))
  `,[id,point,parent,clean(body.title,160)])
  if(!result.rowCount) throw new HttpError(404,'Checkpoint ou tarefa principal indisponível.')
  return {id}
 }
 if(path==='/checkpoint-tasks/status'){
  const id=uuid(body.id)
  if(typeof body.done!=='boolean') throw new HttpError(400,'Status inválido.')
  if(!(await db.query('UPDATE roger.checkpoint_tasks SET done=$2 WHERE id=$1 AND archived_at IS NULL AND EXISTS(SELECT 1 FROM roger.checkpoints WHERE id=checkpoint_id AND NOT archived)',[id,Number(body.done)])).rowCount) throw new HttpError(404,'Tarefa não encontrada.')
  return {id}
 }
 throw new HttpError(404,'Rota inexistente.')
}
