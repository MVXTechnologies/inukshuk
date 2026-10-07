/**
 * PDF layers in the rasterizer page (#477).
 *
 * The page's own scripts — the layer runtime and the render script, both
 * extracted from the HTML the provider writes — run in a `vm` context against
 * a scripted pdf.js whose document has optional-content groups. What is under
 * test is the page's side of the contract: the layer plan is applied to the
 * config pdf.js paints with, the SAME visibility map is handed to the worker
 * before the operator list is requested, and a page whose layers differ from
 * the document defaults is never handed to a native renderer (which would
 * draw the defaults).
 */
import { runInNewContext } from 'node:vm';
import { Blob as NodeBlob } from 'node:buffer';
import { URL as NodeURL } from 'node:url';
import { writeServedText } from '@data/localServer';
import React from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { PdfRasterizerProvider, usePdfRasterizer } from './PdfRasterizer';

jest.mock(
  '@data/pdfRenderRecovery',
  () => ({ beginPdfRender: () => 'token', finishPdfRender: jest.fn() }),
  {
    virtual: true,
  },
);
jest.mock('@data/nativePdf', () => ({
  nativePdfAvailable: () => false,
  renderNativePdfCrop: jest.fn(),
  deleteNativePdfOutput: jest.fn(),
}));
jest.mock('react-native-webview', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    WebView: React.forwardRef(function MockWebView(_props, ref) {
      React.useImperativeHandle(ref, () => ({ injectJavaScript: jest.fn() }));
      return null;
    }),
  };
});
// A worker source carrying every anchor, so the provider builds a page whose
// worker filters layers (the real asset is checked in pdfWorkerPatch.test.ts).
jest.mock('./pdfjsAssets', () => ({
  loadPdfjsSources: async () => ({
    main: '',
    worker: (
      jest.requireActual('@core/geo/pdfWorkerPatch') as typeof import('@core/geo/pdfWorkerPatch')
    ).PDF_WORKER_INSERTIONS.map((p) => p.anchor).join('\n'),
    wasm: {},
    fallbacks: {},
  }),
  stagePdfjsFallbacks: async () => undefined,
}));
jest.mock('@data/localServer', () => ({
  acquireLocalServer: async () => ({
    value: 'http://127.0.0.1:8080',
    release: async () => undefined,
  }),
  probeLocalServer: async () => true,
  restartLocalServer: async (origin: string) => origin,
  writeServedText: jest.fn(),
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));

interface Group {
  name: string;
  visible: boolean;
}

/**
 * pdf.js 6's OptionalContentConfig, as far as the page uses it: it iterates
 * [id, group] pairs (an empty config for a document without layers).
 */
function fakeConfig(groups: Record<string, Group> | null) {
  const state = groups ? structuredClone(groups) : {};
  return {
    [Symbol.iterator]: () => Object.entries(state)[Symbol.iterator](),
    setVisibility: jest.fn((id: string, visible: boolean) => {
      if (state[id]) state[id].visible = visible;
    }),
    state,
  };
}

/** The op codes the page hands the worker filter (pdf.js' own OPS). */
const OPS = { paintXObject: 66, endInlineImage: 63, shadingFill: 31 };

interface Scenario {
  config: ReturnType<typeof fakeConfig> | 'reject' | 'missing';
}

function scriptedPdfjs(scenario: Scenario) {
  const port = { postMessage: jest.fn() };
  const renders: { optionalContentConfigPromise?: Promise<unknown> }[] = [];
  const page = {
    rotate: 0,
    userUnit: 1,
    view: [0, 0, 1000, 800],
    getViewport: ({ scale }: { scale: number }) => ({ width: 1000 * scale, height: 800 * scale }),
    render: (params: { optionalContentConfigPromise?: Promise<unknown> }) => {
      renders.push(params);
      return { promise: Promise.resolve() };
    },
  };
  const doc: Record<string, unknown> = { numPages: 1, getPage: async () => page };
  if (scenario.config === 'reject') {
    doc.getOptionalContentConfig = () => Promise.reject(new Error('bad /OCProperties'));
  } else if (scenario.config !== 'missing') {
    const config = scenario.config;
    doc.getOptionalContentConfig = async () => config;
  }
  const lib = {
    OPS: { ...OPS, beginMarkedContentProps: 70 },
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: () => ({
      onProgress: null,
      _worker: { port },
      destroy: async () => undefined,
      promise: Promise.resolve(doc),
    }),
  };
  return { lib, port, renders };
}

type Posted = { id: string; ok: boolean; kind?: string; error?: string; pngDataUri?: string };

/** Mount the provider; run its runtime + page scripts in a VM window. */
async function loadPage(scenario: Scenario) {
  await renderHook(usePdfRasterizer, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <PdfRasterizerProvider>{children}</PdfRasterizerProvider>
    ),
  });
  const html = jest.mocked(writeServedText).mock.calls.at(-1)?.[1] ?? '';
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
  const runtime = scripts.find((s) => s.includes('__inkPlanLayers'));
  const page = scripts.at(-1);
  expect(runtime).toBeDefined();
  expect(page).toContain('WORKER_FILTERS_LAYERS = true');
  const posted: Posted[] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ fillStyle: '', fillRect: () => undefined }),
    toDataURL: () => 'data:image/png;base64,PNG',
  };
  const scripted = scriptedPdfjs(scenario);
  const window: Record<string, unknown> = {
    location: { href: 'http://127.0.0.1:8080/.rasterizer/index.html' },
    URL: NodeURL,
    Blob: NodeBlob,
    document: { getElementById: () => canvas },
    setTimeout,
    clearTimeout,
    pdfjsLib: scripted.lib,
    ReactNativeWebView: {
      postMessage: (message: string) => posted.push(JSON.parse(message) as Posted),
    },
  };
  window.window = window;
  window.globalThis = window;
  runInNewContext(runtime!, window);
  runInNewContext(page!, window);
  const render = async (nativePage: object | null = null) => {
    await act(async () => {
      runInNewContext(
        `window.__pdfRender('r1', 0, 2048, 'http://127.0.0.1:8080/maps/m.pdf', null, ${JSON.stringify(nativePage)})`,
        window,
      );
      for (let i = 0; i < 20 && !posted.some((m) => m.id === 'r1'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    return posted.find((m) => m.id === 'r1');
  };
  return { ...scripted, render, window };
}

const NATIVE_PAGE = { expectedPageWidthPt: 1000, expectedPageHeightPt: 800 };

it('hides imagery for paint and for the worker, with the same visibility map', async () => {
  const config = fakeConfig({
    '1R': { name: 'Orthoimage', visible: true },
    '2R': { name: 'Contours', visible: true },
    '3R': { name: 'Shaded Relief', visible: false },
  });
  const { render, port, renders } = await loadPage({ config });
  const result = await render();
  expect(result).toMatchObject({ ok: true, pngDataUri: 'data:image/png;base64,PNG' });
  expect(config.setVisibility).toHaveBeenCalledTimes(1);
  expect(config.setVisibility).toHaveBeenCalledWith('1R', false);
  expect(port.postMessage).toHaveBeenCalledWith({
    inukshukOptionalContent: { '1R': false, '2R': true, '3R': false },
    inukshukOps: OPS,
  });
  expect(renders).toHaveLength(1);
  await expect(renders[0]?.optionalContentConfigPromise).resolves.toBe(config);
});

it('keeps a page whose layers were changed away from the native renderer', async () => {
  const config = fakeConfig({ '1R': { name: 'Orthoimage', visible: true } });
  const { render } = await loadPage({ config });
  const result = await render(NATIVE_PAGE);
  expect(result?.kind).toBeUndefined();
  expect(result?.pngDataUri).toBe('data:image/png;base64,PNG');
});

it('hands a 2024 US Topo (imagery under a hidden "Images" parent) to the native renderer', async () => {
  // Switching Orthoimage off changes nothing drawn: its parent is already off
  // by default, so the native renderer's default-layer picture is identical.
  const config = fakeConfig({
    '1R': { name: 'Images', visible: false },
    '2R': { name: 'Orthoimage', visible: true },
    '3R': { name: 'Contours', visible: true },
  });
  const { render } = await loadPage({ config });
  const result = await render(NATIVE_PAGE);
  expect(result).toMatchObject({ ok: true, kind: 'native-geometry' });
  expect(config.setVisibility).toHaveBeenCalledWith('2R', false);
});

it('still hands a page at its default layers to the native renderer', async () => {
  const config = fakeConfig({ '2R': { name: 'Contours', visible: true } });
  const { render, port } = await loadPage({ config });
  const result = await render(NATIVE_PAGE);
  expect(result).toMatchObject({ ok: true, kind: 'native-geometry' });
  // Nothing changed, but the worker still learns the defaults it can skip.
  expect(port.postMessage).toHaveBeenCalledWith({
    inukshukOptionalContent: { '2R': true },
    inukshukOps: OPS,
  });
});

it.each([
  ['a document without layers', { config: fakeConfig(null) }],
  ['an unreadable layer config', { config: 'reject' as const }],
  ['a pdf.js without layer support', { config: 'missing' as const }],
])('renders %s with pdf.js defaults and an unfiltered worker', async (_label, scenario) => {
  const { render, port, renders, window } = await loadPage(scenario);
  const result = await render();
  expect(result).toMatchObject({ ok: true, pngDataUri: 'data:image/png;base64,PNG' });
  expect(renders[0]?.optionalContentConfigPromise).toBeUndefined();
  // Cleared, never left holding a previous document's map (fake worker).
  for (const call of port.postMessage.mock.calls) {
    expect(call[0]).toEqual({ inukshukOptionalContent: null, inukshukOps: OPS });
  }
  const filter = window.__inkOC as { visible(g: unknown): boolean };
  expect(filter.visible({ type: 'OCG', id: '1R' })).toBe(true);
});
