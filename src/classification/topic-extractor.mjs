// ABOUTME: Topic extraction from VTT transcript text for recommendation systems
// ABOUTME: Keyword/pattern matching to identify content categories (music, comedy, sports, etc.)

/**
 * Topic category definitions with weighted keyword patterns.
 *
 * Each category has:
 *   - threshold: cumulative weight required for a confidence of 1.0
 *   - terms: array of { pattern, weight } objects
 *
 * Confidence for a category = min(1.0, totalMatchWeight / threshold)
 *
 * Design notes:
 *   - Short-form video transcripts are typically < 200 words.
 *   - A single strong indicator (e.g. "recipe") should produce meaningful signal.
 *   - Thresholds are intentionally low so even brief transcripts can classify.
 *   - Multi-word phrases carry higher weight because they are less ambiguous.
 */
const TOPIC_PATTERNS = {
  music: {
    threshold: 3,
    terms: [
      // Strong indicators
      { pattern: /\bsong\b/gi, weight: 2 },
      { pattern: /\bsinging\b/gi, weight: 2 },
      { pattern: /\blyrics?\b/gi, weight: 2 },
      { pattern: /\bmelody\b/gi, weight: 2 },
      { pattern: /\bchorus\b/gi, weight: 1.5 },
      { pattern: /\bverse\b/gi, weight: 1 },
      { pattern: /\bmusic\b/gi, weight: 1.5 },
      { pattern: /\bsinger\b/gi, weight: 2 },
      { pattern: /\bmusician\b/gi, weight: 2 },
      { pattern: /\bband\b/gi, weight: 1 },
      { pattern: /\balbum\b/gi, weight: 1.5 },
      { pattern: /\btrack\b/gi, weight: 0.5 },
      // Instruments
      { pattern: /\bguitar\b/gi, weight: 1.5 },
      { pattern: /\bpiano\b/gi, weight: 1.5 },
      { pattern: /\bdrums?\b/gi, weight: 1 },
      { pattern: /\bviolin\b/gi, weight: 1.5 },
      { pattern: /\bbass\b/gi, weight: 0.5 },
      { pattern: /\bukulele\b/gi, weight: 1.5 },
      { pattern: /\bflute\b/gi, weight: 1.5 },
      { pattern: /\btrumpet\b/gi, weight: 1.5 },
      { pattern: /\bsaxophone\b/gi, weight: 1.5 },
      // Musical context
      { pattern: /\bbeat\b/gi, weight: 0.5 },
      { pattern: /\brhythm\b/gi, weight: 1 },
      { pattern: /\btune\b/gi, weight: 1 },
      { pattern: /\bconcert\b/gi, weight: 1.5 },
      { pattern: /\bkaraoke\b/gi, weight: 2 },
      { pattern: /\bhip\s*hop\b/gi, weight: 1.5 },
      { pattern: /\brap\b/gi, weight: 1 },
      { pattern: /\brapping\b/gi, weight: 2 },
      { pattern: /\bfreestyle\b/gi, weight: 1.5 },
      { pattern: /\bplaylist\b/gi, weight: 1.5 },
      { pattern: /\bharmony\b/gi, weight: 1 },
      { pattern: /\bduet\b/gi, weight: 2 },
      { pattern: /\bacoustic\b/gi, weight: 1.5 },
    ]
  },

  comedy: {
    threshold: 3,
    terms: [
      { pattern: /\bjoke[s]?\b/gi, weight: 2 },
      { pattern: /\bfunny\b/gi, weight: 1.5 },
      { pattern: /\bhilarious\b/gi, weight: 2 },
      { pattern: /\blaugh(ing|s|ed)?\b/gi, weight: 1 },
      { pattern: /\bcomedy\b/gi, weight: 2 },
      { pattern: /\bcomedian\b/gi, weight: 2 },
      { pattern: /\bpunchline\b/gi, weight: 2 },
      { pattern: /\bstand[- ]?up\b/gi, weight: 2 },
      { pattern: /\bskit\b/gi, weight: 1.5 },
      { pattern: /\bprank\b/gi, weight: 2 },
      { pattern: /\bpranked\b/gi, weight: 2 },
      { pattern: /\bparody\b/gi, weight: 2 },
      { pattern: /\bsatire\b/gi, weight: 1.5 },
      { pattern: /\bmeme\b/gi, weight: 1 },
      { pattern: /\blmao\b/gi, weight: 1 },
      { pattern: /\brofl\b/gi, weight: 1 },
      { pattern: /\blol\b/gi, weight: 0.5 },
      { pattern: /\bdead\s*a[fs]{2}\b/gi, weight: 1 },
      { pattern: /\bbloopers?\b/gi, weight: 1.5 },
      { pattern: /\bimpression\b/gi, weight: 1 },
    ]
  },

  dance: {
    threshold: 3,
    terms: [
      { pattern: /\bdanc(e|ing|er|ers)\b/gi, weight: 2 },
      { pattern: /\bchoreograph(y|er|ed)\b/gi, weight: 2.5 },
      { pattern: /\broutine\b/gi, weight: 1 },
      { pattern: /\bbreakdanc/gi, weight: 2.5 },
      { pattern: /\bb[- ]?boy(ing)?\b/gi, weight: 2 },
      { pattern: /\bballet\b/gi, weight: 2 },
      { pattern: /\btango\b/gi, weight: 2 },
      { pattern: /\bsalsa\b/gi, weight: 1.5 },
      { pattern: /\bhip\s*hop\s*(danc|move)/gi, weight: 2.5 },
      { pattern: /\bwaltz\b/gi, weight: 2 },
      { pattern: /\btwirl(ing|ed|s)?\b/gi, weight: 1 },
      { pattern: /\bshuffle\b/gi, weight: 1 },
      { pattern: /\btwerk(ing)?\b/gi, weight: 2 },
      { pattern: /\bfreestyle\s*danc/gi, weight: 2.5 },
      { pattern: /\bfloor\s*move/gi, weight: 1 },
      { pattern: /\bstep[s]?\b/gi, weight: 0.5 },
      { pattern: /\bgroove\b/gi, weight: 1 },
    ]
  },

  sports: {
    threshold: 3,
    terms: [
      // General sport terms
      { pattern: /\bgoal[s]?\b/gi, weight: 1 },
      { pattern: /\bscore[ds]?\b/gi, weight: 1 },
      { pattern: /\bteam[s]?\b/gi, weight: 1 },
      { pattern: /\bgame[s]?\b/gi, weight: 0.5 },
      { pattern: /\btournament\b/gi, weight: 1.5 },
      { pattern: /\bchampionship\b/gi, weight: 1.5 },
      { pattern: /\bmatch(es)?\b/gi, weight: 0.5 },
      { pattern: /\bplayer[s]?\b/gi, weight: 1 },
      { pattern: /\bathlet(e|ic|es)\b/gi, weight: 1.5 },
      { pattern: /\bcoach(ing|es|ed)?\b/gi, weight: 1 },
      { pattern: /\breferee\b/gi, weight: 1.5 },
      // Specific sports
      { pattern: /\bsoccer\b/gi, weight: 2 },
      { pattern: /\bfootball\b/gi, weight: 1.5 },
      { pattern: /\bbasketball\b/gi, weight: 2 },
      { pattern: /\bbaseball\b/gi, weight: 2 },
      { pattern: /\btennis\b/gi, weight: 2 },
      { pattern: /\bswimm(ing|er)\b/gi, weight: 1.5 },
      { pattern: /\bboxing\b/gi, weight: 2 },
      { pattern: /\bwrestl(ing|er)\b/gi, weight: 2 },
      { pattern: /\bmma\b/gi, weight: 1.5 },
      { pattern: /\bsurfing\b/gi, weight: 2 },
      { pattern: /\bskateboard(ing)?\b/gi, weight: 2 },
      { pattern: /\bsnowboard(ing)?\b/gi, weight: 2 },
      { pattern: /\bhockey\b/gi, weight: 2 },
      { pattern: /\bgolf(ing|er)?\b/gi, weight: 2 },
      { pattern: /\bcricket\b/gi, weight: 1.5 },
      { pattern: /\brugby\b/gi, weight: 2 },
      { pattern: /\bvolleyball\b/gi, weight: 2 },
      // Actions
      { pattern: /\btouchdown\b/gi, weight: 2 },
      { pattern: /\bhome\s*run\b/gi, weight: 2 },
      { pattern: /\bslam\s*dunk\b/gi, weight: 2 },
      { pattern: /\bthree[- ]?pointer\b/gi, weight: 2 },
      { pattern: /\bknockout\b/gi, weight: 1.5 },
      { pattern: /\bpenalty\b/gi, weight: 1 },
    ]
  },

  food: {
    threshold: 3,
    terms: [
      { pattern: /\brecipe[s]?\b/gi, weight: 2.5 },
      { pattern: /\bcook(ing|ed|s)?\b/gi, weight: 2 },
      { pattern: /\bbak(e|ing|ed)\b/gi, weight: 2 },
      { pattern: /\bingredient[s]?\b/gi, weight: 2 },
      { pattern: /\bdelicious\b/gi, weight: 1.5 },
      { pattern: /\btasty\b/gi, weight: 1.5 },
      { pattern: /\byummy\b/gi, weight: 1.5 },
      { pattern: /\bchef\b/gi, weight: 2 },
      { pattern: /\bkitchen\b/gi, weight: 1.5 },
      { pattern: /\boven\b/gi, weight: 1 },
      { pattern: /\bfrying\b/gi, weight: 1.5 },
      { pattern: /\bsaut[eé]\b/gi, weight: 2 },
      { pattern: /\bmarinate\b/gi, weight: 2 },
      { pattern: /\bseasoning\b/gi, weight: 1.5 },
      { pattern: /\bspice[s]?\b/gi, weight: 1 },
      { pattern: /\bdinner\b/gi, weight: 0.5 },
      { pattern: /\blunch\b/gi, weight: 0.5 },
      { pattern: /\bbreakfast\b/gi, weight: 0.5 },
      { pattern: /\bmeal\s*prep\b/gi, weight: 2 },
      { pattern: /\bfood\s*review\b/gi, weight: 2.5 },
      { pattern: /\bmukbang\b/gi, weight: 2.5 },
      { pattern: /\bfoodie\b/gi, weight: 2 },
      { pattern: /\brestaurant\b/gi, weight: 1 },
      // Specific food
      { pattern: /\bpasta\b/gi, weight: 1 },
      { pattern: /\bpizza\b/gi, weight: 1 },
      { pattern: /\bsushi\b/gi, weight: 1 },
      { pattern: /\bcake\b/gi, weight: 0.5 },
      { pattern: /\bbread\b/gi, weight: 0.5 },
      { pattern: /\bsteak\b/gi, weight: 1 },
      { pattern: /\bvegan\b/gi, weight: 1.5 },
      { pattern: /\bvegetarian\b/gi, weight: 1.5 },
      { pattern: /\bgluten[- ]?free\b/gi, weight: 1.5 },
    ]
  },

  animals: {
    threshold: 3,
    terms: [
      { pattern: /\bpet[s]?\b/gi, weight: 1.5 },
      { pattern: /\bpuppy\b/gi, weight: 2 },
      { pattern: /\bkitten\b/gi, weight: 2 },
      { pattern: /\bdog[s]?\b/gi, weight: 1.5 },
      { pattern: /\bcat[s]?\b/gi, weight: 1 },
      { pattern: /\bkitty\b/gi, weight: 1.5 },
      { pattern: /\bdoggo\b/gi, weight: 2 },
      { pattern: /\bpupper\b/gi, weight: 2 },
      { pattern: /\banimal[s]?\b/gi, weight: 1.5 },
      { pattern: /\bwildlife\b/gi, weight: 2 },
      { pattern: /\bbird[s]?\b/gi, weight: 1 },
      { pattern: /\bfish\b/gi, weight: 0.5 },
      { pattern: /\bhorse[s]?\b/gi, weight: 1 },
      { pattern: /\bbunny\b/gi, weight: 1.5 },
      { pattern: /\brabbit[s]?\b/gi, weight: 1.5 },
      { pattern: /\bhamster[s]?\b/gi, weight: 1.5 },
      { pattern: /\brescue\s*(animal|dog|cat|pet)/gi, weight: 2.5 },
      { pattern: /\badopt(ed|ing)?\s*(a\s*)?(dog|cat|pet|puppy|kitten)/gi, weight: 2.5 },
      { pattern: /\baquarium\b/gi, weight: 1.5 },
      { pattern: /\bzoo\b/gi, weight: 1.5 },
      { pattern: /\bvet(erinarian)?\b/gi, weight: 1 },
      { pattern: /\bgood\s*(boy|girl)\b/gi, weight: 1 },
      { pattern: /\btreats?\b/gi, weight: 0.5 },
      { pattern: /\bwalk(ing)?\s*(the\s*)?(dog|puppy)\b/gi, weight: 2 },
    ]
  },

  fashion: {
    threshold: 3,
    terms: [
      { pattern: /\boutfit\b/gi, weight: 2 },
      { pattern: /\bfashion\b/gi, weight: 2 },
      { pattern: /\bstyle\b/gi, weight: 1 },
      { pattern: /\bmakeup\b/gi, weight: 2 },
      { pattern: /\bbeauty\b/gi, weight: 1.5 },
      { pattern: /\bskincare\b/gi, weight: 2 },
      { pattern: /\bhairstyle\b/gi, weight: 2 },
      { pattern: /\bnail(s|art)\b/gi, weight: 1.5 },
      { pattern: /\bcosmetic[s]?\b/gi, weight: 1.5 },
      { pattern: /\bgrwm\b/gi, weight: 2.5 },
      { pattern: /\bget\s*ready\s*with\s*me\b/gi, weight: 2.5 },
      { pattern: /\bootd\b/gi, weight: 2.5 },
      { pattern: /\boutfit\s*of\s*the\s*day\b/gi, weight: 2.5 },
      { pattern: /\bhaul\b/gi, weight: 1.5 },
      { pattern: /\btry[- ]?on\b/gi, weight: 1.5 },
      { pattern: /\bwardrobe\b/gi, weight: 1.5 },
      { pattern: /\baccessor(y|ies)\b/gi, weight: 1 },
      { pattern: /\bjewelry\b/gi, weight: 1 },
      { pattern: /\bfoundation\b/gi, weight: 1 },
      { pattern: /\blipstick\b/gi, weight: 1.5 },
      { pattern: /\bmascara\b/gi, weight: 1.5 },
      { pattern: /\bcontour(ing)?\b/gi, weight: 1.5 },
      { pattern: /\bthrift\b/gi, weight: 1 },
      { pattern: /\bvintage\b/gi, weight: 0.5 },
    ]
  },

  art: {
    threshold: 3,
    terms: [
      { pattern: /\bpainting\b/gi, weight: 2 },
      { pattern: /\bdrawing\b/gi, weight: 2 },
      { pattern: /\bsculptur(e|ing)\b/gi, weight: 2 },
      { pattern: /\bart(ist|istic|work)?\b/gi, weight: 1.5 },
      { pattern: /\bcreativ(e|ity)\b/gi, weight: 1 },
      { pattern: /\bsketch(ing|es|ed)?\b/gi, weight: 2 },
      { pattern: /\bcanvas\b/gi, weight: 1.5 },
      { pattern: /\bwatercolor\b/gi, weight: 2 },
      { pattern: /\bacrylic\b/gi, weight: 1.5 },
      { pattern: /\boil\s*paint(ing)?\b/gi, weight: 2 },
      { pattern: /\bcalligraph(y|er)\b/gi, weight: 2 },
      { pattern: /\bpotter(y|ies)\b/gi, weight: 2 },
      { pattern: /\bceramic[s]?\b/gi, weight: 1.5 },
      { pattern: /\bcrochet\b/gi, weight: 2 },
      { pattern: /\bknitting\b/gi, weight: 2 },
      { pattern: /\bdiy\b/gi, weight: 1.5 },
      { pattern: /\bcraft(ing|s|ed)?\b/gi, weight: 1.5 },
      { pattern: /\bhandmade\b/gi, weight: 1.5 },
      { pattern: /\bresin\b/gi, weight: 1.5 },
      { pattern: /\billustrat(ion|ing|or)\b/gi, weight: 2 },
      { pattern: /\bdigital\s*art\b/gi, weight: 2.5 },
      { pattern: /\bbrush(es|stroke)?\b/gi, weight: 1 },
      { pattern: /\bpalette\b/gi, weight: 1 },
    ]
  },

  education: {
    threshold: 3,
    terms: [
      { pattern: /\btutorial\b/gi, weight: 2.5 },
      { pattern: /\bhow\s*to\b/gi, weight: 1.5 },
      { pattern: /\blearn(ing)?\b/gi, weight: 1 },
      { pattern: /\bteach(ing|er)?\b/gi, weight: 1.5 },
      { pattern: /\blesson\b/gi, weight: 1.5 },
      { pattern: /\bexplain(ed|ing|s)?\b/gi, weight: 1 },
      { pattern: /\beducat(e|ion|ional)\b/gi, weight: 2 },
      { pattern: /\bstep\s*by\s*step\b/gi, weight: 2 },
      { pattern: /\bbeginner\b/gi, weight: 1 },
      { pattern: /\badvanced\b/gi, weight: 0.5 },
      { pattern: /\btip[s]?\b/gi, weight: 0.5 },
      { pattern: /\btrick[s]?\b/gi, weight: 0.5 },
      { pattern: /\bhack[s]?\b/gi, weight: 0.5 },
      { pattern: /\bguide\b/gi, weight: 1 },
      { pattern: /\bscience\b/gi, weight: 1 },
      { pattern: /\bmath\b/gi, weight: 1.5 },
      { pattern: /\bhistory\b/gi, weight: 1 },
      { pattern: /\bfact[s]?\b/gi, weight: 0.5 },
      { pattern: /\bdid\s*you\s*know\b/gi, weight: 1.5 },
      { pattern: /\bstud(y|ying)\b/gi, weight: 1 },
      { pattern: /\bexam\b/gi, weight: 1 },
      { pattern: /\bhomework\b/gi, weight: 1 },
      { pattern: /\blife\s*hack\b/gi, weight: 1.5 },
    ]
  },

  gaming: {
    threshold: 3,
    terms: [
      { pattern: /\bgam(e|ing|er|ers|eplay)\b/gi, weight: 1.5 },
      { pattern: /\bstream(ing|er)\b/gi, weight: 1 },
      { pattern: /\bplaythrough\b/gi, weight: 2.5 },
      { pattern: /\bspeedrun\b/gi, weight: 2.5 },
      { pattern: /\bwalkthrough\b/gi, weight: 2 },
      { pattern: /\blevel\s*up\b/gi, weight: 1.5 },
      { pattern: /\bboss\s*fight\b/gi, weight: 2.5 },
      { pattern: /\brespawn\b/gi, weight: 2 },
      { pattern: /\bgg\b/gi, weight: 0.5 },
      { pattern: /\bnoob\b/gi, weight: 1 },
      { pattern: /\besports?\b/gi, weight: 2 },
      { pattern: /\bconsole\b/gi, weight: 0.5 },
      { pattern: /\bxbox\b/gi, weight: 2 },
      { pattern: /\bplaystation\b/gi, weight: 2 },
      { pattern: /\bnintendo\b/gi, weight: 2 },
      { pattern: /\bpc\s*gaming\b/gi, weight: 2.5 },
      { pattern: /\bfortnite\b/gi, weight: 2 },
      { pattern: /\bminecraft\b/gi, weight: 2 },
      { pattern: /\bcall\s*of\s*duty\b/gi, weight: 2 },
      { pattern: /\bvalorant\b/gi, weight: 2 },
      { pattern: /\bleague\s*of\s*legends\b/gi, weight: 2 },
      { pattern: /\broblox\b/gi, weight: 2 },
      { pattern: /\btwitch\b/gi, weight: 1.5 },
      { pattern: /\bloot\b/gi, weight: 1 },
      { pattern: /\braid\b/gi, weight: 1 },
      { pattern: /\bcraft(ing)?\b/gi, weight: 0.5 },
      { pattern: /\binventory\b/gi, weight: 1.5 },
    ]
  },

  nature: {
    threshold: 3,
    terms: [
      { pattern: /\bnature\b/gi, weight: 2 },
      { pattern: /\boutdoor[s]?\b/gi, weight: 1.5 },
      { pattern: /\bhik(e|ing|er)\b/gi, weight: 2 },
      { pattern: /\bcamping\b/gi, weight: 2 },
      { pattern: /\bmountain[s]?\b/gi, weight: 1.5 },
      { pattern: /\bocean\b/gi, weight: 1.5 },
      { pattern: /\bbeach\b/gi, weight: 1 },
      { pattern: /\bforest\b/gi, weight: 1.5 },
      { pattern: /\bwilderness\b/gi, weight: 2 },
      { pattern: /\bsunset\b/gi, weight: 1 },
      { pattern: /\bsunrise\b/gi, weight: 1 },
      { pattern: /\bgarden(ing)?\b/gi, weight: 1.5 },
      { pattern: /\bplant(s|ing|ed)?\b/gi, weight: 1 },
      { pattern: /\bflower[s]?\b/gi, weight: 1 },
      { pattern: /\btree[s]?\b/gi, weight: 0.5 },
      { pattern: /\bwaterfall\b/gi, weight: 1.5 },
      { pattern: /\blake\b/gi, weight: 1 },
      { pattern: /\briver\b/gi, weight: 0.5 },
      { pattern: /\btrail\b/gi, weight: 1 },
      { pattern: /\blandscape\b/gi, weight: 1.5 },
      { pattern: /\bscenery\b/gi, weight: 1.5 },
      { pattern: /\bscenic\b/gi, weight: 1.5 },
      { pattern: /\bweather\b/gi, weight: 1 },
      { pattern: /\bstargazing\b/gi, weight: 2 },
      { pattern: /\bfishing\b/gi, weight: 1.5 },
    ]
  },

  technology: {
    threshold: 3,
    terms: [
      { pattern: /\btech(nology)?\b/gi, weight: 1.5 },
      { pattern: /\bgadget[s]?\b/gi, weight: 2 },
      { pattern: /\bsmartphone\b/gi, weight: 1.5 },
      { pattern: /\biphone\b/gi, weight: 1.5 },
      { pattern: /\bandroid\b/gi, weight: 1.5 },
      { pattern: /\blaptop\b/gi, weight: 1.5 },
      { pattern: /\bapp[s]?\b/gi, weight: 0.5 },
      { pattern: /\bsoftware\b/gi, weight: 1.5 },
      { pattern: /\bhardware\b/gi, weight: 1.5 },
      { pattern: /\bcoding\b/gi, weight: 2 },
      { pattern: /\bprogramming\b/gi, weight: 2 },
      { pattern: /\bdeveloper\b/gi, weight: 1.5 },
      { pattern: /\bai\b/gi, weight: 1 },
      { pattern: /\bartificial\s*intelligence\b/gi, weight: 2 },
      { pattern: /\bmachine\s*learning\b/gi, weight: 2 },
      { pattern: /\brobot(ic)?s?\b/gi, weight: 1.5 },
      { pattern: /\bunbox(ing)?\b/gi, weight: 2 },
      { pattern: /\breview\b/gi, weight: 0.5 },
      { pattern: /\bcrypto\b/gi, weight: 1.5 },
      { pattern: /\bblockchain\b/gi, weight: 2 },
      { pattern: /\bnft\b/gi, weight: 1.5 },
      { pattern: /\bbitcoin\b/gi, weight: 2 },
      { pattern: /\bsetup\b/gi, weight: 0.5 },
      { pattern: /\bdesk\s*setup\b/gi, weight: 2 },
      { pattern: /\b3d\s*print(ing|er)?\b/gi, weight: 2 },
    ]
  },

  travel: {
    threshold: 3,
    terms: [
      { pattern: /\btravel(ing|led|s|er)?\b/gi, weight: 2 },
      { pattern: /\bvacation\b/gi, weight: 2 },
      { pattern: /\bholiday\b/gi, weight: 1 },
      { pattern: /\btourist\b/gi, weight: 1.5 },
      { pattern: /\btourism\b/gi, weight: 1.5 },
      { pattern: /\bflight\b/gi, weight: 1 },
      { pattern: /\bairport\b/gi, weight: 1.5 },
      { pattern: /\bhotel\b/gi, weight: 1 },
      { pattern: /\bhostel\b/gi, weight: 1.5 },
      { pattern: /\bairbnb\b/gi, weight: 1.5 },
      { pattern: /\bbackpack(ing|er)?\b/gi, weight: 2 },
      { pattern: /\bsightseeing\b/gi, weight: 2 },
      { pattern: /\bexplor(e|ing)\b/gi, weight: 1 },
      { pattern: /\bdestination\b/gi, weight: 1.5 },
      { pattern: /\bvisit(ing|ed)?\b/gi, weight: 0.5 },
      { pattern: /\broad\s*trip\b/gi, weight: 2 },
      { pattern: /\bpassport\b/gi, weight: 1.5 },
      { pattern: /\bwander(lust|ing)\b/gi, weight: 1.5 },
      { pattern: /\bvlog\b/gi, weight: 1 },
      { pattern: /\bcity\s*tour\b/gi, weight: 2 },
      { pattern: /\bstreet\s*food\b/gi, weight: 1.5 },
      { pattern: /\bsouvenir\b/gi, weight: 1.5 },
    ]
  },

  fitness: {
    threshold: 3,
    terms: [
      { pattern: /\bworkout\b/gi, weight: 2.5 },
      { pattern: /\bexercis(e|ing)\b/gi, weight: 2 },
      { pattern: /\bfitness\b/gi, weight: 2 },
      { pattern: /\bgym\b/gi, weight: 1.5 },
      { pattern: /\byoga\b/gi, weight: 2 },
      { pattern: /\bpilates\b/gi, weight: 2 },
      { pattern: /\bstretching\b/gi, weight: 1.5 },
      { pattern: /\bcardio\b/gi, weight: 2 },
      { pattern: /\bweight\s*(lifting|training)\b/gi, weight: 2.5 },
      { pattern: /\bsquat[s]?\b/gi, weight: 1.5 },
      { pattern: /\bdeadlift\b/gi, weight: 2 },
      { pattern: /\bbench\s*press\b/gi, weight: 2 },
      { pattern: /\bpush[- ]?up[s]?\b/gi, weight: 1.5 },
      { pattern: /\bpull[- ]?up[s]?\b/gi, weight: 1.5 },
      { pattern: /\bplank[s]?\b/gi, weight: 1.5 },
      { pattern: /\bprotein\b/gi, weight: 1 },
      { pattern: /\bcalories?\b/gi, weight: 1 },
      { pattern: /\bdiet\b/gi, weight: 1 },
      { pattern: /\bnutrition\b/gi, weight: 1 },
      { pattern: /\bmacros?\b/gi, weight: 1.5 },
      { pattern: /\bhealth(y)?\b/gi, weight: 0.5 },
      { pattern: /\bwellness\b/gi, weight: 1 },
      { pattern: /\bmeditat(e|ion|ing)\b/gi, weight: 1.5 },
      { pattern: /\brep[s]?\b/gi, weight: 0.5 },
      { pattern: /\bset[s]?\b/gi, weight: 0.3 },
      { pattern: /\bcross\s*fit\b/gi, weight: 2 },
      { pattern: /\babs\b/gi, weight: 1 },
      { pattern: /\bbicep\b/gi, weight: 1.5 },
      { pattern: /\btricep\b/gi, weight: 1.5 },
      { pattern: /\bglute[s]?\b/gi, weight: 1.5 },
      { pattern: /\bleg\s*day\b/gi, weight: 2 },
    ]
  },

  news: {
    threshold: 3,
    terms: [
      { pattern: /\bnews\b/gi, weight: 2 },
      { pattern: /\bpolitics?\b/gi, weight: 2 },
      { pattern: /\bpolitical\b/gi, weight: 1.5 },
      { pattern: /\belection\b/gi, weight: 2 },
      { pattern: /\bvot(e|ing|er)\b/gi, weight: 1 },
      { pattern: /\bpresident\b/gi, weight: 1.5 },
      { pattern: /\bgovernment\b/gi, weight: 1.5 },
      { pattern: /\bcongress\b/gi, weight: 1.5 },
      { pattern: /\bsenate\b/gi, weight: 1.5 },
      { pattern: /\blegislat(ion|ive|or)\b/gi, weight: 1.5 },
      { pattern: /\bbreaking\s*news\b/gi, weight: 2.5 },
      { pattern: /\bjournalis(t|m)\b/gi, weight: 2 },
      { pattern: /\breport(er|ing)\b/gi, weight: 0.5 },
      { pattern: /\bprotest\b/gi, weight: 1.5 },
      { pattern: /\brally\b/gi, weight: 1 },
      { pattern: /\bdemocra(t|cy|tic)\b/gi, weight: 1.5 },
      { pattern: /\brepublican\b/gi, weight: 1.5 },
      { pattern: /\bpolicy\b/gi, weight: 1 },
      { pattern: /\beconom(y|ic|ics)\b/gi, weight: 1 },
      { pattern: /\bheadline[s]?\b/gi, weight: 1.5 },
      { pattern: /\bcontrovers(y|ial)\b/gi, weight: 1 },
      { pattern: /\bactivis(t|m)\b/gi, weight: 1.5 },
      { pattern: /\bclimate\s*change\b/gi, weight: 1.5 },
      { pattern: /\bsocial\s*justice\b/gi, weight: 1.5 },
    ]
  },
};

