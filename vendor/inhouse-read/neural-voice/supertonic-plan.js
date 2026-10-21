// Host tensor/buffer bindings for the native Supertonic numeric plans. The
// worker already loaded the tiny voice module; nothing imports reader UI.
import {loadedRustVoiceCore} from '../rust-voice-core.js';
import {layout,putText,withArena} from './core-call.js';
export function supertonicRuntimeConfig(config,steps){
 const core=loadedRustVoiceCore();
 return withArena(core,4,pointer=>{
  const status=core.supertonic_runtime_config(Number(config?.ae?.sample_rate),Number(config?.ae?.base_chunk_size),Number(config?.ttl?.chunk_compress_factor),Number(config?.ttl?.latent_dim),Number(config?.ttl?.chunk_compress_factor),typeof steps==='number'?steps:NaN,pointer);
  if(status)throw Error(status===2?'Pasos Supertonic inválidos':'Dimensiones Supertonic inválidas');
  const [sampleRate,chunkSize,latentDim]=new Float64Array(core.memory.buffer,pointer,4);return{sampleRate,chunkSize,latentDim};
 });
}
export function supertonicTextIds(text,indexer){
 const core=loadedRustVoiceCore(),{at,cells}=layout(text.length*2,text.length*4);
 return withArena(core,cells,pointer=>{
  putText(core,pointer,text);const count=core.supertonic_text_points(pointer,text.length,pointer+at[1]);
  // The model index is a large host-owned JSON table. BigInt conversion and
  // typed tensor allocation stay here without duplicating that table in WASM.
  return BigInt64Array.from(new Uint32Array(core.memory.buffer,pointer+at[1],count).slice(),point=>BigInt(indexer[point]??-1));
 });
}
export function supertonicLocalMarks(marks,start,end){
 const core=loadedRustVoiceCore(),{at,cells}=layout(marks.length*8,marks.length*8);
 return withArena(core,cells,pointer=>{
  const values=new Float64Array(core.memory.buffer,pointer,marks.length);
  for(let i=0;i<marks.length;i++)values[i]=typeof marks[i]==='number'?marks[i]:NaN;
  const count=core.supertonic_local_marks(pointer,marks.length,start,end,pointer+at[1]);
  return Array.from(new Float64Array(core.memory.buffer,pointer+at[1],count));
 });
}
export function supertonicNoise(length,random){
 const core=loadedRustVoiceCore(),block=256,output=new Float32Array(length),{at,cells}=layout(block*2*8,block*4);
 return withArena(core,cells,pointer=>{
  for(let start=0;start<length;start+=block){
   const n=Math.min(block,length-start);
   // RNG is injectable browser state; preserve its two draws per sample.
   let inputs=new Float64Array(core.memory.buffer,pointer,n*2);
   for(let i=0;i<n*2;i++){
    const value=+random();
    if(inputs.byteLength===0)inputs=new Float64Array(core.memory.buffer,pointer,n*2);
    inputs[i]=value;
   }
   if(core.supertonic_noise_plan(pointer,n)!==1)throw Error('Plan de ruido inválido');
   const values=new Float64Array(core.memory.buffer,pointer,n*2);
   for(let i=0;i<n;i++){values[i*2]=Math.log(values[i*2]);values[i*2+1]=Math.cos(values[i*2+1]);}
   if(core.supertonic_noise_finish(pointer,n,pointer+at[1])!==1)throw Error('Ruido de voz inválido');
   output.set(new Float32Array(core.memory.buffer,pointer+at[1],n),start);
  }return output;
 });
}
export function createSupertonicPcmJoin(sampleRate){
 const core=loadedRustVoiceCore();let handle=core.supertonic_join_new(sampleRate);if(!handle)throw Error('Duración de audio fuera de rango');
 return{
  append(length){const start=core.supertonic_join_append(handle,length);if(start===-2)throw Error('Audio demasiado largo');return start;},
  get length(){return core.supertonic_join_length(handle);},
  dispose(){if(handle){core.supertonic_join_free(handle);handle=0;}}
 };
}
export function supertonicStyleValid(dims,data){
 if(!Array.isArray(dims)||!Array.isArray(data))return false;
 const core=loadedRustVoiceCore(),{at,cells}=layout(dims.length*8,data.length*8);
 return withArena(core,cells,pointer=>{
  const shape=new Float64Array(core.memory.buffer,pointer,dims.length),values=new Float64Array(core.memory.buffer,pointer+at[1],data.length);
  for(let i=0;i<dims.length;i++)shape[i]=typeof dims[i]==='number'?dims[i]:NaN;
  for(let i=0;i<data.length;i++)values[i]=typeof data[i]==='number'?data[i]:NaN;
  return !!core.supertonic_style_valid(pointer,dims.length,pointer+at[1],data.length);
 });
}
export function createSupertonicState(){
 const core=loadedRustVoiceCore();let handle=core.supertonic_state_new();
 if(!handle)throw Error('No se pudo crear la voz');
 return{
  begin(valid,rate){return core.supertonic_state_begin(handle,valid?1:0,typeof rate==='number'?rate:NaN);},
  finish(token){if(handle)core.supertonic_state_finish(handle,token);},
  active(){return !!core.supertonic_state_active(handle);},
  close(){return !!core.supertonic_state_close(handle);},
  dispose(){if(handle){core.supertonic_state_free(handle);handle=0;}}
 };
}
