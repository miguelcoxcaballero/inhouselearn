// Supertone Supertonic 3. Model: OpenRAIL-M; SDK inference recipe: MIT.
// Immutable upstream revision, individual file sizes and SHA-256 digests.
export const SUPERTONIC_MODEL_ID = 'supertonic3';
export const SUPERTONIC_REVISION = '3cadd1ee6394adea1bd021217a0e650ede09a323';
export const SUPERTONIC_BASE = 'https://huggingface.co/Supertone/supertonic-3/resolve/' + SUPERTONIC_REVISION + '/';
// Only the vector estimator is quantized. Duration, text encoder and vocoder
// remain the original FP32 graphs. This derivative retains OpenRAIL-M.
export const SUPERTONIC_QUANT_REVISION = '95618f5d61cef4923c3b802a332fd603723718f7';
export const SUPERTONIC_VECTOR_URL = 'https://huggingface.co/askurios8/supertonic-3-int8/resolve/' + SUPERTONIC_QUANT_REVISION + '/variants/mixed-fast/onnx/vector_estimator.onnx';
const trustedOverride = value => {
  try { const url=new URL(value);return url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)) ? url.href.replace(/\/?$/,'/') : ''; }
  catch { return ''; }
};
// Capture before any imported book can alter the page's global configuration.
const overrideAtLoad=trustedOverride(globalThis.INHOUSE_SUPERTONIC_BASE);
export const supertonicBase = () => overrideAtLoad || SUPERTONIC_BASE;
// The local fixture mirror keeps logical paths; production assets may come
// from different immutable upstream revisions (for example a quantized graph).
export const supertonicAssetUrl = (asset,base=supertonicBase()) => base!==SUPERTONIC_BASE ? base+asset.path : (asset.url||base+asset.path);
export const SUPERTONIC_ASSETS = Object.freeze([
  {
    "path": "onnx/duration_predictor.onnx",
    "bytes": 3700147,
    "sha256": "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db"
  },
  {
    "path": "onnx/text_encoder.onnx",
    "bytes": 36416150,
    "sha256": "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff"
  },
  {
    "path": "onnx/vector_estimator.onnx",
    "url": SUPERTONIC_VECTOR_URL,
    "bytes": 65447164,
    "sha256": "073575704bf0b6ca0714eb6509029f324b794d5bd6dbdb27dccbbc5939abc167"
  },
  {
    "path": "onnx/vocoder.onnx",
    "bytes": 101424195,
    "sha256": "085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba"
  },
  {
    "path": "onnx/tts.json",
    "bytes": 8253,
    "sha256": "42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09"
  },
  {
    "path": "onnx/unicode_indexer.json",
    "bytes": 277676,
    "sha256": "9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f"
  },
  {
    "path": "voice_styles/F1.json",
    "bytes": 292046,
    "sha256": "bbdec6ee00231c2c742ad05483df5334cab3b52fda3ba38e6a07059c4563dbc2"
  },
  {
    "path": "voice_styles/M1.json",
    "bytes": 291748,
    "sha256": "e35604687f5d23694b8e91593a93eec0e4eca6c0b02bb8ed69139ab2ea6b0a5b"
  },
  {
    "path": "voice_styles/F2.json",
    "bytes": 292423,
    "sha256": "7c722c6a72707b1a77f035d67f0d1351ba187738e06f7683e8c72b1df3477fc6"
  },
  {
    "path": "LICENSE",
    "bytes": 15007,
    "sha256": "0d944a9110fed9a9602d60e0423a272903e7bd21ab060490774efc77c2275e9f"
  },
  {
    "path": "voice_styles/F3.json",
    "bytes": 290794,
    "sha256": "12f6ef2573baa2defa1128069cb59f203e3ab67c92af77b42df8a0e3a2f7c6ab"
  },
  {
    "path": "voice_styles/F4.json",
    "bytes": 291808,
    "sha256": "c2fa764c1225a76dfc3e2c73e8aa4f70d9ee48793860eb34c295fff01c2e032b"
  },
  {
    "path": "voice_styles/F5.json",
    "bytes": 291479,
    "sha256": "45966e73316415626cf41a7d1c6f3b4c70dbc1ba2bee5c1978ef0ce33244fc8d"
  },
  {
    "path": "voice_styles/M2.json",
    "bytes": 292055,
    "sha256": "b76cbf62bac707c710cf0ae5aba5e31eea1a6339a9734bfae33ab98499534a50"
  },
  {
    "path": "voice_styles/M3.json",
    "bytes": 290198,
    "sha256": "ea1ac35ccb91b0d7ecad533a2fbd0eec10c91513d8951e3b25fbba99954e159b"
  },
  {
    "path": "voice_styles/M4.json",
    "bytes": 291522,
    "sha256": "ca8eefad4fcd989c9379032ff3e50738adc547eeb5e221b82593a6d7b3bac303"
  },
  {
    "path": "voice_styles/M5.json",
    "bytes": 291469,
    "sha256": "dd22b92740314321f8ae11c5e87f8dd60d060f15dd3a632b5adf77f471f77af2"
  }
].map(asset=>Object.freeze({...asset,url:asset.url||SUPERTONIC_BASE+asset.path})));
export const SUPERTONIC_BYTES = SUPERTONIC_ASSETS.reduce((sum, asset) => sum + asset.bytes, 0);
export const SUPERTONIC_LANGUAGES = Object.freeze(["en","ko","ja","ar","bg","cs","da","de","el","es","et","fi","fr","hi","hr","hu","id","it","lt","lv","nl","pl","pt","ro","ru","sk","sl","sv","tr","uk","vi"]);
export const SUPERTONIC_LEGACY_STYLES = Object.freeze(['F1', 'M1', 'F2']);
export const SUPERTONIC_STYLES = Object.freeze([...SUPERTONIC_LEGACY_STYLES, 'F3', 'F4', 'F5', 'M2', 'M3', 'M4', 'M5']);
// Exact previous manifest; only this complete, verified pack can migrate offline.
export const SUPERTONIC_LEGACY_ASSETS = Object.freeze(SUPERTONIC_ASSETS.filter(asset => !asset.path.startsWith('voice_styles/') || SUPERTONIC_LEGACY_STYLES.includes(asset.path.split('/').at(-1).replace('.json', ''))));
export const SUPERTONIC_LICENSE = Object.freeze({name:'OpenRAIL-M',url:SUPERTONIC_BASE+'LICENSE',attribution:'Copyright (c) 2026 Supertone Inc.'});
export const isSupertonicVoiceId = id => typeof id === 'string' && /^supertonic3:([FM][1-5]):[a-z]{2}$/.test(id);
// Each Supertonic profile (F1-F5 women, M1-M5 men) is shown with a name of its
// language and the standard accent of that language; the voice id and the
// language code given to the model stay as they were.
export const SUPERTONIC_VOICE_NAMES = Object.freeze({
  en:Object.freeze({ dialect:'en-US', F:['Emma','Olivia','Grace','Hannah','Lucy'], M:['James','Daniel','Henry','Samuel','Thomas'] }),
  ko:Object.freeze({ dialect:'ko-KR', F:['Ji-woo','Seo-yeon','Min-ji','Ha-eun','Soo-ah'], M:['Min-jun','Seo-jun','Do-hyun','Ji-ho','Hyun-woo'] }),
  ja:Object.freeze({ dialect:'ja-JP', F:['Yui','Haruka','Sakura','Aoi','Mei'], M:['Haruto','Sota','Ren','Yuto','Kaito'] }),
  ar:Object.freeze({ dialect:'ar-SA', F:['Layla','Mariam','Noor','Salma','Huda'], M:['Omar','Karim','Youssef','Tariq','Samir'] }),
  bg:Object.freeze({ dialect:'bg-BG', F:['Maria','Elena','Desislava','Ivana','Radka'], M:['Georgi','Ivan','Dimitar','Nikolay','Stoyan'] }),
  cs:Object.freeze({ dialect:'cs-CZ', F:['Tereza','Eliška','Klára','Jana','Lucie'], M:['Jakub','Tomáš','Ondřej','Petr','Martin'] }),
  da:Object.freeze({ dialect:'da-DK', F:['Freja','Ida','Clara','Karen','Sofie'], M:['Mads','Frederik','Lars','Emil','Rasmus'] }),
  de:Object.freeze({ dialect:'de-DE', F:['Anna','Lena','Marie','Sophie','Greta'], M:['Lukas','Jonas','Felix','Paul','Matthias'] }),
  el:Object.freeze({ dialect:'el-GR', F:['Eleni','Maria','Sofia','Katerina','Anna'], M:['Giorgos','Nikos','Dimitris','Kostas','Yannis'] }),
  es:Object.freeze({ dialect:'es-ES', F:['Lucía','Carmen','Elena','Sofía','Paula'], M:['Javier','Pablo','Diego','Andrés','Mateo'] }),
  et:Object.freeze({ dialect:'et-EE', F:['Liis','Kadri','Maarja','Triin','Kristiina'], M:['Martin','Rasmus','Andres','Siim','Karl'] }),
  fi:Object.freeze({ dialect:'fi-FI', F:['Aino','Helmi','Elina','Saara','Kaisa'], M:['Eino','Mikko','Juhani','Ville','Antti'] }),
  fr:Object.freeze({ dialect:'fr-FR', F:['Camille','Léa','Chloé','Manon','Juliette'], M:['Louis','Hugo','Julien','Antoine','Mathieu'] }),
  hi:Object.freeze({ dialect:'hi-IN', F:['Ananya','Priya','Kavya','Meera','Diya'], M:['Arjun','Rohan','Vikram','Aarav','Kabir'] }),
  hr:Object.freeze({ dialect:'hr-HR', F:['Ana','Petra','Ivana','Lucija','Maja'], M:['Luka','Ivan','Marko','Petar','Josip'] }),
  hu:Object.freeze({ dialect:'hu-HU', F:['Anna','Eszter','Zsófia','Réka','Katalin'], M:['Bence','Máté','Levente','Gábor','Dániel'] }),
  id:Object.freeze({ dialect:'id-ID', F:['Putri','Ayu','Dewi','Sari','Nadia'], M:['Budi','Rizky','Adi','Bayu','Dimas'] }),
  it:Object.freeze({ dialect:'it-IT', F:['Giulia','Chiara','Francesca','Sara','Elena'], M:['Marco','Luca','Matteo','Giovanni','Andrea'] }),
  lt:Object.freeze({ dialect:'lt-LT', F:['Ieva','Gabija','Austėja','Rūta','Eglė'], M:['Lukas','Jonas','Matas','Tomas','Mantas'] }),
  lv:Object.freeze({ dialect:'lv-LV', F:['Anna','Laura','Elīza','Marta','Kristīne'], M:['Jānis','Mārtiņš','Roberts','Kārlis','Edgars'] }),
  nl:Object.freeze({ dialect:'nl-NL', F:['Emma','Sanne','Lotte','Fleur','Anouk'], M:['Daan','Sem','Lucas','Bram','Thijs'] }),
  pl:Object.freeze({ dialect:'pl-PL', F:['Zofia','Julia','Maja','Hanna','Natalia'], M:['Jakub','Antoni','Szymon','Mateusz','Piotr'] }),
  pt:Object.freeze({ dialect:'pt-BR', F:['Ana','Beatriz','Mariana','Júlia','Larissa'], M:['João','Pedro','Gabriel','Rafael','Thiago'] }),
  ro:Object.freeze({ dialect:'ro-RO', F:['Maria','Ioana','Elena','Andreea','Ana'], M:['Andrei','Alexandru','Mihai','Ștefan','Radu'] }),
  ru:Object.freeze({ dialect:'ru-RU', F:['Anna','Olga','Natalia','Yelena','Irina'], M:['Alexei','Dmitri','Ivan','Sergei','Mikhail'] }),
  sk:Object.freeze({ dialect:'sk-SK', F:['Zuzana','Lucia','Katarína','Petra','Mária'], M:['Peter','Martin','Tomáš','Jakub','Lukáš'] }),
  sl:Object.freeze({ dialect:'sl-SI', F:['Nika','Eva','Maja','Ana','Lara'], M:['Luka','Jan','Žiga','Matej','Nejc'] }),
  sv:Object.freeze({ dialect:'sv-SE', F:['Elsa','Maja','Ebba','Astrid','Linnea'], M:['Erik','Oskar','Lars','Axel','Gustav'] }),
  tr:Object.freeze({ dialect:'tr-TR', F:['Elif','Zeynep','Ayşe','Defne','Ece'], M:['Mehmet','Emre','Can','Burak','Mert'] }),
  uk:Object.freeze({ dialect:'uk-UA', F:['Oksana','Olena','Iryna','Sofiia','Kateryna'], M:['Taras','Andrii','Dmytro','Oleksandr','Bohdan'] }),
  vi:Object.freeze({ dialect:'vi-VN', F:['Linh','Mai','Lan','Hoa','Thảo'], M:['Minh','Anh','Huy','Tuấn','Nam'] }),
});
/** 'Lucía' for es F1, 'Javier' for es M1; the profile itself when unknown. */
export function supertonicVoiceName(lang, style) {
  const names = SUPERTONIC_VOICE_NAMES[lang], index = Number(String(style).slice(1)) - 1;
  return names?.[String(style)[0]]?.[index] || `Supertonic ${style}`;
}
export function supertonicVoicesFor(languages) {
  const unique=[...new Set(languages.map(lang => String(lang).split(/[-_]/)[0]))].filter(lang => SUPERTONIC_LANGUAGES.includes(lang));
  const upgradeBytes=SUPERTONIC_BYTES-SUPERTONIC_LEGACY_ASSETS.reduce((sum,a)=>sum+a.bytes,0);
  return unique.flatMap(lang => SUPERTONIC_STYLES.map(style => ({id:`supertonic3:${style}:${lang}`, modelId:SUPERTONIC_MODEL_ID, modelKey:SUPERTONIC_MODEL_ID, piperId:SUPERTONIC_MODEL_ID, runtime:'supertonic3', provider:'supertonic',lang,dialect:SUPERTONIC_VOICE_NAMES[lang]?.dialect,style,name:supertonicVoiceName(lang,style),quality:'natural',sizeMB:Math.ceil(SUPERTONIC_BYTES/1e6),downloadBytes:SUPERTONIC_BYTES,upgradeBytes,licenseUrl:'licenses/supertonic3-OpenRAIL-M.txt',sharedPack:true})));
}