/**
 * Minimum confidence threshold. Topics below this confidence are excluded
 * from the result to reduce noise.
 */
const MIN_CONFIDENCE = 0.15;

/**
 * Detect whether the text likely contains speech content (as opposed to
 * music-only, silence, or auto-generated noise).
 *
 * @param {string} text - Plain text extracted from VTT
 * @returns {boolean}
 */
function detectSpeech(text) {
  if (!text || text.trim().length === 0) return false;

  const words = text.trim().split(/\s+/);
  if (words.length < 3) return false;

  // If we have a reasonable number of words with recognizable patterns, it's speech
  const commonWords = /\b(the|a|an|is|are|was|were|to|of|and|in|for|on|it|that|this|with|you|i|he|she|we|they|my|your|have|has|do|does|not|but|or|if|so|at|from|by)\b/gi;
  const matches = text.match(commonWords);
  const commonWordRatio = (matches ? matches.length : 0) / words.length;

  // If at least 10% are common English function words, likely speech
  return commonWordRatio >= 0.10;
}

/**
 * Attempt a rough language hint from the text. This is intentionally simple:
 * we check for common function words in a few major languages. For a
 * transcript that is largely non-English, we return the best guess.
 *
 * @param {string} text
 * @returns {string} ISO 639-1 hint (e.g. "en", "es", "fr", "de", "pt", "unknown")
 */
