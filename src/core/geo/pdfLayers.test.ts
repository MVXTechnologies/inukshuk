import {
  DEFAULT_PDF_LAYER_PREFS,
  PDF_LAYER_RUNTIME_SOURCE,
  loadPdfLayerRuntime,
  type PdfLayerGroup,
  type PdfOpsLike,
} from './pdfLayers';

const { filter, planLayers, isImageryLayer } = loadPdfLayerRuntime();

/** The groups of a 2024 USGS US Topo sheet (Portland West, ME), abridged. */
const US_TOPO: PdfLayerGroup[] = [
  { id: '230R', name: 'Map Collar', visible: true },
  { id: '232R', name: 'Map Frame', visible: true },
  { id: '238R', name: 'Terrain', visible: true },
  { id: '239R', name: 'Shaded Relief', visible: false },
  { id: '240R', name: 'Contours', visible: true },
  { id: '251R', name: 'Images', visible: false },
  { id: '252R', name: 'Orthoimage', visible: true },
];

describe('isImageryLayer', () => {
  it.each([
    'Orthoimage',
    'Orthoimagery',
    'ortho imagery',
    'Ortho_Photos',
    'Aerial',
    'Aerial Imagery',
    'Aerial Photographs',
    'aerial-photo',
    'Satellite',
    'Satellite Imagery',
    'Imagery',
    '  Orthoimage  ',
  ])('treats %j as imagery', (name) => {
    expect(isImageryLayer(name)).toBe(true);
  });

  it.each([
    'Images', // US Topo's parent group; a scanned map may call its only layer this
    'Image',
    'Shaded Relief',
    'Contours',
    'Map Collar',
    'Orthoimage Index', // a vector index of imagery tiles is not imagery
    'Aerial Tramway',
    '',
  ])('does not treat %j as imagery', (name) => {
    expect(isImageryLayer(name)).toBe(false);
  });

  it('ignores missing names', () => {
    expect(isImageryLayer(null)).toBe(false);
  });
});

describe('planLayers', () => {
  it('turns imagery off by default and leaves every other default alone', () => {
    const plan = planLayers(US_TOPO, DEFAULT_PDF_LAYER_PREFS);
    expect(plan.visibility).toEqual({
      '230R': true,
      '232R': true,
      '238R': true,
      '239R': false,
      '240R': true,
      '251R': false,
      '252R': false,
    });
    expect(plan.changed).toEqual(['252R']);
    // Its "Images" parent (251R) is off by default: nothing drawn changes.
    expect(plan.drawnChanged).toEqual([]);
  });

  it('counts imagery switched off as drawn when no hidden "Images" parent guards it', () => {
    const older = US_TOPO.map((g) => (g.name === 'Images' ? { ...g, visible: true } : g));
    expect(planLayers(older, DEFAULT_PDF_LAYER_PREFS).drawnChanged).toEqual(['252R']);
    const bare = US_TOPO.filter((g) => g.name !== 'Images');
    expect(planLayers(bare, DEFAULT_PDF_LAYER_PREFS).drawnChanged).toEqual(['252R']);
  });

  it('shows imagery on request, including the US Topo "Images" parent it is nested under', () => {
    const plan = planLayers(US_TOPO, { showImagery: true });
    expect(plan.visibility['252R']).toBe(true);
    expect(plan.visibility['251R']).toBe(true);
    expect(plan.visibility['239R']).toBe(false); // relief is not imagery
    expect(plan.changed).toEqual(['251R']);
    expect(plan.drawnChanged).toEqual(['251R']);
  });

  it('never switches on a bare "Images" group without an imagery layer to go with it', () => {
    const scanned = [{ id: '1R', name: 'Images', visible: false }];
    expect(planLayers(scanned, { showImagery: true }).visibility).toEqual({ '1R': false });
    expect(planLayers(scanned, { showImagery: true }).changed).toEqual([]);
  });

  it('changes nothing for a document without imagery', () => {
    const groups = US_TOPO.filter((g) => g.name !== 'Orthoimage');
    const plan = planLayers(groups, DEFAULT_PDF_LAYER_PREFS);
    expect(plan.changed).toEqual([]);
  });

  it('tolerates junk input', () => {
    expect(planLayers(null as unknown as PdfLayerGroup[], DEFAULT_PDF_LAYER_PREFS)).toEqual({
      visibility: {},
      changed: [],
      drawnChanged: [],
    });
    const junk = [null, { name: 'Contours', visible: true }, { id: '1R', name: null, visible: 0 }];
    expect(
      planLayers(
        junk as unknown as PdfLayerGroup[],
        null as unknown as typeof DEFAULT_PDF_LAYER_PREFS,
      ),
    ).toEqual({ visibility: { '1R': false }, changed: [], drawnChanged: [] });
  });
});

