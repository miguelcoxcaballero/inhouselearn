const normalizeLang = tag => String(tag || '').replace(/_/g, '-');
const langBase = tag => normalizeLang(tag).split('-')[0].toLowerCase();
const langRegion=tag=>normalizeLang(tag).split('-')[1]||''
// --- Language detection: stop-word scoring per language, with a few script/diacritic hints. ---
// Words that several languages share ("la", "de", "en"...) are listed in each of them but count half, so they can never
// decide a language on their own; only markers of one language do. The book language also gets a head start below.
const WORDS = {
  es: 'el la los las de y en un una unos unas del al que para con por como pero más mas está esta este esto estos también sin sobre entre cuando muy ya todo todos toda nada algo hay fue era eran ser soy eres somos son su sus es se no lo le les me mi mis te tu nos os ni sí así aquí allí donde porque quien quién cual cuyo cuyos qué cómo dónde ha han he hemos había tiene tengo tenía voy va vamos van hacia hasta desde después antes mientras aunque pues bien otro otra otros vez mismo yo usted ustedes nosotros ella ellos ellas',
  en: 'the and of to in is that it was for with as his her he she they you this have not but are were been from at by on an i my your we what do does did know there their will would can just be has had them then him me our its who which when where how all been out about if or so no up one into than some could should said like over only more now',
  fr: 'le la les des une un est que qui dans pour pas sur avec il elle ils elles nous vous mais ou au aux du de ce cette ces sont été être je tu et en ne se sa son ses mon ma mes ton ta tes leur leurs où comme plus très tout tous faire fait avait était ont a ai suis es sommes êtes y lui moi toi',
  de: 'der die das und ist nicht ein eine mit den dem des auf für von zu sich auch es war ich er sie wir aber wie oder im in an um aus bei nach noch nur schon dann wenn dass da du ihr ihm ihn mir dir uns euch hat haben hatte sind waren wird wurde kann so was wer wo man mein dein sein',
  it: 'il lo la gli le che di non una un è sono per con come più ma anche questo questa nel nella della delle degli dei del al alla alle allo si io lui lei noi voi loro mi ti ci vi ha hanno ho abbiamo era erano fu essere molto tutto tutti quando dove perché cosa niente solo già ancora sempre mai',
  pt: 'o a os as que não uma um uns umas do da dos das em no na nos nas de para com por mais como mas foi são está estão também ele ela eles elas você vocês eu nós me te se lhe lhes meu minha seu sua seus suas era eram ser tem têm tinha muito já ainda quando onde porque quem cujo ao aos à às',
  nl: 'de het een en van in is dat op te niet met voor zijn er ook maar om aan door als bij naar uit dan wel hij zij ze wij we jij je ik u ons hun was waren heeft hebben had wordt werd kan zou nog nu toen hier daar alles meer veel zeer wat wie waarom hoe waar geen niets iets nooit altijd wanneer niemand wist wil weet zijn mijn jouw haar hem mij jou moeder kinderen',
  pl: 'i w nie na to się z że do jest jak ale po co tak przez dla od czy już tylko może być był była było są jestem bardzo jego jej ich nas was oni ona ono ten ta te tego wszystko gdy kiedy tu tam jeszcze też mnie ciebie jego który która które jako lub oraz',
  tr: 've bir bu da de için ile ama çok daha gibi var yok ben sen biz siz onlar ne neden nasıl değil olarak kadar sonra önce her şey çünkü ise ki mi mı mu mü bütün hiç şu o olan oldu olduğu ya veya kendi',
  sv: 'och att det är en som på de med för inte jag han hon vi ni av till den har var från om men när så kan ska vill också bara efter mycket sig sin sitt sina vara blev hade skulle här där vad vem varför eller utan under mot redan alltid aldrig ett något inget',
  da: 'og at det er en som på de med for ikke jeg han hun vi i af til den har var fra om men når så kan skal vil også bare efter meget sig sin sit sine være blev havde skulle her der hvad hvem hvorfor eller uden under mod allerede altid aldrig et noget ingen mig dig kun hvor nogen mor deres legede skoven kunne huske hvornår fremmede landsbyen børn børnene gik ved også kommet nu hvad',
  nb: 'og at det er en som på de med for ikke jeg han hun vi i av til den har var fra om men når så kan skal vil også bare etter mye seg sin sitt sine være ble hadde skulle her der hva hvem hvorfor eller uten under mot allerede alltid aldri et noe ingen meg deg kun hvor noen veldig vært moren barna lekte skogen husket landsbyen fremmede gikk også kommet nå hva barn',
  fi: 'ja on ei että se oli hän mutta kun niin kuin ovat olla mitä miksi miten kuka missä tämä tuo nämä nuo minä sinä me te he ne vain myös jo vielä hyvin sitten ennen jälkeen kanssa ole olen olet emme eivät kaikki jos koska tai mikä joka lapset menivät metsään siellä äiti äitinsä muukalainen kylässä kukaan ei muistanut milloin saapunut haluat tiedä',
  cs: 'a se je na že to s v z o do jak ale po co tak pro od už jen může být byl byla bylo jsou jsem velmi jeho její jejich my vy oni ona ten ta tohle všechno když kdy tady tam ještě také nebo který která které není není aby jako',
  hu: 'a az és hogy nem is egy de meg van volt ez azt mint csak már még vagy el ki be fel le rá én te ő mi ti ők nagyon után előtt miért hogyan mert ha amikor itt ott minden ezt akkor kell lehet nincs vagyok vagyunk sem senki mikor rá nincs kell lehet valaki valami minden akkor azonban között után előtt falu idegen',
  ro: 'și în de la cu pe că nu un o este sunt sau dar mai ce cum pentru din care să se mi ei ea noi voi eu tu el ele foarte după înainte dacă când aici acolo tot toate era fost fi are am avea o mea meu lui lor',
  vi: 'và của không là một những được có trong cho người này đã với các để tôi bạn anh chị em ông bà nó chúng ta họ rất cũng nhưng khi nếu vì sao ai đâu gì nào ở đến từ lại ra vào',
  ca: 'el la els les que i amb per una un uns unes és són però també això aquest aquesta aquests aquestes dels de del al als molt més no jo tu nosaltres vosaltres ell ella ells elles em et es ens us li hi en ha han hem heu he va vaig vam van era eren ser sóc ets som sou mateix perquè quan on qui què com tot tots tota totes res algú ningú meva meu meus meves seva seu seus seves nostre vostre sense després abans fins des mentre encara ja ara aquí allà'
}
// The later languages only count words none of the first seven has, so adding them never changes how those are told apart.
const CORE_LANGUAGES = ['es', 'en', 'fr', 'de', 'it', 'pt', 'ca']
// Built by the first detection rather than at import: the shelf loads this
// module at start-up, long before anybody listens to a book.
let wordTables = null
function languageWords() {
  if (wordTables) return wordTables
  const core = new Set(CORE_LANGUAGES.flatMap(lang => WORDS[lang].split(' ')))
  for (const lang of Object.keys(WORDS)) if (!CORE_LANGUAGES.includes(lang)) WORDS[lang] = WORDS[lang].split(' ').filter(word => !core.has(word)).join(' ')
  const sets = Object.fromEntries(Object.entries(WORDS).map(([lang, words]) => [lang, new Set(words.split(' '))]))
  const langs = new Map()
  for (const [lang, set] of Object.entries(sets)) for (const word of set) langs.set(word, [...(langs.get(word) || []), lang])
  return wordTables = { sets, langs }
}
// What the book language is worth up front, and how far another language must clearly be ahead to override it.
const FALLBACK_BONUS = 2
const HINTS = [
  ['es', /[ñ¿¡]/g, 3], ['de', /ß/g, 3], ['de', /[äöü]/g, 1], ['pt', /[ãõ]/g, 3], ['fr', /œ/g, 3], ['fr', /ç/g, 1], ['ca', /ç/g, 1], ['ca', /l·l|·/g, 3],
  ['pl', /ł/g, 3], ['pl', /[ąęńśźż]/g, 1.5], ['cs', /[ěřů]/g, 3], ['cs', /[čšž]/g, 0.5], ['hu', /[őű]/g, 3], ['tr', /[ığ]/g, 3], ['tr', /ş/g, 1], ['ro', /[ăș]/g, 3], ['ro', /[țşţ]/g, 1.5], ['ro', /î/g, 1],
  ['da', /[øæ]/g, 1], ['nb', /[øæ]/g, 1], ['sv', /[äö]/g, 0.5], ['fi', /[äö]/g, 0.5], ['fi', /ää|öö|yy|äy|öy|yö|äi|öi/g, 2],
  ['vi', /[ơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹđ]/g, 2],
  ['it', /[ìù]/g, 1.5], ['fr', /[èêâîôû]/g, 0.5], ['ca', /[àò]/g, 1]
]
const DEFAULT_REGION = { es:'ES', en:'US', fr:'FR', de:'DE', it:'IT', pt:'PT', ca:'ES', nl:'NL', pl:'PL', tr:'TR', sv:'SE', da:'DK', nb:'NO', fi:'FI', cs:'CZ', hu:'HU', ro:'RO', ru:'RU', uk:'UA', el:'GR', ar:'SA', zh:'CN', ja:'JP', ko:'KR', hi:'IN', he:'IL', th:'TH', vi:'VN', bg:'BG', sr:'RS' }
// Languages with a script of their own are told by their letters; the Latin-script ones by the lists above. Cyrillic is Russian
// unless it has letters only Ukrainian uses; Han with kana is Japanese.
const SCRIPTS = [['el', /\p{Script=Greek}/gu], ['ar', /\p{Script=Arabic}/gu], ['he', /\p{Script=Hebrew}/gu], ['hi', /\p{Script=Devanagari}/gu], ['th', /\p{Script=Thai}/gu], ['ko', /\p{Script=Hangul}/gu], ['ja', /[\p{Script=Hiragana}\p{Script=Katakana}]/gu], ['zh', /\p{Script=Han}/gu], ['ru', /\p{Script=Cyrillic}/gu]]
const UKRAINIAN = /[іїєґ]/g
function detectByScript(sample, fallback) {
  const letters = (sample.match(/\p{L}/gu) || []).length
  if (!letters) return ''
  const counts = Object.fromEntries(SCRIPTS.map(([lang, pattern]) => [lang, (sample.match(pattern) || []).length]))
  const [lang, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  if (count < 2 && !(count === 1 && letters === 1) || count < letters * 0.4) return ''
  if (lang === 'ja' || (lang === 'zh' && counts.ja)) return 'ja'
  if (lang === 'ru' && (sample.match(UKRAINIAN) || []).length > (sample.match(/[ыэёъ]/g) || []).length) return 'uk'
  if (lang === 'ru') {
    if (/[ђјљњћџ]/u.test(sample)) return 'sr'
    // Cyrillic alone cannot tell Bulgarian from Russian; retain the book's declared language.
    const home = langBase(fallback)
    if (['bg', 'sr', 'uk'].includes(home) && !/[ыэё]/u.test(sample)) return home
    const bulgarian = new Set(['беше', 'когато', 'някой', 'никой', 'съм', 'също', 'която', 'който', 'това', 'дъждът'])
    if ((sample.match(/\p{L}+/gu) || []).filter(word => bulgarian.has(word)).length >= 2) return 'bg'
  }
  return lang
}
// \b does not treat accented letters as word characters, hence the explicit letter look-arounds.
const BRAZILIAN = /(?<!\p{L})(?:você|vocês|ônibus|celular|geladeira|café da manhã|a gente)(?!\p{L})/iu

/**
 * Best-guess BCP-47 tag for a short text. Short or ambiguous text falls back to `fallback` (the book language),
 * and a detected language keeps the fallback's region when they agree (book 'pt-BR' + Portuguese text -> pt-BR).
 */
export function detectLanguage(text, fallback = 'en-US') {
  const sample = String(text || '').toLocaleLowerCase()
  const byScript = detectByScript(sample, fallback)
  if (byScript) return langBase(fallback) === byScript && langRegion(fallback) ? normalizeLang(fallback) : `${byScript}-${DEFAULT_REGION[byScript]}`
  const scores = {}, { sets:WORD_SETS, langs:WORD_LANGS } = languageWords()
  for (const word of sample.match(/[\p{L}·']+/gu) || []) {
    const langs = WORD_LANGS.get(word)
    if (langs) for (const lang of langs) scores[lang] = (scores[lang] || 0) + (langs.length === 1 ? 1 : 0.5)
  }
  for (const [lang, pattern, weight] of HINTS) { const hits = sample.match(pattern); if (hits) scores[lang] = (scores[lang] || 0) + hits.length * weight }
  const known = normalizeLang(fallback), home = langBase(known)
  // The book language starts ahead: a different language must beat it clearly, not by a shared "la" or "de".
  if (home in WORD_SETS) scores[home] = scores[home] || 0
  const ranked = Object.entries(scores).map(([lang, score]) => [lang, lang === home ? score + FALLBACK_BONUS : score]).sort((a, b) => b[1] - a[1])
  const [lang, score] = ranked[0] || []
  if (!lang || scores[lang] < 2 || (ranked[1] && ranked[1][1] === score)) return fallback
  if (langBase(known) === lang && langRegion(known)) return known
  if (lang === 'pt') return BRAZILIAN.test(sample) ? 'pt-BR' : 'pt-PT'
  return `${lang}-${DEFAULT_REGION[lang]}`
}