function detectLanguageHint(text) {
  if (!text || text.trim().length === 0) return 'unknown';

  const lower = text.toLowerCase();

  const langSignals = {
    en: /\b(the|and|is|are|have|this|that|with|for|you|was|not|but|they|from)\b/g,
    es: /\b(el|la|los|las|de|en|que|por|con|una|del|para|como|pero|esta)\b/g,
    fr: /\b(le|la|les|de|des|un|une|et|est|que|dans|pour|sur|avec|pas)\b/g,
    de: /\b(der|die|das|und|ist|ein|eine|den|dem|nicht|auf|mit|sich|von|auch)\b/g,
    pt: /\b(o|a|os|as|de|que|em|um|uma|para|com|por|mais|mas|como)\b/g,
    ja: /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g,
    ko: /[\uAC00-\uD7AF\u1100-\u11FF]/g,
    zh: /[\u4E00-\u9FFF]{2,}/g,
    ar: /[\u0600-\u06FF]/g,
    hi: /[\u0900-\u097F]/g,
  };

  let bestLang = 'unknown';
  let bestCount = 0;

  for (const [lang, regex] of Object.entries(langSignals)) {
    const matches = lower.match(regex);
    const count = matches ? matches.length : 0;
    if (count > bestCount) {
      bestCount = count;
      bestLang = lang;
    }
  }

  // Require a minimum of 3 matches to make a call
  return bestCount >= 3 ? bestLang : 'unknown';
}

