// Adapted from Supertone's MIT-licensed web/helper.js inference recipe.
// Copyright (c) 2025 Supertone Inc. See /licenses/supertonic-sdk-MIT.txt.
// The model weights have the separate OpenRAIL-M licence.
import { SUPERTONIC_LANGUAGES, SUPERTONIC_STYLES, SUPERTONIC_LEGACY_STYLES } from './supertonic-catalog.js';
import { speedUpSpeech } from './synth-flow.js';
import { getText, layout, putText, withArena } from './core-call.js';
import { loadedRustVoiceCore } from '../rust-voice-core.js';
import {supertonicRuntimeConfig,supertonicTextIds,supertonicLocalMarks,supertonicNoise,createSupertonicPcmJoin,supertonicStyleValid,createSupertonicState} from './supertonic-plan.js';

const cancelled = () => Object.assign(new Error('Lectura cancelada'),{name:'AbortError',code:'aborted'});
import { yieldToMessages as yieldTask } from './task-yield.js';
// Six steps preserved the tested Dutch/Spanish/English intelligibility at
// <1 RTF in the recorded single-thread desktop WASM benchmark, unlike FP32/8.
export const SUPERTONIC_STEPS = 6;

/**
 * Never squeeze the model's latent below its normal predicted duration.
 * Faster playback is applied to complete speech, with pitch-preserving tempo
 * processing, after inference. A percentage margin still lost words at 2x.
 */
export function supertonicSeconds(predicted,rate) {
  return loadedRustVoiceCore().supertonic_seconds(+predicted,Number(rate));
}
/** `<es>text.</es>` for the model, or '' when nothing speakable is left. The cleanup is Rust (rust-core supertonic_text.rs, the voice
 * core); the compatibility decomposition of Unicode is the browser's. */
export function normalizeSupertonicText(text,lang) {
  if(!SUPERTONIC_LANGUAGES.includes(lang))throw new Error(`Idioma Supertonic no disponible: ${lang}`);
  const value=String(text||'').normalize('NFKD'),core=loadedRustVoiceCore(),capacity=value.length*8+64;
  const {at,cells}=layout(value.length*2,lang.length*2,capacity*2);
  return withArena(core,cells,pointer=>{
    putText(core,pointer+at[0],value);putText(core,pointer+at[1],lang);
    const written=core.supertonic_normalize(pointer+at[0],value.length,pointer+at[1],lang.length,pointer+at[2],capacity);
    if(written<0)throw new Error('Texto de voz inválido');
    return getText(core,pointer+at[2],written);
  });
}

/** Small chunks bound latent/audio memory. Upstream recommends <=300 chars
 * (120 for Korean/Japanese); the reader usually already supplies one sentence. */
export function supertonicTextChunks(text,lang) {
  const value=String(text||''),core=loadedRustVoiceCore(),capacity=(value.length>>5)+4;
  const {at,cells}=layout(value.length*2,capacity*8);
  return withArena(core,cells,pointer=>{
    putText(core,pointer+at[0],value);
    const found=core.supertonic_chunks(pointer+at[0],value.length,['ko','ja'].includes(lang)?120:300,pointer+at[1],capacity);
    if(found<0)throw new Error('Texto de voz inválido');
    const ranges=new Uint32Array(core.memory.buffer,pointer+at[1],found*2);
    return Array.from({length:found},(_,i)=>value.slice(ranges[i*2],ranges[i*2+1]));
  });
}

/** ONNX Runtime is injected by the existing synthesis worker. Four sessions,
 * one active utterance; no engine/download/UI dependency enters this module. */
