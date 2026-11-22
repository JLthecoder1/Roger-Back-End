import {connect} from 'mqtt'

let broker
const topic=process.env.ROGER_MQTT_RISK_TOPIC||'roger/v1/risk/buzzer'

export function startRiskBuzzer(){
 const url=process.env.ROGER_MQTT_URL
 if(!url)return
 try{
  if(new URL(url).protocol!=='mqtts:') throw new Error('Use mqtts://')
  broker=connect(url,{
   username:process.env.ROGER_MQTT_USERNAME,
   password:process.env.ROGER_MQTT_PASSWORD,
   connectTimeout:5000,
   reconnectPeriod:3000
  })
  broker.on('connect',()=>console.info('[risco] MQTT conectado.'))
  broker.on('error',error=>console.warn('[risco] Falha MQTT:',error.code??error.name))
 }catch{
  console.warn('[risco] Verifique ROGER_MQTT_URL. O painel continua recebendo alertas.')
 }
}

export function signalRiskBuzzer(id){
 if(!process.env.ROGER_MQTT_URL)return
 if(!broker?.connected){
  console.warn('[risco] Bipe não enviado: MQTT desconectado.')
  return
 }
 broker.publish(topic,id,{qos:1,retain:false},error=>{
  if(error)console.warn('[risco] Falha ao publicar bipe:',error.code??error.name)
  else console.info('[risco] Comando de bipe aceito pelo broker.')
 })
}
