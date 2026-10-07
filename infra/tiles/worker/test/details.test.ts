/**
 * Index + packed-details routing (trails, climbing). Pure, run by the app's
 * Jest (the Worker project has no test runner of its own).
 */
import { detailKeys, detailRoute } from '../src/details';

describe('detailRoute', () => {
  it('routes the trails index and details as before', () => {
    expect(detailRoute('/trails/v1/index.json')).toEqual({ dataset: 'trails', kind: 'index' });
    expect(detailRoute('/trails/v1/d/202609281014/r123456.json')).toEqual({
      dataset: 'trails',
      kind: 'detail',
      version: '202609281014',
      id: 'r123456',
    });
  });

  it('routes climbing crags by uid', () => {
    expect(detailRoute('/climbing/v1/index.json')).toEqual({ dataset: 'climbing', kind: 'index' });
    for (const id of ['ob-73f38626da051606', 'osm-r11876741', 'osm-n42', 'c2c-1957188']) {
      expect(detailRoute(`/climbing/v1/d/202610052200/${id}.json`)).toEqual({
        dataset: 'climbing',
        kind: 'detail',
        version: '202610052200',
        id,
      });
    }
  });

  it('refuses ids of the wrong dataset and anything else', () => {
    expect(detailRoute('/trails/v1/d/v1/ob-73f38626da051606.json')).toBeNull();
    expect(detailRoute('/climbing/v1/d/v1/r123.json')).toBeNull();
    expect(detailRoute('/climbing/v1/d/v1/osm-x1.json')).toBeNull();
    expect(detailRoute('/climbing/v1/d/v1/../secret.json')).toBeNull();
    expect(detailRoute('/climbing/v2/index.json')).toBeNull();
    expect(detailRoute('/peaks/v1/index.json')).toBeNull();
  });

  it('names the R2 objects the NAS uploads', () => {
    expect(detailKeys('climbing', '202610052200')).toEqual({
      index: 'climbing-v1.index.json',
      details: 'climbing-202610052200.details.bin',
      offsets: 'climbing-202610052200.offsets.json',
    });
  });
});