export async function createSupertonicRuntime({ort,buffers,config,indexer,styles,steps=SUPERTONIC_STEPS,random=Math.random,yieldToMessages=yieldTask}={}) {
  if(!ort?.InferenceSession||!ort.Tensor||!Array.isArray(indexer))throw new Error('Configuración Supertonic inválida');
  const {sampleRate,chunkSize,latentDim}=supertonicRuntimeConfig(config,steps);
  const sessions={},styleTensors={};let running=null;
  const releaseTensor=t=>{try{t?.dispose?.();}catch{}};
  const releaseAll=async()=>{for(const style of Object.values(styleTensors)){releaseTensor(style.ttl);releaseTensor(style.dp);}for(const session of Object.values(sessions))await session.release?.();};
  try {
    for(const name of ['duration_predictor','text_encoder','vector_estimator','vocoder']) {
      if(!buffers?.[name]?.byteLength)throw new Error(`Falta el modelo ${name}`);
      sessions[name]=await ort.InferenceSession.create(buffers[name],{executionProviders:['wasm'],graphOptimizationLevel:'all',enableCpuMemArena:false,enableMemPattern:false});
    }
    buffers=null;
    for(const name of SUPERTONIC_LEGACY_STYLES)if(!styles?.[name])throw new Error(`Falta el estilo ${name}`);
    for(const name of SUPERTONIC_STYLES.filter(name=>styles?.[name])) {
      const raw=styles[name];
      const tensors={};styleTensors[name]=tensors;
      for(const [key,field]of [['ttl','style_ttl'],['dp','style_dp']]) {
        const source=raw[field],dims=source?.dims,data=source?.data?.flat(Infinity);
        if(!supertonicStyleValid(dims,data))throw new Error(`Estilo ${name} inválido`);
        tensors[key]=new ort.Tensor('float32',new Float32Array(data),dims);
      }
    }
  } catch(error){await releaseAll();throw error;}

  const state=createSupertonicState();
  async function infer(text,{lang,style,rate,isActive,marks = [],onMarks = () => {}}) {
    const live=new Set(),own=t=>{live.add(t);return t;},drop=t=>{if(live.delete(t))releaseTensor(t);};
    const check=()=>{if(!state.active()||!isActive())throw cancelled();};
    const checkpoint=async()=>{await yieldToMessages();check();};
    const run=async(name,feeds)=>{check();const output=await sessions[name].run(feeds);for(const t of Object.values(output))own(t);check();return output;};
    try {
      check();const normalized=normalizeSupertonicText(text,lang);if(!normalized)return new Float32Array();
      const ids=supertonicTextIds(normalized,indexer);
      const textIds=own(new ort.Tensor('int64',ids,[1,ids.length])),textMask=own(new ort.Tensor('float32',new Float32Array(ids.length).fill(1),[1,1,ids.length]));
      const selected=styleTensors[style],dp=await run('duration_predictor',{text_ids:textIds,style_dp:selected.dp,text_mask:textMask});
      const seconds=supertonicSeconds(Number(dp.duration?.data?.[0]),rate);drop(dp.duration);
      if(!loadedRustVoiceCore().supertonic_duration_ok(seconds))throw new Error('Duración de audio fuera de rango');
      await checkpoint();
      const encoded=await run('text_encoder',{text_ids:textIds,style_ttl:selected.ttl,text_mask:textMask});
      const frames=loadedRustVoiceCore().supertonic_audio_frames(seconds,sampleRate,chunkSize),shape=[1,latentDim,frames];
      const noise=supertonicNoise(latentDim*frames,random);
      let latent=own(new ort.Tensor('float32',noise,shape));
      const latentMask=own(new ort.Tensor('float32',new Float32Array(frames).fill(1),[1,1,frames]));
      const totalStep=own(new ort.Tensor('float32',Float32Array.of(steps),[1]));
      for(let step=0;step<steps;step++) {
        await checkpoint();const currentStep=own(new ort.Tensor('float32',Float32Array.of(step),[1]));
        const output=await run('vector_estimator',{noisy_latent:latent,text_emb:encoded.text_emb,style_ttl:selected.ttl,latent_mask:latentMask,text_mask:textMask,current_step:currentStep,total_step:totalStep});
        if(!output.denoised_latent)throw new Error('El modelo no generó audio');
        drop(latent);drop(currentStep);latent=output.denoised_latent;
      }
      await checkpoint();const output=await run('vocoder',{latent});
      if(!output.wav_tts?.data?.length)throw new Error('El modelo devolvió audio vacío');
      // Every generated frame: cutting at the predicted length clipped the last
      // syllables, and the quiet tail is trimmed later anyway.
      const pcm=new Float32Array(output.wav_tts.data.slice(0,frames*chunkSize));
      if(pcm.some(value=>!Number.isFinite(value)))throw new Error('El modelo devolvió audio inválido');
      // This model exposes total durations, not token alignment. Estimate the
      // boundary from its own prefix/suffix duration predictor, without running
      // the acoustic decoder again or splitting the generated waveform.
      const predict = async value => {
        const normalized = normalizeSupertonicText(value,lang)
        if (!normalized) return 0
        const values=supertonicTextIds(normalized,indexer),ids=own(new ort.Tensor('int64',values,[1,values.length]))
        const mask = own(new ort.Tensor('float32',new Float32Array(values.length).fill(1),[1,1,values.length]))
        const result = await run('duration_predictor',{text_ids:ids,style_dp:selected.dp,text_mask:mask})
        const duration = Number(result.duration?.data?.[0])
        drop(ids); drop(mask); drop(result.duration)
        return Number.isFinite(duration) && duration > 0 ? duration : 0
      }
      const timeline = []
      for (const offset of marks) {
        const before = await predict(text.slice(0,offset)), after = await predict(text.slice(offset))
        if (before + after > 0) timeline.push({offset,sample:loadedRustVoiceCore().supertonic_mark_sample(pcm.length,before,after),estimated:true})
      }
      onMarks(timeline)
      return pcm;
    } finally{for(const tensor of live)releaseTensor(tensor);}
  }
  return {
    sampleRate,
    synthesize(text,{lang,style='F1',rate=1,isActive=()=>true,marks=[]}={}) {
      const token=state.begin(SUPERTONIC_LANGUAGES.includes(lang)&&!!styleTensors[style],rate);
      if(token<0)return Promise.reject(token===-1?cancelled():new Error(token===-2?'Síntesis ya en curso':'Opciones de voz inválidas'));
      const job=(async()=>{const chunks=supertonicTextChunks(text,lang),parts=[],timeline=[];let searchFrom=0;
        if(chunks.length>32)throw new Error('Texto de voz demasiado largo');
        const join=createSupertonicPcmJoin(sampleRate);
        try {
          for(const chunk of chunks){
            const start=text.indexOf(chunk,searchFrom);searchFrom=start+chunk.length;
            const local=supertonicLocalMarks(marks,start,searchFrom);
            let chunkMarks=[];
            const pcm=await infer(chunk,{lang,style,rate,isActive,marks:local,onMarks:values=>{chunkMarks=values}});
            const offset=join.append(pcm.length);if(offset<0)continue;
            if(marks.includes(start))timeline.push({offset:start,sample:offset});
            timeline.push(...chunkMarks.map(mark=>({...mark,offset:mark.offset+start,sample:mark.sample+offset})));
            parts.push({pcm,offset});
          }
          if(!state.active()||!isActive())throw cancelled();
          // Typed arrays are host audio buffers; their initial zeroes also
          // supply Rust-planned inter-chunk gaps without allocating gap arrays.
          const pcm=new Float32Array(join.length);for(const part of parts)pcm.set(part.pcm,part.offset);
          return {...speedUpSpeech(pcm,sampleRate,rate,timeline),sampleRate};
        } finally {join.dispose();}
      })();running=job;job.finally(()=>{state.finish(token);if(running===job)running=null;}).catch(()=>{});return job;
    },
    async dispose(){if(!state.close())return;try{await running?.catch(()=>{});await releaseAll();}finally{state.dispose();}}
  };
}
