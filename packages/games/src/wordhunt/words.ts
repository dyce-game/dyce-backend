/**
 * Word Hunt seed dictionary.
 *
 * SOURCE AND LICENCE: written for Dyce by the project (common everyday English words of 3–8 letters,
 * plus a small Nigerian food-and-street pack). It is original work, not copied or filtered from any
 * third-party word list, so there is no external licence to carry. It deliberately leaves out
 * offensive words, abbreviations, proper nouns and anything hyphenated or apostrophised.
 *
 * LIMITS: it is small (a few thousand words) so it can ship inside the app bundle. A real player will
 * sometimes find a valid word that is missing. `createWordHuntEngine(words)` takes any list, so the
 * server can load a larger public-domain dictionary (e.g. ENABLE) later; the match then records the
 * dictionary id in its state (`dict`). Changing the list changes which boards are generated and
 * accepted, so a live match must keep using the id it started with.
 */
export const WORD_HUNT_DICT_ID = 'dyce-v1';

const THREE = `
ace act add ado ads aft age ago aid ail aim air ale all and ant any ape apt arc are ark arm art ash ask
ate awe axe aye bad bag ban bar bat bay bed bee beg bet bid big bin bit boa bog boo bow box boy bra bud
bug bun bus but buy bye cab cam can cap car cat caw cob cod cog con coo cop cot cow coy cry cub cud cue
cup cur cut dab dad dam day den dew did die dig dim din dip doe dog don dot dry dub due dug duo dye ear
eat ebb eel egg ego elf elk elm emu end era eve ewe eye fad fan far fat fax fed fee fen few fib fig fin
fir fit fix flu fly foe fog for fox fry fun fur gab gag gap gas gel gem get gig gin gnu god got gum gun
gut guy gym had ham has hat hay hem hen her hew hid him hip his hit hog hop hot how hub hue hug hum hut
ice icy ill imp ink inn ion ire irk its ivy jab jam jar jaw jay jet jig job jog jot joy jug jut keg key
kid kin kit lab lad lag lap law lax lay lea led leg let lid lie lip lit lob log lot low lug mad man map
mar mat maw may men met mew mid mix mob mod mop mow mud mug mum nab nag nap net new nil nip nod nor not
now nun nut oak oar oat odd ode off oft oil old one opt orb ore our out owe owl own pad pal pan par pat
paw pay pea peg pen pep per pet pew pie pig pin pit ply pod pop pot pro pry pub pug pun pup put rag ram
ran rap rat raw ray red ref rib rid rig rim rip rob rod roe rot row rub rug rum run rut rye sac sad sag
sap sat saw say sea see set sew she shy sin sip sir sit six ski sky sly sob son sow soy spa spy sub sue
sum sun sup tab tad tag tan tap tar tax tea ten the thy tie tin tip toe ton too top tot tow toy try tub
tug two urn use van vat vet vex via vie vow wad wag war was wax way web wed wee wet who why wig win wit
woe wok won woo wow yak yam yap yes yet yew you zap zip zoo eba
`;