describe('optional-content visibility (pdf.js OptionalContentConfig semantics)', () => {
  beforeEach(() => filter.set({ on: true, off: false, on2: true, off2: false }));
  afterAll(() => filter.set(null));

  it('shows everything while no map is installed', () => {
    filter.set(null);
    expect(filter.visible({ type: 'OCG', id: 'off' })).toBe(true);
  });

  it('reads plain groups, and counts unknown groups and junk as visible', () => {
    expect(filter.visible({ type: 'OCG', id: 'on' })).toBe(true);
    expect(filter.visible({ type: 'OCG', id: 'off' })).toBe(false);
    expect(filter.visible({ type: 'OCG', id: 'elsewhere' })).toBe(true);
    expect(filter.visible(null)).toBe(true);
    expect(filter.visible({ type: 'Strange' } as never)).toBe(true);
  });

  it.each([
    [undefined, ['on', 'off'], true],
    ['AnyOn', ['off', 'off2'], false],
    ['AllOn', ['on', 'off'], false],
    ['AllOn', ['on', 'on2'], true],
    ['AnyOff', ['on', 'off'], true],
    ['AnyOff', ['on', 'on2'], false],
    ['AllOff', ['off', 'off2'], true],
    ['AllOff', ['on', 'off'], false],
    ['Bogus', ['off'], true],
    ['AllOn', ['on', 'unknown'], true],
  ])('membership dictionary with policy %s over %j is %s', (policy, ids, expected) => {
    expect(filter.visible({ type: 'OCMD', ids, policy })).toBe(expected);
  });

  it('reads a membership dictionary that names a single group', () => {
    expect(filter.visible({ type: 'OCMD', id: 'off' })).toBe(false);
    expect(filter.visible({ type: 'OCMD', id: 'nope' })).toBe(true);
    expect(filter.visible({ type: 'OCMD' })).toBe(true);
  });

  it.each([
    [['And', 'on', 'on2'], true],
    [['And', 'on', 'off'], false],
    [['Or', 'off', 'on'], true],
    [['Or', 'off', 'off2'], false],
    [['Not', 'off'], true],
    [['Not', 'on'], false],
    [['And', 'on', ['Or', 'off', 'on2']], true],
    [['And', 'on', ['Not', 'on2']], false],
    [['And', 'on', 'unknown'], true],
    [['Xor', 'on'], true],
    [['And'], true],
  ])('visibility expression %j is %s', (expression, expected) => {
    expect(filter.visible({ type: 'OCMD', expression })).toBe(expected);
  });
});