/**
 * Extract topic categories from plain transcript text.
 *
 * The function scans the text against every category's keyword patterns,
 * accumulates weighted scores, normalizes to 0-1 confidence, and returns
 * all topics above MIN_CONFIDENCE sorted by confidence descending.
 *
 * @param {string} text - Plain text (typically from parseVttText)
 * @returns {{
 *   topics: Array<{ category: string, confidence: number, keywords_matched: string[] }>,
 *   primary_topic: string | null,
 *   has_speech: boolean,
 *   language_hint: string,
 *   word_count: number
 * }}
 */
export function extractTopics(text) {
  const wordCount = text && text.trim().length > 0
    ? text.trim().split(/\s+/).length
    : 0;

  if (!text || text.trim().length === 0) {
    return {
      topics: [],
      primary_topic: null,
      has_speech: false,
      language_hint: 'unknown',
      word_count: 0,
    };
  }

  const hasSpeech = detectSpeech(text);
  const languageHint = detectLanguageHint(text);

  const topics = [];

  for (const [category, config] of Object.entries(TOPIC_PATTERNS)) {
    let totalWeight = 0;
    const keywordsMatched = [];

    for (const termDef of config.terms) {
      // Guard against malformed entries (e.g. typo "parameter" instead of "pattern")
      if (!termDef.pattern) continue;

      const matches = text.match(termDef.pattern);
      if (matches) {
        totalWeight += matches.length * termDef.weight;
        // Collect unique matched words (lowercased, deduplicated)
        for (const m of matches) {
          const normalized = m.toLowerCase().trim();
          if (!keywordsMatched.includes(normalized)) {
            keywordsMatched.push(normalized);
          }
        }
      }
    }

    const confidence = Math.min(1.0, totalWeight / config.threshold);

    if (confidence >= MIN_CONFIDENCE) {
      topics.push({
        category,
        confidence: Math.round(confidence * 100) / 100, // 2 decimal places
        keywords_matched: keywordsMatched,
      });
    }
  }

  // Sort by confidence descending
  topics.sort((a, b) => b.confidence - a.confidence);

  return {
    topics,
    primary_topic: topics.length > 0 ? topics[0].category : null,
    has_speech: hasSpeech,
    language_hint: languageHint,
    word_count: wordCount,
  };
}