const FOUR = `
able ache acid acre aged aide aids aims airy ajar akin alas ally also alto amid ammo anew ankle ante
anti ants apes arch area arid army arts atom aunt aura auto avid away axes axis baby back bade bags bait
bake bald ball balm band bang bank bare bark barn base bash bath bats bead beak beam bean bear beat beds
beef been beer bees beet bell belt bend bent best bets bias bike bill bind bird bite bits blew blob blot
blow blue blur boar boat body boil bold bolt bomb bond bone book boom boot bore born boss both bout bowl
bows boys brag bran brat bray bred brew brim brow buck buds buff bulb bulk bull bump bunk buns buoy burn
burp bury bush bust busy buys cabs cafe cage cake calf call calm came camp cane cans cape caps card care
cars cart case cash cast cats cave cell chat chef chew chin chip chop city clad clam clan clap claw clay
clip clog clot club clue coal coat cobs code cogs coil coin cola cold colt comb come cone cook cool cope
cops copy cord core cork corn cost cosy cots cove cows crab cram crew crib crop crow cube cubs cues cuff
cult cups curb cure curl cute dads dale dame damp dams dare dark dart dash data date dawn days daze dead
deaf deal dean dear debt deck deed deem deep deer dent deny desk dial dice died diet digs dill dime dine
ding dips dire dirt disc dish disk dive dock docs dodo does dogs doll dome done doom door dose dote dots
dove down doze drab drag dram draw dray drew drip drop drum dual dubs duck duct dude duel dues duet duke
dull duly dumb dump dune dunk dusk dust duty dyed dyes each earl earn ears ease east easy eats echo edge
eels eggs egos elms else emit ends envy epic eras even ever evil exam exit eyed eyes face fact fade fads
fail fair fake fall fame fang fans fare farm fast fate fats fawn fear feat feed feel fees feet fell felt
fern fete feud fibs file fill film find fine fins fire firm fish fist fits five flag flak flap flat flaw
flax flea fled flee flew flex flip flit flock flog flop flow flue foal foam foes fogs fold folk fond font
food fool foot fork form fort foul four fowl foxy frag free fret frog from fuel full fume fund funk furs
fury fuse fuss gain gait gala gale gall game gang gape gaps garb gash gasp gate gave gawk gaze gear gels
gems gent germ gets gift gilt gins gird girl gist give glad glee glen glib glim glob glow glue glum glut
gnat gnaw goal goat gobs gods goes gold golf gone gong good goof gown grab gram gray grew grey grid grim
grin grip grit grow grub gulf gull gulp gums guns guru gush gust guts guys gyms hack hail hair half hall
halo halt hams hand hang hank hard hare harm harp hash  hate hats haul have hawk hays haze hazy head
heal heap hear heat heel heir held hell helm help hems hens herb herd here hero hers hide high hike hill
hilt hind hint hips hire hiss hits hive hoax hobs hock hold hole holy home hone honk hood hoof hook hoop
hoot hope horn hose host hour howl hubs huge hugs hulk hull hump hums hunk hunt hurl hurt hush huts hymn
iced ices icon idea idle idly idol inch info inks inns into ions iris iron isle itch item jabs jack jade
jail jams jars jazz jean jeep jerk jest jets jibe jigs jilt jobs jogs join joke jolt josh jots joys judo
jugs jump junk jury just keen keep kegs kelp kept keys kick kids kill kiln kilt kind king kiss kite kits
kiwi knee knew knit knob knot know labs lace lack lacy lads lady laid lake lamb lame lamp land lane lank
laps lard lark lash lass last late lava lawn laws lays lazy lead leaf leak lean leap left legs lend lens
lent less lest lets levy liar lice lick lids lied lies life lift like lilt lily limb lime limp line link
lint lion lips lisp list  live load loaf loan lobs lock lode loft logs lone long look loom loop 
loot lord lore lose loss lost lots loud lout love lows luck lull lump lung lure lurk lush lust lute lynx
mace made maid mail main make male mall malt mane many maps mare mark mars mart mash mask mass mast mate
math mats maze meal mean meat meek meet melt memo mend menu mere mesh mess mice mild mile milk mill mime
mind mine mini mink mint mire miss mist mite mitt moan moat mock mode mold mole molt monk mood moon moor
moos moot mope more morn moss most moth move mows much muck muds mule mull mums muse mush musk must mute
mutt myth nail name nape naps navy near neat neck need neon nerd nest nets news next nibs nice nick nine
nips  node nods none nook noon norm nose note noun nova nude nuns nuts oaks oars oath oats obey odds
odes ogre oils oily okay okra omen omit once ones only onto onus oozy opal open opts oral orbs ores ouch
ours oust outs oval oven over owed owes owls owns oxen pace pack pact pads page paid pail pain pair pale
palm pans pant pare park part pass past pate path pats pave pawn paws pays peak peal pear peas peat peck
peek peel peep peer pegs pelt pens pent perk pest pets pews pick pier pies pigs pike pile pill pine ping
pink pins pint pipe pips pits pity plan play plea pled plod plot plow ploy plug plum plus pods poem poet
poke pole polo pomp pond pony pool poor pope pops pore pork port pose posh post posy pots pour pout pram
pray prep prey prim prod prop pros prow pubs puck puff pugs pull pulp puma pump punk puns punt puny pupa
pups pure purr push puts quay quit quiz race rack raft rage rags raid rail rain rake ramp rams rang rank
rant raps rare rash rats rave rays raze read real reap rear reed reef reek reel rein rely rend rent reps
rest ribs rice rich ride rids rife rift rigs rile rims rind ring rink riot ripe rips rise risk rite road
roam roar robe robs rock rode rods roes role  roll romp roof rook room root rope rose rosy rota rote
rots rout rove rows rube rubs ruby rude rued rugs ruin rule rump rune rung runs runt ruse rush rust ruts
sack sacs safe saga sage sags said sail sake sale salt same sand sane sang sank saps sari sash  sate
save saws says scab scan scar seal seam sear seas seat sect seed seek seem seen sees self sell  send
sent sets sewn sews shed shim shin ship shoe shop shot show shut sick side sift sigh sign silk sill silo
sing sink sins sips sire site sits size skew skid skim skin skip skis skit slab slag slam slap slat slaw
sled slew slid slim slip slit slob slog slop slot slow slug slum slur smog smug snag snap snip snob snot
snow snub snug soak soap soar sobs sock soda sofa soft soil sold sole solo some song sons soon soot sore
sort soul soup sour sown sows span spar spat spec sped spin spit spot spry spud spun spur stab stag star
stay stem step stew stir stop stow stub stud such suds suit sulk sump sums sung sunk suns sure surf swam
swan swap swat sway swim swum tabs tack taco tact tags tail take tale talk tall tame tank taps tape tare
tarn taro tart task taut taxi teak teal team tear teas tech  teem teen tell temp tend tens tent term
test text than that thaw thee them then they thin this thou thud thug thus tick tide tidy tied tier ties
tile till tilt time tint tiny tips tire toad toes tofu toga toil told toll tomb tome tone tons took tool
toot tops tore torn toss tote tour tout town toys trap tray tree trek trim trio trip trod trot  true
tsar tuba tube tubs tuck tuft tugs tuna tune turf turn tusk twig twin twit type tyre ugly undo unit unto
upon urge used user uses vain vale vane vary vase vast veal veil vein vent verb very vest veto vial vibe
vice  view vile vine visa void vole volt vote vows wade wads waft wage wags waif wail wait wake walk
wall wand want ward ware warm warn warp wars wart wary wash wasp wave wavy ways weak wear webs weds weed
week weep weld well welt went wept were west wets what when whey whim whip whir whit whom wick wide wife
wigs wild wile will wilt wily wimp wind wine wing wink wins wipe wire wiry wise wish wisp with wits woes
woke wolf womb wood woof wool word wore work worm worn wove wrap wren writ yank yard yarn yawn yeah year
yell yelp yews yoga yoke yolk yore your yowl zany zeal zero zest zinc zing zone zoom suya gari okra yam
`;

