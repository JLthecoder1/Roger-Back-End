import {readFile} from 'node:fs/promises'
import {db,transaction} from './db.mjs'
if(!process.env.DATABASE_URL) throw new Error('Configure DATABASE_URL')
try {
 const files=['001_roger.sql','002_rotinas.sql','003_protocolo_risco.sql','004_round_photos.sql']
 const scripts=await Promise.all(files.map(file=>readFile(new URL('./sql/'+file,import.meta.url),'utf8')))
 await transaction(async connection=>{
  for(const sql of scripts) await connection.query(sql)
 })
 console.log('Schema ROGER pronto.')
}finally{await db.end()}
