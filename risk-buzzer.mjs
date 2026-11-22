import {connect} from 'mqtt'

let serial
let serialReady=false
let broker

async function startSerial(path){
 try{
  const {SerialPort,ReadlineParser}=await import('serialport')
  const port=new SerialPort({path,baudRate:115200,autoOpen:false})
  serial=port
  const lines=port.pipe(new ReadlineParser({delimiter:'\n'}))
  lines.on('data',line=>{
   const text=line.trim()
   if(text==='ROGER_READY'){
    serialReady=true
    console.info('[risco] ESP32 USB pronto:',path)
   }else if(/^ROGER_BEEP [0-9a-f-]{36}$/i.test(text)){
    console.info('[risco] ESP32 iniciou o bipe:',text.slice(11))
   }
  })
  let pingTimer
  port.on('error',error=>console.warn('[risco] Falha serial:',error.message))
  port.on('close',()=>{clearInterval(pingTimer);serialReady=false})
  port.open(error=>{
   if(error){console.warn('[risco] Não foi possível abrir',path,error.message);return}
   pingTimer=setInterval(()=>{
    if(serialReady){clearInterval(pingTimer);return}
    port.write('ROGER_PING\n',error=>{if(error)console.warn('[risco] Falha ao consultar o ESP32:',error.message)})
   },1000)
   pingTimer.unref()
  })
 }catch(error){
  console.warn('[risco] ESP32 USB indisponível:',error.code??error.message)
 }
}

const topic=process.env.ROGER_MQTT_RISK_TOPIC||'roger/v1/risk/buzzer'

export function startRiskBuzzer(){
 const serialPath=(process.env.RAILWAY_ENVIRONMENT_ID?'':process.env.ROGER_SERIAL_PORT?.trim())
 if(serialPath){void startSerial(serialPath);return}
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
 if((process.env.RAILWAY_ENVIRONMENT_ID?'':process.env.ROGER_SERIAL_PORT?.trim())){
  if(!serial?.isOpen||!serialReady){
   console.warn('[risco] Bipe não enviado: ESP32 USB indisponível.')
   return
  }
  serial.write('ROGER_BEEP '+id+'\n',error=>{
   if(error)console.warn('[risco] Falha ao enviar bipe por USB:',error.message)
  })
  return
 }
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