const FIVE = `
about above abuse actor acute adapt added adept admit adopt adult after again agent agile aging agree
ahead aided aimed alarm album alert alike alive allow alone along aloof alter amaze amber amend among ample
angel anger angle angry ankle annex apart apple apply apron arena argue arise armed aroma arose array arrow
ashes aside asked asset atlas attic audio avoid awake award aware awful bacon badge badly  baker
balls  barge baron basic basin basis batch beach beads beard beast began begin begun being belly below
bench berry  bikes birth black blade blame bland blank blast blaze bleak bleed blend bless blind blink
bliss block blood bloom blown blues bluff blunt blush board boast bonus boost booth bound brain brake brand
brass brave bread break breed brick bride brief bring brink brisk broad broke brook broom brown brush buddy
build built bulbs bunch bunny burnt burst buyer cabin cable cache camel canal candy canoe cargo carry carve
cases catch cause cease cedar chain chair chalk champ chaos charm chart chase cheap cheat check cheek cheer
chess chest chick chief child chili chill chimp china chips choir chord chose chunk cider cigar civic civil
claim clamp clash class clean clear clerk click cliff climb cling cloak clock clone close cloth cloud clown
clubs coach coast cobra cocoa coins color comes comic coral couch cough could count court cover crack craft
cramp crane crash crate crawl crazy cream creek creep crest crews crime crisp cross crowd crown crude cruel
crumb crush crust cubic curly curve cycle daily dairy daisy dance dated deals dealt death debut decay decor
delay delta dense depot depth derby desks devil diary dirty disco ditch diver dizzy dodge doing dolls donor
doors doubt dough dozen draft drain drama drank drape drawn dread dream dress dried drift drill drink drive
drone drops drove drums drunk dryer ducks dully dummy dwarf dwell eager eagle early earns earth easel eaten
eater edges eight elbow elder elect elite empty enemy enjoy enter entry equal error essay event every exact
exams exile exist extra fable faced facts fails fairy faith false fancy fangs fares farms fatal fault favor
feast feeds fence ferry fetch fever fiber field fiery fifth fifty fight filed fills films final finds fines
first fixed flags flair flame flank flash flask flats fleet flesh flick flies fling flint float flock flood
floor flour flown fluid flute foams focus foggy folds folks fonts foods force forge forms forth forty forum
found frame frank fraud freak fresh friar fried frogs front frost froze fruit fully funds funny furry fuzzy
gains games gamma gauge gazed gears  genre ghost giant gifts girls given giver glade gland glare glass
glaze gleam glide globe gloom glory gloss glove glued goals goats going golds goods goose grace grade grain
grand grant grape graph grasp grass grave gravy great greed green greet grief grill grind grips groan groom
gross group grove growl grown grows guard guess guest guide guild guilt gulls gummy habit hairs halls hands
handy happy hardy harsh haste hasty hatch hates haunt haven hawks heads heard hears heart heavy hedge heels
hello hence herbs highs hills hints hippo hired hobby holds holes holly homes honey honor hoped hopes horde
horns horse hosts hotel hours house hover human humid humor hurry hyena icing ideal idiom idols image imply
index inner input irons issue ivory jacks jelly jewel joint joker jolly judge juice juicy jumbo jumps keeps
kicks kills kinds kings  kites knees knelt knife knock knots known label labor lacks laced lakes lamps
lands lanes large laser lasts later laugh layer leads leaks learn lease least leave ledge legal lemon level
lever light liked likes limbs limit lined linen liner lines links lions lists liter lived liver lives llama
loads loafs loans lobby local lodge lofty logic looks loops loose lords loses lotus loved lover lower loyal
lucky lunch lungs lying magic major maker males mango maple march marks marry marsh masks match mates maybe
mayor meals means meant meats medal media melon mercy merge merit merry metal meter midst might mills mimic
mince minds miner minor minus mirth mists mixed mixer model modem moist molds money monks month moods moose
moral motel motor mound mount mouse mouth moved moves movie mower mucus muddy mugs mulch mural music myths
nails naive named names nanny nasty naval needs nerve nests never newly niche night ninth noble nodes noise
noisy norms north nose notch noted notes novel nudge nurse nutty nylon oasis oaths occur ocean offer often
older olive onion opens opera orbit order organ other otter ought ounce outer owned owner oxide ozone paced
packs pages pains paint pairs palms panel panic pants paper parks parts party pasta paste patch paths patio
pause paved paws peace peach peaks pearl pears pedal peels penny perch peril perks pests petal phase phone
photo piano picks piece piers pilot pinch pines pinks pious pipes pitch pixel pizza place plain plane plank
plans plant plate plays plaza plead pleas plots pluck plugs plume plump plums plush poems poets point poise
poker polar poles polls pools porch pores ports posed posts pouch pound pours power prank prawn press price
pride prime print prior prism prize probe prone proof prose proud prove pulls pulse pumps punch pupil puppy
purse quack queen query quest queue quick quiet quilt quirk quite quote rabbi races racks radar radio rails
rainy raise rally ranch range ranks rapid rates ratio raven reach react reads ready realm rebel refer reign
relax relay reply rider ridge rifle right rigid rings rinse risen risks risky rival river roads roast robes
robin robot rocks rocky rogue roles rolls  rooms roots ropes roses rough round route rowdy royal rugby
ruins ruled ruler rules rural sadly safer sails saint salad sales salon sands sandy sauce saved saves scale
scalp scare scarf scary scene scent scoop scope score scout scrap screw seals seats seeds seeks seems sells
sends sense serve setup seven shade shady shaft shake shaky shall shame shape share shark sharp shave shawl
sheep sheer sheet shelf shell shift shine shiny ships shirt shock shoes shone shook shoot shops shore short
shots shout shown shows shrub sight signs silly since sings sixth sixty sized sizes skate skill skins skirt
skull slabs slang slate slave sleek sleep sleet slept slice slide slime slope slots slows small smart smash
smell smile smoke snack snail snake snaps sneak snore snowy soaks soaps sober socks soils solar sold solid
solve songs sonic sorry sorts souls sound soups south space spare spark spawn speak spear speed spell spend
spent spice spicy spied spike spill spine spins spite split spoke spoon sport spots spray spree squad stack
staff stage stain stair stake stale stalk stall stamp stand stare stark stars start state stays steak steal
steam steel steep steer stems steps stern stick stiff still sting stink stock stole stone stood stool stoop
stops store stork storm story stout stove strap straw stray strip stuck study stuff stump stung stunt style
sugar suite suits sunny super surge swamp swans swear sweat sweep sweet swell swept swift swing swirl sword
swore sworn table tacks tails taken takes tales talks tally tamed tanks tapes tardy tasks taste tasty taxes
teach teams tears teeth tempo tends tenor tense tenth tents terms tests texts thank theft their theme there
these thick thief thigh thing think third thorn those three threw throw thumb tidal tides tiger tight tiles
timer times timid tired tires title toast today toes token tombs tonic tools tooth topic torch total touch
tough tours towel tower towns toxic trace track trade trail train trait tramp trash tray treat trees trend
trial tribe trick tried tries trims trips troop trout truck truly trump trunk trust truth tubes tulip tunes
tunic turns tutor twice twins twist tying ultra uncle under undue union unite units unity until upper upset
urban urged usage users usual utter vague valid value valve vault vegan veils veins venue verse video views
villa vines vinyl viola viper viral virus visit vital vivid vocal vodka voice voted voter vowel wages wagon
waist waits waked walks walls waltz wands wants warms wasps waste watch water waved waves waxed weary weave
wedge weeds weeks weigh weird wells whale wheat wheel where which while whips white whole whose wicks widen
wider widow width wield wings wiped wires witch wives woken woman women woods words works world worms worry
worse worst worth would wound wraps wrath wreck wrist write wrong wrote yacht yards yarns yawns years yeast
yield young yours youth zebra zones agbada danfo okada jollof amala egusi naira
`;

