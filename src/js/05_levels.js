// ============================================================================
//  Puzzles. Coordinates are [type, column, height, row, quarterTurns, opts].
//  Column 0 is the left edge (A on the mat), row 0 the back edge, height 0 the mat.
//  Every puzzle ships with a reference solution that the automated checks run.
// ============================================================================
const LEVELS = [
  {
    key: 'gravity-works', name: 'Tyngdekraften virker', board: [11, 5, 6], par: 1,
    brief: 'Velkommen til verkstedet! Rampene står klare. Dra bowlingkula fra kassen, og slipp den øverst på den første rampa. Trykk så på Start. Tyngdekraften gjør resten.',
    fixed: [
      ['block', 0, 0, 2], ['block', 0, 1, 2], ['block', 0, 2, 2], ['block', 0, 3, 2],
      ['ramp', 1, 4, 2, 0], ['ramp', 3, 3, 2, 0], ['ramp', 5, 2, 2, 0], ['ramp', 7, 1, 2, 0],
      ['basket', 9, 0, 2, 0, { id: 'bk' }], ['block', 10, 0, 2], ['block', 10, 1, 2]
    ],
    bin: { bowling: 1 },
    goals: [{ type: 'inside', id: 'bk', what: 'bowling' }],
    solution: [['bowling', 1, 5, 2, 0]]
  },
  {
    key: 'downhill', name: 'Nedoverbakke', board: [7, 8, 7], par: 4,
    brief: 'Kula ligger klar øverst i tårnet. Bygg en vei ned til trakten foran. En rampe går ett hakk ned for hver to ruter, så hver ny rampe må stå ett hakk lavere enn den forrige. Bruk Opp og Ned for å flytte en del opp og ned. Svingskinnen får kula til å svinge.',
    fixed: [
      ['block', 0, 0, 1], ['block', 0, 1, 1], ['block', 0, 2, 1], ['block', 0, 3, 1], ['block', 0, 4, 1],
      ['ramp', 1, 5, 1, 0], ['bowling', 1, 6, 1, 0],
      ['funnel', 5, 1, 6, 0], ['basket', 5, 0, 6, 0, { id: 'bk' }], ['block', 5, 0, 7], ['block', 5, 1, 7], ['block', 5, 2, 7]
    ],
    bin: { ramp: 3, curve: 1 },
    goals: [{ type: 'inside', id: 'bk', what: 'bowling' }],
    solution: [['ramp', 3, 4, 1, 0], ['curve', 5, 4, 1, 0], ['ramp', 5, 3, 2, 3], ['ramp', 5, 2, 4, 3]]
  },
  {
    key: 'knock-on', name: 'Dominoeffekten', board: [12, 5, 5], par: 4,
    brief: 'En rekke dominobrikker med hull i, og ei bjelle på slutten. Fyll hullene, så det er én rute mellom hver brikke. En brikke faller den veien den peker. Noe må dytte den første. Fjærstøteren smeller av seg selv rett etter at du trykker Start.',
    fixed: [
      ['domino', 1, 0, 2, 0], ['domino', 2, 0, 2, 0], ['domino', 4, 0, 2, 0], ['domino', 5, 0, 2, 0], ['domino', 7, 0, 2, 0], ['domino', 9, 0, 2, 0],
      ['bell', 10, 0, 2, 2, { id: 'bell' }]
    ],
    bin: { ram: 1, domino: 3 },
    goals: [{ type: 'ring', id: 'bell' }],
    solution: [['ram', 0, 0, 2, 0], ['domino', 3, 0, 2, 0], ['domino', 6, 0, 2, 0], ['domino', 8, 0, 2, 0]]
  },
  {
    key: 'bounce-house', name: 'Hoppeslottet', board: [10, 5, 6], par: 1,
    brief: 'Bowlingkula triller ned rampa og dunker i gulvet. Men det står en vegg mellom kula og kurven. En trampoline spretter ting opp igjen, nesten like høyt som de falt fra. Og de fortsetter framover. Til og med bowlingkuler!',
    fixed: [
      ['block', 0, 0, 2], ['block', 0, 1, 2], ['block', 0, 2, 2],
      ['ramp', 0, 3, 2, 0], ['bowling', 0, 4, 2, 0],
      ['block', 5, 0, 2], ['block', 5, 1, 2],
      ['basket', 6, 0, 2, 0, { id: 'bk' }], ['block', 7, 0, 2], ['block', 7, 1, 2], ['block', 7, 2, 2]
    ],
    bin: { trampoline: 1 },
    goals: [{ type: 'inside', id: 'bk', what: 'bowling' }],
    solution: [['trampoline', 3, 0, 2, 0]]
  },
  {
    key: 'seesaw-fling', name: 'Vippetrikset', board: [9, 5, 9], par: 1,
    brief: 'Bjella henger høyt oppe, og det er med vilje. Når maskinen starter, faller sprettballen ned på gulvet. Bowlingkula triller ned i trakten og faller ut i bunnen. Sett en dumphuske slik at hver kule lander på hver sin ende.',
    fixed: [
      ['ramp', 2, 7, 2, 0], ['bowling', 2, 8, 2, 0], ['funnel', 4, 6, 2, 0], ['block', 5, 6, 2], ['block', 5, 7, 2],
      ['rubber', 2, 1, 2, 0], ['bell', 2, 5, 2, 0, { id: 'bell' }]
    ],
    bin: { seesaw: 1 },
    goals: [{ type: 'ring', id: 'bell' }],
    solution: [['seesaw', 2, 0, 2, 0]]
  },
  {
    key: 'hot-air', name: 'Varm luft', board: [8, 7, 8], par: 1,
    brief: 'En ballong har flydd opp under hylla og sitter fast. Den er sur. Blås den ut, så den kan fly opp i spikerbrettet. En vifte blåser bare rett fram, i sin egen høyde. Det er vegger på tre sider.',
    fixed: [
      ['balloon', 3, 0, 2, 0, { id: 'bal' }],
      ['platform', 3, 2, 2], ['platform', 3, 2, 3], ['platform', 2, 2, 2], ['platform', 4, 2, 2],
      ['block', 2, 0, 2], ['block', 2, 1, 2], ['block', 4, 0, 2], ['block', 4, 1, 2],
      ['pins', 2, 6, 4], ['pins', 3, 6, 4], ['pins', 4, 6, 4], ['pins', 2, 6, 5], ['pins', 3, 6, 5], ['pins', 4, 6, 5], ['pins', 3, 6, 6]
    ],
    bin: { fan: 1 },
    goals: [{ type: 'pop', id: 'bal' }],
    solution: [['fan', 3, 1, 1, 3]]
  },
  {
    key: 'breezy', name: 'En lett bris', board: [10, 6, 6], par: 1,
    brief: 'Trykkplater er brytere. Når noe tungt lander på en, slås alt med samme farge på, og det blir stående på. Her er både vifta og lyspæra røde. Finn ut hvor sprettballen lander, og legg en rød trykkplate der.',
    fixed: [
      ['block', 0, 0, 2], ['block', 0, 1, 2], ['ramp', 0, 2, 2, 0], ['rubber', 0, 3, 2, 0],
      ['lamp', 3, 0, 0, 0, { id: 'bulb', ch: 'red' }],
      ['block', 5, 0, 4], ['block', 6, 0, 4], ['block', 7, 0, 4], ['fan', 5, 1, 4, 0, { ch: 'red' }], ['beach', 6, 1, 4, 0],
      ['basket', 8, 0, 4, 0, { id: 'bk' }], ['block', 9, 0, 4], ['block', 9, 1, 4]
    ],
    bin: { button: 1 },
    goals: [{ type: 'light', id: 'bulb' }, { type: 'inside', id: 'bk', what: 'beach' }],
    solution: [['button', 3, 0, 2, 0]]
  },
  {
    key: 'magnetic', name: 'Magnetmagi', board: [9, 5, 6], par: 2,
    brief: 'Stålkula ligger trygt på toppen av tårnet. Den må lokkes ned i kurven. En magnet drar i stålkuler fra opptil fire ruter unna. Står magneten for nær, hopper kula bort og setter seg fast på den.',
    fixed: [
      ['block', 1, 0, 2], ['block', 1, 1, 2], ['block', 1, 2, 2], ['marble', 1, 3, 2, 0],
      ['basket', 2, 0, 2, 0, { id: 'bk' }]
    ],
    bin: { magnet: 1, funnel: 1 },
    goals: [{ type: 'inside', id: 'bk', what: 'marble' }],
    solution: [['magnet', 4, 3, 2, 2], ['funnel', 2, 1, 2, 0]]
  },
  {
    key: 'rush-hour', name: 'Rushtid', board: [8, 6, 5], par: 2,
    brief: 'En pakke skal fram til trykkplaten, og den er sent ute. Båndet frakter esken til enden og slipper den av. Med to bånd til, og litt lur styring, kommer den fram. Den gule pila på båndet viser hvilken vei det går.',
    fixed: [
      ['conveyor', 0, 0, 1, 0], ['crate', 0, 1, 1, 0],
      ['button', 4, 0, 3, 0, { ch: 'green', id: 'plate' }], ['lamp', 6, 0, 1, 0, { id: 'bulb', ch: 'green' }]
    ],
    bin: { conveyor: 2 },
    goals: [{ type: 'light', id: 'bulb' }],
    solution: [['conveyor', 2, 0, 1, 3], ['conveyor', 2, 0, 3, 0]]
  },
  {
    key: 'pinball', name: 'Flipperspill', board: [9, 7, 5], par: 2,
    brief: 'Sparkere sender alt som treffer dem, dit pila peker. Det spiller ingen rolle hvor det kommer fra. Bowlingkula triller langs bakerste rad, og bjella står foran. En vegg står i veien, med bare én åpning.',
    fixed: [
      ['block', 0, 0, 1], ['block', 0, 1, 1], ['ramp', 0, 2, 1, 0], ['bowling', 0, 3, 1, 0],
      ['block', 2, 0, 3], ['block', 3, 0, 3], ['block', 4, 0, 3], ['block', 5, 0, 3], ['block', 6, 0, 3], ['block', 8, 0, 3],
      ['bell', 8, 0, 5, 2, { id: 'bell' }]
    ],
    bin: { bumper: 2 },
    goals: [{ type: 'ring', id: 'bell' }],
    solution: [['bumper', 7, 0, 1, 3], ['bumper', 7, 0, 5, 0]]
  },
  {
    key: 'domino-theory', name: 'Dominoteori', board: [12, 7, 6], par: 3,
    brief: 'Alt med blå farge slås på samtidig: vifta og lyspæra. Dominobrikkene skal ende på en trykkplate. Men en ny plate er rød. Velg den og trykk på Farge for å gjøre den blå. Når vifta starter, trenger ballongen noe spisst der den havner.',
    fixed: [
      ['ram', 0, 0, 1, 0], ['domino', 1, 0, 1, 0], ['domino', 2, 0, 1, 0], ['domino', 4, 0, 1, 0], ['domino', 5, 0, 1, 0], ['domino', 6, 0, 1, 0],
      ['lamp', 5, 0, 4, 0, { id: 'bulb', ch: 'blue' }],
      ['fan', 7, 1, 4, 0, { ch: 'blue' }], ['balloon', 8, 0, 4, 0, { id: 'bal' }], ['platform', 8, 2, 4], ['block', 8, 0, 3], ['block', 8, 1, 3], ['block', 8, 0, 5], ['block', 8, 1, 5]
    ],
    bin: { domino: 1, button: 1, cactus: 1 },
    goals: [{ type: 'light', id: 'bulb' }, { type: 'pop', id: 'bal' }],
    solution: [['domino', 3, 0, 1, 0], ['button', 7, 0, 1, 0, { ch: 'blue' }], ['cactus', 10, 3, 4, 0]]
  },
  {
    key: 'grand-apparatus', name: 'Det store apparatet', board: [14, 8, 8], par: 5,
    brief: 'Mitt mesterverk, nesten ferdig! Fjærstøteren setter i gang dominobrikkene, og den siste lander på den gule platen. Da starter båndet og pæra lyser. Til slutt skal ei bjelle ringe høyt oppe. En ballong venter under hylla på siden. Jeg mangler fem deler. Klarer du å finne ut hvilke?',
    fixed: [
      ['ram', 0, 0, 1, 0], ['domino', 1, 0, 1, 0], ['domino', 2, 0, 1, 0], ['domino', 4, 0, 1, 0], ['domino', 6, 0, 1, 0],
      ['button', 7, 0, 1, 0, { ch: 'yellow', id: 'plate' }], ['lamp', 9, 0, 0, 0, { ch: 'yellow', id: 'bulb' }],
      ['block', 7, 0, 3], ['block', 7, 1, 3], ['block', 7, 2, 3], ['block', 7, 3, 3], ['conveyor', 7, 4, 3, 0, { ch: 'yellow' }], ['bowling', 7, 5, 3, 0],
      ['block', 10, 3, 3], ['block', 10, 4, 3], ['rubber', 11, 1, 3, 0], ['bell', 11, 5, 3, 0, { id: 'bell' }],
      ['balloon', 3, 0, 4, 0, { id: 'bal' }], ['platform', 3, 2, 4], ['platform', 3, 2, 3], ['platform', 2, 2, 4], ['platform', 4, 2, 4],
      ['block', 2, 0, 4], ['block', 2, 1, 4], ['block', 4, 0, 4], ['block', 4, 1, 4],
      ['pins', 2, 6, 2], ['pins', 3, 6, 2], ['pins', 4, 6, 2], ['pins', 2, 6, 1], ['pins', 3, 6, 1], ['pins', 4, 6, 1], ['pins', 3, 6, 0]
    ],
    bin: { domino: 2, funnel: 1, seesaw: 1, fan: 1 },
    goals: [{ type: 'light', id: 'bulb' }, { type: 'ring', id: 'bell' }, { type: 'pop', id: 'bal' }],
    solution: [['domino', 3, 0, 1, 0], ['domino', 5, 0, 1, 0], ['funnel', 9, 3, 3, 0], ['seesaw', 11, 0, 3, 2], ['fan', 3, 1, 5, 1, { ch: 'yellow' }]]
  }
];

