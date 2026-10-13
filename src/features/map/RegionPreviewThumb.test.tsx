import { render, screen, waitFor } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { RegionPreviewThumb } from './RegionPreviewThumb';

const mockDownload = jest.fn(async (url: string) => `file:///cache/${encodeURIComponent(url)}`);
jest.mock('@data/storage', () => ({
  downloadToCacheUri: (url: string) => mockDownload(url),
}));
jest.mock('./mapStyle', () => ({
  basemapTileUrl: () => 'https://imagery.example/{z}/{y}/{x}',
}));

const BOX = { minLng: -71.3, minLat: 46.76, maxLng: -71.15, maxLat: 46.85 };

beforeEach(() => mockDownload.mockClear());

async function draw(columns?: number) {
  await render(
    <PaperProvider>
      <RegionPreviewThumb
        bbox={BOX}
        basemap="satellite"
        tileUrl="unused"
        size={78}
        width={330}
        height={78}
        {...(columns !== undefined ? { columns } : {})}
      />
    </PaperProvider>,
  );
}

describe('RegionPreviewThumb', () => {
  it('draws one framing tile by default', async () => {
    await draw();
    await waitFor(() => expect(screen.getAllByTestId('preview-tile')).toHaveLength(1));
    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('preview-banner')).toBeNull();
  });

  it('draws a sharp banner from four deeper tiles, side by side (2.5.1 QA)', async () => {
    await draw(4);
    await waitFor(() => expect(screen.getByTestId('preview-banner')).toBeTruthy());
    const images = screen.getAllByTestId('preview-tile');
    expect(images).toHaveLength(4);
    expect(mockDownload).toHaveBeenCalledTimes(4);
    // Each tile is a quarter of the banner wide: ~1 tile px per screen px at 3x.
    for (const img of images) {
      expect(img.props.style).toMatchObject({ width: 330 / 4, height: 330 / 4 });
    }
    // Four distinct tiles, at one zoom.
    const urls = mockDownload.mock.calls.map((c) => c[0]);
    expect(new Set(urls).size).toBe(4);
    expect(new Set(urls.map((u) => u.split('/')[3])).size).toBe(1);
  });

  it('keeps the placeholder until every tile of the banner is in', async () => {
    mockDownload.mockImplementationOnce(() => new Promise<string>(() => undefined));
    await draw(4);
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(4));
    expect(screen.queryByTestId('preview-banner')).toBeNull();
  });
});