/**
 * Convert topic extraction result into a flat label array suitable for
 * gorse/funnelcake item features.
 *
 * Only topics with confidence >= minConfidence are included. Each label
 * is prefixed with "topic:" for namespacing in the feature store.
 *
 * @param {{ topics: Array<{ category: string, confidence: number }> }} result - From extractTopics
 * @param {number} [minConfidence=0.3] - Minimum confidence to include as a label
 * @returns {string[]} e.g. ["topic:music", "topic:comedy"]
 */
export function topicsToLabels(result, minConfidence = 0.3) {
  if (!result || !result.topics) return [];
  return result.topics
    .filter(t => t.confidence >= minConfidence)
    .map(t => `topic:${t.category}`);
}

/**
 * Convert topic extraction result into a weighted feature map suitable
 * for gorse item features where weights matter.
 *
 * @param {{ topics: Array<{ category: string, confidence: number }> }} result
 * @param {number} [minConfidence=0.15] - Minimum confidence to include
 * @returns {Record<string, number>} e.g. { "topic:music": 0.8, "topic:comedy": 0.6 }
 */
export function topicsToWeightedFeatures(result, minConfidence = 0.15) {
  if (!result || !result.topics) return {};
  const features = {};
  for (const topic of result.topics) {
    if (topic.confidence >= minConfidence) {
      features[`topic:${topic.category}`] = topic.confidence;
    }
  }
  return features;
}
