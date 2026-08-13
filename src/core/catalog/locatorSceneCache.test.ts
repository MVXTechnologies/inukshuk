import { buildLocatorScene } from './locator';
import { LOCATOR_BASEMAP } from './locatorBasemap';
import {
  LOCATOR_SCENE_CACHE_MAX,
  clearLocatorSceneCache,
  locatorScene,
  locatorSceneCacheSize,
} from './locatorSceneCache';
import type { CatalogBbox } from './schema';

const bbox = (west: number): CatalogBbox => [west, 46, west + 0.5, 46.25];

describe('locatorScene', () => {
  beforeEach(() => clearLocatorSceneCache());

  it('returns exactly what buildLocatorScene returns', () => {
    const b = bbox(-71.5);
    expect(locatorScene(b, 100)).toEqual(buildLocatorScene(b, LOCATOR_BASEMAP, 100));
  });

  it('hands back the SAME object for a repeat bbox (that is the whole point)', () => {
    const first = locatorScene(bbox(-71.5), 100);
    const second = locatorScene(bbox(-71.5), 100);
    expect(second).toBe(first);
    expect(locatorSceneCacheSize()).toBe(1);
  });

  it('keys on size as well as bbox', () => {
    const at100 = locatorScene(bbox(-71.5), 100);
    const at56 = locatorScene(bbox(-71.5), 56);
    expect(at56).not.toBe(at100);
    expect(at100.size).toBe(100);
    expect(at56.size).toBe(56);
    expect(locatorSceneCacheSize()).toBe(2);
  });

  it('stays bounded — a 66k-item catalog must not retain a scene per row seen', () => {
    for (let i = 0; i < LOCATOR_SCENE_CACHE_MAX + 50; i += 1) {
      locatorScene(bbox(-140 + i * 0.01), 100);
    }
    expect(locatorSceneCacheSize()).toBe(LOCATOR_SCENE_CACHE_MAX);
  });

  it('evicts least-recently-USED, not least-recently-inserted', () => {
    const oldest = bbox(-140);
    const firstScene = locatorScene(oldest, 100);
    for (let i = 1; i < LOCATOR_SCENE_CACHE_MAX; i += 1) {
      locatorScene(bbox(-140 + i * 0.01), 100);
    }
    // Cache is exactly full and `oldest` is the least-recently inserted. Touch
    // it, then overflow by one: the entry inserted second should go instead.
    expect(locatorScene(oldest, 100)).toBe(firstScene);
    locatorScene(bbox(-10), 100);

    expect(locatorSceneCacheSize()).toBe(LOCATOR_SCENE_CACHE_MAX);
    expect(locatorScene(oldest, 100)).toBe(firstScene);
  });
});
