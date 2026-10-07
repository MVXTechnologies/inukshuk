import { createResizeHostController, RESIZER_PAGE_PATH } from './resizeHostController';

jest.mock('expo-modules-core', () => ({
  ...jest.requireActual<object>('expo-modules-core'),
  uuid: { v4: jest.fn() },
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
jest.mock('@data/photos/inbox', () => ({
  extensionOf: () => 'jpg',
  stageForResize: jest.fn(async (_src: string, jobId: string) => `.photo-inbox/${jobId}.jpg`),
  unstage: jest.fn(),
}));
const mockRelease = jest.fn(async () => undefined);
const mockLease = {
  value: 'http://127.0.0.1:8080/s3cr3t-s3cr3t-s3cr3t-s3cr3t-0000',
  release: mockRelease,
};
jest.mock('@data/localServer', () => ({
  acquireLocalServer: jest.fn(async () => mockLease),
  probeLocalServer: jest.fn(async () => true),
  restartLocalServer: jest.fn(async () => 'http://127.0.0.1:9090/s3cr3t-s3cr3t-s3cr3t-s3cr3t-0000'),
  writeServedText: jest.fn(),
}));

const { uuid } = jest.requireMock('expo-modules-core') as { uuid: { v4: jest.Mock } };
const inbox = jest.requireMock('@data/photos/inbox') as {
  stageForResize: jest.Mock;
  unstage: jest.Mock;
};
const server = jest.requireMock('@data/localServer') as {
  probeLocalServer: jest.Mock;
  writeServedText: jest.Mock;
};
const errors = jest.requireMock('@lib/errorReporting') as { reportError: jest.Mock };

const out = { base64: 'QQ==', width: 1, height: 1 };

function setup() {
  const urls: string[] = [];
  const host = createResizeHostController((u) => urls.push(u));
  const injected: string[] = [];
  const view = { injectJavaScript: (s: string) => injected.push(s), reload: jest.fn() };
  host.attach(view);
  return { host, urls, injected, view };
}

/** Answer the job the page was given. */
function reply(host: ReturnType<typeof setup>['host'], injected: string[]) {
  const job = JSON.parse(/\((\{.*\})\)/.exec(injected[injected.length - 1]!)![1]!) as {
    id: string;
  };
  host.resizer.handleMessage(
    JSON.stringify({ type: 'resized', id: job.id, display: out, thumb: out, sprite: out }),
  );
  return job;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  uuid.v4.mockReset();
  uuid.v4.mockReturnValueOnce('1b4e28ba-2fa1-11d2-883f-0016d3cca427');
  inbox.unstage.mockReset();
  server.probeLocalServer.mockResolvedValue(true);
});

it('serves the worker page from the inbox through the lease', async () => {
  const { host, urls } = setup();
  await host.start();
  expect(server.writeServedText).toHaveBeenCalledWith(RESIZER_PAGE_PATH, expect.any(String));
  expect(urls).toHaveLength(1);
  expect(urls[0]).toMatch(new RegExp(`^${mockLease.value}/\\.photo-inbox/worker\\.html\\?v=`));
});

it('names staged jobs with a CSPRNG uuid and deletes them after the job', async () => {
  const { host, injected } = setup();
  await host.start();
  host.resizer.handleMessage(JSON.stringify({ type: 'ready' }));
  const done = host.resizer.resize('file:///cache/picked.jpg');
  await flush();
  await flush();
  const job = reply(host, injected);
  await expect(done).resolves.toMatchObject({ display: out });
  expect(job.id).toBe('1b4e28ba-2fa1-11d2-883f-0016d3cca427');
  expect(inbox.stageForResize).toHaveBeenCalledWith('file:///cache/picked.jpg', job.id);
  expect(inbox.unstage).toHaveBeenCalledWith(`.photo-inbox/${job.id}.jpg`);
  expect(injected[0]).toContain(`${mockLease.value}/.photo-inbox/${job.id}.jpg`);
});

it('deletes a half-copied staged file when staging fails', async () => {
  const { host } = setup();
  await host.start();
  inbox.stageForResize.mockRejectedValueOnce(new Error('disk full'));
  await expect(host.resizer.resize('file:///cache/picked.jpg')).rejects.toThrow('disk full');
  expect(inbox.unstage).toHaveBeenCalledWith(
    '.photo-inbox/1b4e28ba-2fa1-11d2-883f-0016d3cca427.jpg',
  );
});

it('reloads the page from a restarted server before the next job', async () => {
  const { host, urls, injected } = setup();
  await host.start();
  host.resizer.handleMessage(JSON.stringify({ type: 'ready' }));
  server.probeLocalServer.mockResolvedValueOnce(false);
  const done = host.resizer.resize('file:///cache/picked.jpg');
  await flush();
  await flush();
  // The page is re-served from the new origin, and the job waits for its ready.
  expect(urls[1]).toMatch(/^http:\/\/127\.0\.0\.1:9090\//);
  expect(injected).toHaveLength(0);
  host.resizer.handleMessage(JSON.stringify({ type: 'ready' }));
  await flush();
  reply(host, injected);
  await done;
  expect(injected[0]).toContain('127.0.0.1:9090');
});

it('releases the server and fails pending jobs on stop', async () => {
  const { host } = setup();
  await host.start();
  host.stop();
  await flush();
  expect(mockRelease).toHaveBeenCalled();
  await expect(host.resizer.resize('file:///x.jpg')).rejects.toThrow('closed');
});

it('reports a server that cannot start', async () => {
  const acquire = (jest.requireMock('@data/localServer') as { acquireLocalServer: jest.Mock })
    .acquireLocalServer;
  acquire.mockRejectedValueOnce(new Error('no port'));
  const { host, urls } = setup();
  await host.start();
  expect(urls).toEqual([]);
  expect(errors.reportError).toHaveBeenCalledWith(expect.any(Error), 'photo-resizer-server');
  await expect(host.resizer.resize('file:///x.jpg')).rejects.toThrow('no port');
});

it('forwards a process death to the resizer and detaches cleanly', async () => {
  const { host } = setup();
  await host.start();
  host.processGone();
  host.attach(null);
  host.stop();
});