const SIX = `
absent accept access across acting action active actors actual adjust admire advice affair affect afford
afraid agency agenda almost always amount animal annual answer anyone anyway appeal appear around arrive
artist asleep aspect assign assist assume attach attack attend  author autumn avenue backed backup
bakery banana banker barber barely barrel basket battle beacon beauty become before behalf behave behind
belief belong beside better beyond bishop bitter blanket blazer bloody blouse bottle bottom bounce branch
breath breeze bridge bright broken bronze bubble bucket budget buffer bundle burden bureau butter button
buying cabbage camera campus cancel candle canvas carbon career carpet carrot castle casual caught center
certain chance change charge cheese cherry chicken choice choose chosen church circle circus clever client
clinic closer closet clothe cloudy coffee collar colony column combat comedy comfort coming commit common
copper corner cotton county couple course cousin create credit crisis cruise custom damage dancer danger
dealer debate decade decide deeply defeat defend define degree demand dentist depend deputy desert design
desire detail detect device dinner direct divide doctor dollar domain double dragon drawer dreams driver
during easily eating editor effect effort eighth either eleven emerge empire employ enable enamel ending
energy engage engine enough ensure entire equity escape estate ethnic evenly evolve exceed except excuse
expand expect expert export expose extend extent fabric factor fairly fallen family famous farmer faster
father fellow fender fierce figure filter finger finish fiscal flavor flight flower fluffy follow forest
forget formal format former foster fourth frenzy friend frozen future galaxy garage garden garlic gather
gender gentle gently  giants global golden gotten govern grabbed grains grassy gravel greens grocer
ground growth guitar hammer handle happen harbor hardly hawker health hearty heaven height helmet helper
hidden highly hockey holder honest hoping horizon horror hunger hunter hurdle ignore impact import impose
income indeed infant inform injury inside insist intend invite island itself jacket jersey jungle junior
kidney kitten ladder laptop lately latter launch lawyer layout leader league leaves legend lesson letter
likely linear liquid listen little lively lizard locate locker lonely longer lovely lumber  magnet
mainly makers manage manner marble margin marine market master matter meadow medium member memory mental
merely method middle mighty miller minute mirror mobile modern modest moment monkey months morale mostly
mother motion motive moving muscle museum mutual myself narrow nation native nature nearby nearly nephew
nested nicely nickel nimble nobody normal notice notion number object obtain occupy office online openly
oppose option orange origin outfit output oxygen packet palace panels parade parent parrot partly passed
patrol pencil people pepper period permit person phrase picnic pillow planet player please pledge plenty
pocket poetry poison police policy polish pollen potato powder prayer prefer pretty prince prison profit
proper public pursue puzzle rabbit racing random rarely rather rating reader really reason recent record
reduce reform refuse region reject relate relief remain remedy remove repair repeat report rescue resort
result retail retire return reveal review reward rhythm ribbon riders ripple rising robust rocket rolled
roster rubber rugged runner saddle safely safety salmon sample saving scales scheme school scrape screen
script search season second secret sector secure seeing select seller senior sensor series server settle
severe shadow shaped shelter shield shines shorts should shower shrimp signal silent silver simple simply
single sister sketch skills slight slowly smooth snooze soccer social soften solely solemn solved sooner
sorrow source speech spider spirit splash spoken sports spring square stable stairs stamps stands staple
starts statue status steady stolen stones stored storms strain strand stream street stress strict strike
string stripe strong studio submit sudden suffer summer summit  sunset supply surely surface surgeon
survey switch symbol system tackle talent tanker target taught tender tennis thanks theory thirty though
thread threat thrill throat throne thrown ticket tickle timber tinted tissue toilet tomato tongue 
topple toward travel treaty tribal trophy tunnel turkey twelve twenty unable unfold unique unless unlike
update upward urgent useful valley vanish vendor verify versus vessel victim viewer violet virtue vision
visual volume voting  waited waiter walked wallet wander wanted warmth wealth weapon weekly weight
whisky wicked widely wilder window winner winter wisdom within wizard wonder wooden worked worker worthy
wrench writer yellow zipper
`;