describe('operator filter', () => {
  const OPS: PdfOpsLike = { paintXObject: 4, endInlineImage: 5, shadingFill: 6 };
  const BMC = 1;
  const BDC = 2;
  const EMC = 3;
  const FILL = 7;
  const hiddenImagery = { type: 'OCMD' as const, ids: ['ortho', 'images'], policy: 'AllOn' };

  beforeEach(() => filter.set({ ortho: false, images: false, contours: true }, OPS));
  afterAll(() => filter.set(null));

  type Step = number | { oc: unknown } | { tag: 'ignored' };
  /**
   * Feed ops the way the patched evaluator does, tracking marked-content
   * depth the way pdf.js 6 does (`y` in getOperatorList): every BDC and BMC
   * opens a level, every EMC closes one unless already at 0, and a parsed
   * `/OC` section is pushed at the level it opened. `{ tag: 'ignored' }` is
   * an operator pdf.js skips without touching the depth (a BMC/EMC with a
   * dictionary argument). Returns the indexes of the dropped ops.
   */
  function run(steps: Step[], key: object = {}): number[] {
    let level = 0;
    const dropped: number[] = [];
    steps.forEach((step, index) => {
      if (typeof step === 'object' && 'oc' in step) {
        filter.op(key, BDC, level);
        level += 1;
        filter.push(key, step.oc as never, level);
        return;
      }
      if (typeof step === 'object') {
        filter.op(key, EMC, level);
        return;
      }
      if (filter.op(key, step, level)) {
        dropped.push(index);
        return;
      }
      if (step === BMC || step === BDC) level += 1;
      else if (step === EMC && level > 0) level -= 1;
    });
    return dropped;
  }

  it('drops images, inline images, shadings and forms inside hidden sections only', () => {
    const dropped = run([
      OPS.paintXObject, // 0: outside any section
      { oc: hiddenImagery }, // 1
      OPS.paintXObject, // 2
      OPS.endInlineImage, // 3
      OPS.shadingFill, // 4
      FILL, // 5: vector paint stays (pdf.js hides it at paint time)
      EMC, // 6
      OPS.paintXObject, // 7: after the section
      { oc: { type: 'OCG', id: 'contours' } }, // 8
      OPS.paintXObject, // 9: visible section
      EMC, // 10
    ]);
    expect(dropped).toEqual([2, 3, 4]);
  });

  it('hides everything nested inside a hidden section, whatever the inner sections say', () => {
    const dropped = run([
      { oc: hiddenImagery },
      BMC,
      BDC, // a non-/OC tag: visible on its own
      { oc: { type: 'OCG', id: 'contours' } },
      OPS.paintXObject, // 4
      EMC,
      EMC,
      EMC,
      OPS.paintXObject, // 8: still inside the hidden section
      EMC,
      OPS.paintXObject, // 10
    ]);
    expect(dropped).toEqual([4, 8]);
  });

  it('forgets a closed hidden section when a sibling opens at the same depth', () => {
    const dropped = run([
      { oc: hiddenImagery },
      EMC,
      BDC, // a non-/OC section at depth 1 again: nothing hidden in it
      OPS.paintXObject, // 3
      EMC,
      BMC,
      OPS.shadingFill, // 6
    ]);
    expect(dropped).toEqual([]);
  });

  it('survives unbalanced end-of-section operators', () => {
    expect(run([EMC, EMC, OPS.paintXObject])).toEqual([]);
  });

  it('follows pdf.js depth when pdf.js ignores an operator', () => {
    // A BMC/EMC with a dictionary argument is skipped by pdf.js without
    // changing its depth; the hidden section is still open after it.
    const dropped = run([{ oc: hiddenImagery }, { tag: 'ignored' }, OPS.paintXObject]);
    expect(dropped).toEqual([2]);
  });

  it('keeps the state of each getOperatorList call apart (form XObjects nest)', () => {
    const page = {};
    const form = {};
    run([{ oc: { type: 'OCG', id: 'contours' } }], page);
    // The form's own content opens a hidden section at ITS depth 1...
    expect(run([{ oc: hiddenImagery }, OPS.paintXObject, EMC], form)).toEqual([1]);
    // ...which says nothing about the page's depth-1 section.
    expect(filter.op(page, OPS.paintXObject, 1)).toBe(false);
  });

  it('drops nothing while no map is installed, or without the op codes', () => {
    filter.set(null);
    expect(run([{ oc: hiddenImagery }, OPS.paintXObject, EMC])).toEqual([]);
    filter.set({ ortho: false, images: false });
    expect(run([{ oc: hiddenImagery }, OPS.paintXObject, EMC])).toEqual([]);
  });

  it('never throws into pdf.js', () => {
    expect(filter.op(null as never, OPS.paintXObject, 1)).toBe(false);
    expect(filter.op({}, OPS.paintXObject, Number.NaN)).toBe(false);
    expect(() => filter.push(null as never, hiddenImagery, 1)).not.toThrow();
    expect(() => filter.push({}, hiddenImagery, 0)).not.toThrow();
    const hostile = {
      get type(): string {
        throw new Error('boom');
      },
    };
    expect(filter.visible(hostile as never)).toBe(true);
  });
});

describe('runtime installation', () => {
  it('installs on the global it is evaluated in and listens for the visibility map', () => {
    const listeners: ((event: unknown) => void)[] = [];
    const root: Record<string, unknown> = {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (type === 'message') listeners.push(listener);
      },
    };
    new Function('globalThis', PDF_LAYER_RUNTIME_SOURCE)(root);
    const installed = root.__inkOC as typeof filter;
    expect(listeners).toHaveLength(1);
    listeners[0]?.({
      data: {
        inukshukOptionalContent: { a: false },
        inukshukOps: { paintXObject: 4, endInlineImage: 5, shadingFill: 6 },
      },
    });
    expect(installed.visible({ type: 'OCG', id: 'a' })).toBe(false);
    const key = {};
    installed.push(key, { type: 'OCG', id: 'a' }, 1);
    expect(installed.op(key, 4, 1)).toBe(true);
    // pdf.js' own messages (and junk) leave the map alone.
    listeners[0]?.({ data: { targetName: 'worker', action: 'GetOperatorList' } });
    listeners[0]?.({ data: 'string' });
    listeners[0]?.(null);
    expect(installed.visible({ type: 'OCG', id: 'a' })).toBe(false);
    listeners[0]?.({ data: { inukshukOptionalContent: null } });
    expect(installed.visible({ type: 'OCG', id: 'a' })).toBe(true);
  });
});