const SANDBOX = {
  key: 'sandbox', name: 'Fritt verksted', board: [16, 11, 9], par: 0, goals: [], fixed: [],
  bin: Object.fromEntries(PART_ORDER.map(id => [id, -1]))
};

const SHOWCASE = {
  key: 'showcase', name: 'Utstilling', board: [14, 8, 9], loop: 12,
  goals: [{ type: 'ring', id: 'b1' }, { type: 'ring', id: 'b2' }, { type: 'pop', id: 'bal' }, { type: 'inside', id: 'bk', what: 'bowling' }],
  fixed: [
    // front: the long downhill run
    ['block', 0, 0, 6], ['block', 0, 1, 6], ['block', 0, 2, 6], ['block', 0, 3, 6],
    ['ramp', 1, 4, 6, 0], ['ramp', 3, 3, 6, 0], ['ramp', 5, 2, 6, 0], ['ramp', 7, 1, 6, 0], ['bowling', 1, 5, 6, 0],
    ['basket', 9, 0, 6, 0, { id: 'bk' }], ['block', 10, 0, 6], ['block', 10, 1, 6],
    // back: ram and dominoes into a bell
    ['ram', 0, 0, 1, 0], ['domino', 1, 0, 1, 0], ['domino', 2, 0, 1, 0], ['domino', 3, 0, 1, 0], ['domino', 4, 0, 1, 0],
    ['domino', 5, 0, 1, 0], ['domino', 6, 0, 1, 0], ['domino', 7, 0, 1, 0], ['domino', 8, 0, 1, 0], ['bell', 9, 0, 1, 2, { id: 'b1' }],
    // middle: the balloon escape
    ['balloon', 5, 0, 3, 0, { id: 'bal' }], ['platform', 5, 2, 3], ['platform', 5, 2, 4], ['platform', 4, 2, 3], ['platform', 6, 2, 3],
    ['block', 4, 0, 3], ['block', 4, 1, 3], ['block', 6, 0, 3], ['block', 6, 1, 3], ['fan', 5, 1, 2, 3],
    ['pins', 4, 6, 5], ['pins', 5, 6, 5], ['pins', 6, 6, 5], ['pins', 4, 6, 6], ['pins', 5, 6, 6], ['pins', 6, 6, 6], ['pins', 5, 6, 7],
    // right: funnel, seesaw and a bell in the rafters
    ['ramp', 10, 7, 3, 0], ['bowling', 10, 8, 3, 0], ['funnel', 12, 6, 3, 0], ['block', 13, 6, 3], ['block', 13, 7, 3],
    ['rubber', 10, 1, 3, 0], ['bell', 10, 5, 3, 0, { id: 'b2' }], ['seesaw', 10, 0, 3, 0]
  ]
};
