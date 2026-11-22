import pg from 'pg'
export const db=new pg.Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000})
export async function transaction(work){
 const connection=await db.connect()
 try{
  await connection.query('BEGIN')
  const result=await work(connection)
  await connection.query('COMMIT')
  return result
 }catch(error){
  await connection.query('ROLLBACK')
  throw error
 }finally{connection.release()}
}
