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

describe('optional-content visibility (pdf.js 3.11 semantics)', () => {
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
  const OPS: PdfOpsLike = {
    beginMarkedContent: 1,
    beginMarkedContentProps: 2,
    endMarkedContent: 3,
    paintXObject: 4,
    beginInlineImage: 5,
    shadingFill: 6,
  };
  const FILL = 7;
  class Name {
    constructor(readonly name: string) {}
  }
  const hiddenImagery = { type: 'OCMD' as const, ids: ['ortho', 'images'], policy: 'AllOn' };

  beforeEach(() => filter.set({ ortho: false, images: false, contours: true }));
  afterAll(() => filter.set(null));

  /** Feed ops the way the patched evaluator does; returns the ops it drops. */
  function run(ops: (number | [number, unknown] | { oc: unknown })[]): number[] {
    const list = {};
    const dropped: number[] = [];
    ops.forEach((op, index) => {
      if (typeof op === 'object' && !Array.isArray(op)) {
        // An /OC section: pdf.js calls op() then, once parsed, push().
        filter.op(list, OPS.beginMarkedContentProps, [new Name('OC')], OPS, Name);
        filter.push(list, op.oc as never);
        return;
      }
      const [fn, args] = Array.isArray(op) ? op : [op, null];
      if (filter.op(list, fn, args, OPS, Name)) dropped.push(index);
    });
    return dropped;
  }

  it('drops images, inline images, shadings and forms inside hidden sections only', () => {
    const dropped = run([
      OPS.paintXObject, // 0: outside any section
      { oc: hiddenImagery }, // 1
      OPS.paintXObject, // 2
      OPS.beginInlineImage, // 3
      OPS.shadingFill, // 4
      FILL, // 5: vector paint stays (pdf.js hides it at paint time)
      OPS.endMarkedContent, // 6
      OPS.paintXObject, // 7: after the section
      { oc: { type: 'OCG', id: 'contours' } }, // 8
      OPS.paintXObject, // 9: visible section
      OPS.endMarkedContent, // 10
    ]);
    expect(dropped).toEqual([2, 3, 4]);
  });

  it('hides everything nested inside a hidden section, whatever the inner sections say', () => {
    const dropped = run([
      { oc: hiddenImagery },
      OPS.beginMarkedContent,
      [OPS.beginMarkedContentProps, [new Name('Span'), null]],
      { oc: { type: 'OCG', id: 'contours' } },
      OPS.paintXObject, // 4
      OPS.endMarkedContent,
      OPS.endMarkedContent,
      OPS.endMarkedContent,
      OPS.paintXObject, // 8: still inside the hidden section
      OPS.endMarkedContent,
      OPS.paintXObject, // 10
    ]);
    expect(dropped).toEqual([4, 8]);
  });

  it('survives unbalanced end-of-section operators', () => {
    expect(run([OPS.endMarkedContent, OPS.endMarkedContent, OPS.paintXObject])).toEqual([]);
  });

  it('keeps a section whose tag pdf.js drops out of the nesting, as pdf.js does', () => {
    // pdf.js ignores a BDC whose tag is not a name, so its EMC closes the
    // enclosing hidden section: what follows is visible again.
    const dropped = run([
      { oc: hiddenImagery },
      [OPS.beginMarkedContentProps, ['not-a-name', null]],
      OPS.endMarkedContent,
      OPS.paintXObject,
    ]);
    expect(dropped).toEqual([]);
  });

  it('drops nothing while no map is installed', () => {
    filter.set(null);
    expect(run([{ oc: hiddenImagery }, OPS.paintXObject, OPS.endMarkedContent])).toEqual([]);
  });

  it('never throws into pdf.js', () => {
    expect(filter.op(null as never, OPS.paintXObject, null, OPS, Name)).toBe(false);
    expect(() => filter.push(null as never, hiddenImagery)).not.toThrow();
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
    listeners[0]?.({ data: { inukshukOptionalContent: { a: false } } });
    expect(installed.visible({ type: 'OCG', id: 'a' })).toBe(false);
    // pdf.js' own messages (and junk) leave the map alone.
    listeners[0]?.({ data: { targetName: 'worker', action: 'GetOperatorList' } });
    listeners[0]?.({ data: 'string' });
    listeners[0]?.(null);
    expect(installed.visible({ type: 'OCG', id: 'a' })).toBe(false);
    listeners[0]?.({ data: { inukshukOptionalContent: null } });
    expect(installed.visible({ type: 'OCG', id: 'a' })).toBe(true);
  });
});