const SEVEN = `
account address advance against airport already amazing ancient another anxious anybody anymore anytime
applied arrange arrival article attempt attract average balance banking barrier battery bedroom believe
beneath benefit between billion blanket brother brought builder cabinet captain capture careful carrier
catalog cattle caution central century certain chapter charity charter chicken chimney circuit citizen
classic climate closely clothes cluster coastal college combine comfort command comment company compare
compete complex concept concern conduct confirm connect consist contact contain content contest context
control convert cookies correct costume cottage council counter country courage courier courses cousins
covered crystal culture current custody dancing dealing decline default defense deliver density deposit
desktop destroy develop devoted diamond digital dinners discuss disease display distant divorce doctors
dolphin  drawing dresser driving dynamic earlier earning eastern economy edition elderly element
embrace emotion endless enemies engaged enhance enjoyed episode equally evening evident exactly examine
example excited exclude execute exhibit existed expense explain explore express extreme factory failure
faintly fashion feature federal feeling fiction fifteen fighter finally finance finding fishing fitness
flavour flowers flying focused foolish football forever forward founded freedom frequent friends frontal
funeral further gallery garbage general genuine gesture getting  glasses glimpse glorify golfers
goodbye grammar grandma granite gravity greater grocery grounds growing gunfire habitat halfway handful
happily harmony harvest healthy hearing heavily helpful herself highway himself history holiday hostile
housing however hundred hunting husband illegal imagine impulse include initial inquiry insight inspire
install instant intense interim invited involve itself jewelry journal journey justice kitchen knowing
 landing largely lasting lateral laundry leading learned leather lecture legally leisure lending
liberty library license lifting lightly limited   liquids  loaded locally logging
longest looking lottery loyalty machine mailbox mammals manager mankind mansion marched markets marriage
massive mastery matches matters maximum meaning measure medical meeting mention message methods migrate
million mineral minimal minimum minutes miracle mission mistake mixture monitor monthly morning mounted
mystery natural nearest neither nervous network neutral nothing noticed nowhere nuclear numbers nursery
obvious  offense officer offline oldest ongoing opening operate opinion optical optimum organic
 outcome outdoor outline outside overall overlap  package painful painter palette 
parents parking partner passage passing passion pasture patient pattern payment peanuts penalty pension
percent perfect perhaps phrases physics picking picture pioneer planned planner plastic players pleased
plugged plunder pointed poetic  popular portion poverty powered prayers precise predict prefers
premium prepare present prevent primary printer privacy private problem proceed process produce product
profile program project promise promote prompt propose protect protein protest provide provoke publish
pulling purpose pushing quality quarter quickly quietly railway raising rapidly reached reading reality
realize receipt receive recipes record recover reduced reflect refresh refugee regular related release
relieve remains remarks removed repeats replace reports request require rescued reserve resolve respect
respond restore retired reunion reveals revenue reverse rewards rhythms rolling routine running savings
scatter scholar science scratch seconds section segment seizure selfish serious servant service setting
seventh several shallow shelter shining shocked shorter shortly shoulder showers sibling silence silicon
similar sincere singing singers sinking sisters sitting skilled slender slipped smiling smokers society
soldier solemnly someone somehow someday soothing sorrows soybean  speaker special species speech
spelled spirits sponsor sprinkle squirrel stadium staffed started startle station stayed steward stomach
storage stories strange stretch strikes striped student studied subject succeed success suggest summary
sunrise supplies support suppose supreme surface surplus survive suspect sustain sweater sweeten swimmer
symptom tablets tactics talking teacher teenage tension terrain terrible testing texture theater themes
therapy thereby thought thunder tickets  totally touched tourist toward towards tracked trading
traffic trained trainer transit traveler treated trouble trusted  turkeys turning typical 
undergo unified uniform unknown unusual upgrade upwards urgency useless utility vacancy vaccine variety
various vehicle venture version veteran victory village violent virtual visible visitor voltage 
walking wanting warfare warmest warrior wasting watched watches wealthy weather wedding weekend weekday
weights welcome welfare western whatever whenever whereby whether whisper whoever whole wildlife willing
winners winning winter wishing without witness wonders working workers worship wounded wrapped writers
writing  
`;

const EIGHT = `
absolute abstract academic accepted accident accuracy accurate achieved activity actually addition
adequate adjacent advanced adviser aircraft alcohol although  analysis announce anything anywhere
apparent appeared approach approval argument arrested artistic assembly athletic attached attitude audience
 backward balanced bathroom beautiful bedrooms behavior bicycles birthday blessing blocking
boundary breaking breathe brilliant broadcast building business calendar campaign capacity capital cardinal
careless carrying category ceiling celebrate cemetery champion changing chapters charming checking chemical
children choosing circular citizens civilian classics climbing clothing coaching coconut collapse collect
colorful combined comfort  commonly company complain complete composed computer conclude concrete
conflict confused congress connects consider constant consumer contains continue contract contrast convince
cooking corridor coverage creation creative creature criminal critical crossing crowded cultural customer
daughter deadline dealings debating decision declared decrease deeply defender definite delicate delivery
democrat departed describe deserted designer  detailed detected develop diameter 
different digital dinosaur directly director disaster discount discover disorder dispatch distance distinct
district disturbed dividing doctrine document domestic dominant doorbell drainage dramatic drawings dropping
duration earnings economic educated election electric elephant elevator eligible emerging emission emphasis
employee employer endeavor engineer enormous entering entirely entrance envelope equation equality
equipped escaping estimate evening evolved exchange exciting exercise existing expected explicit exposure
extended external facility familiar fastest favorite feedback feelings festival fighting figures finished
firewall flexible floating flooding football foreign forever forgave formerly fortune forward fraction
freedom frequent friendly frontier function funding furnace gambling gardener gasoline generate genetics
genuine giveaway glorious governor graceful graduate graphics grateful greatest grocery guardian guidance
handling hardware harmony headline heading healthy heavenly helpless heritage highland historic holidays
homeless honestly hospital  household however humanity hundreds hungry identify identity illusion
imagined immense implied imports improve incident included including increase indicate industry infinite
informal inherent initial injured innocent inquiry insisted inspired instance integral intended interest
interior internal internet interval intimate invasion involved isolated jewelry judgment junction justice
keyboard kindness kingdom kitchens knowledge landlord language laughing launched learning lectures
lifetime lighting likewise limited listing literary location lockdown logistic lovingly mailing maintain
majority managing marathon marginal marketing marriage material matching meantime measured medicine
 member    merchant message midnight military minerals minister minority
miracles mirrored mistaken modeling moderate modified molecule momentum monetary monitors monument morning
mountain movement multiple mushroom musician mystery national natural navigate negative neighbor networks
nineteen nobody normally northern notebook  nuclear numerous objects observe obtained occasion
occupied occurred offering official offshore  opinions opponent opposite optimism optional ordinary
organize original outdoors outlined outlook overcome overhead oversee overseas overview painting pairing
parallel pastries patience patrol payments peaceful peasants pedestal pendulum perceive perfectly
performed periodic personal petition physical pipeline platform pleasant pleasure plumbing pointing
policies politics portrait position positive possible postcard poverty powerful practice precious
predicted preferred premises prepared presence preserve pressure pretend prevents previous princess
printing priority prisoner probably problems proceeds producer products profound progress prohibit
projects promised promotes properly property proposal prospect protocol provided provider province
publicly pursuing quality quantity question quickest quotient rainbows rational reaction reactive
readable reading realized reasoned receipts received receiver recently recorded recovery recruits
reducing referred reflects reforms refugees regional register regular rejected relative released
reliable religion remained remember reminder removing renewed repairs repeated replaced reported
reporter republic required research reserved resident resolved resource response restaurant restored
restrict revealed reviewed rewarded rhetoric ridiculous roommate rotation sandwich  scenario
schedule  security selected selling seminars sensible sentence separate sequence services
settings several shadows shelters shipping shopping shortage shoulder shouting simplify simulate
situated skeleton slightly smaller smoothly snowfall software soldiers solution somebody sometime
southern spanning speaking specific spectrum speeches spelling spending spirited splendid sporting
spreads squared stadiums standard standing starting starving stations steadily stirring stopping
straight strategy strength stressed stretch striking strongly struggle students studying subjects
suburban suddenly suffered suitable summary sunlight superior supplied supports supposed surgical
surprise surround survival survived suspects sweeping swimming symbolic sympathy syndrome tailored
takeaway taxation teachers teaching teammate technical teenager telecast telling tendency terminal
terribly testimony textbook thankful theatres thinking thorough thousand threaten thrilled throwing
thunders  tolerant tomorrow tornado touching tourists tracking trade trailers training
transfer transmit traveled treasure treating treaties triangle tropical troubles truckers trusting
 turnover  ultimate umbrella unaware uncommon underlie underway unhappy uniforms
universe unlikely unknown unlocked unwanted updating upgrades upstairs utensils vacation validity
valuable variable vehicles velocity ventures verified versions vertical veterans  victims
viewpoint villages violence virtuous visiting vitamins volcanic volumes voluntary wardrobe warnings
warranty washable wasteful watching waterway weakness wealthier weapons weddings weekends weighted
welcomed wellness whatever wherever whispers widening wildfire willpower windmill wireless
withdraw witnesses wondered wonderful workable workshop worldwide worrying wrapping wrestler writings
yearbook yourself
`;

/**
 * The words, upper-case, de-duplicated, sorted. Only A–Z and 3–8 letters survive, so a typo in the
 * lists above can never put a bad entry into a match.
 */
export const WORD_HUNT_WORDS: readonly string[] = Array.from(
  new Set(
    [THREE, FOUR, FIVE, SIX, SEVEN, EIGHT]
      .join(' ')
      .split(/\s+/)
      .map((w) => w.trim().toUpperCase())
      .filter((w) => /^[A-Z]{3,8}$/.test(w)),
  ),
).sort();
