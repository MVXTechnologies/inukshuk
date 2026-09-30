import {
  activitiesLabel,
  countriesLabel,
  formatClimb,
  formatDistanceFrom,
  formatTrailLength,
  stagesLabel,
  trailCardMeta,
  trailListMeta,
  trailPlaceLabel,
} from './format';
import { sampleIndex, trailById } from './__fixtures__/trails';

const index = sampleIndex();
const NB = ' ';

describe('trail formatting', () => {
  it('formats lengths as approximations', () => {
    expect(formatTrailLength(43.3, 'metric')).toBe('≈43 km');
    expect(formatTrailLength(1600.4, 'metric')).toBe(`≈1${NB}600 km`);
    expect(formatTrailLength(8.26, 'metric')).toBe('≈8.3 km');
    expect(formatTrailLength(50, 'imperial')).toBe('≈31 mi');
    expect(formatTrailLength(0, 'metric')).toBe('— km');
  });

  it('formats how far you are', () => {
    expect(formatDistanceFrom(347, 'metric')).toBe('350 m');
    expect(formatDistanceFrom(1234, 'metric')).toBe('1.2 km');
    expect(formatDistanceFrom(17_050, 'metric')).toBe('17 km');
    expect(formatDistanceFrom(1_234_000, 'metric')).toBe(`1${NB}234 km`);
    expect(formatDistanceFrom(100, 'imperial')).toBe('330 ft');
    expect(formatDistanceFrom(5000, 'imperial')).toBe('3.1 mi');
    expect(formatDistanceFrom(50_000, 'imperial')).toBe('31 mi');
  });

  it('places long trails by country', () => {
    const long = { ...trailById(index, 'r391736'), lengthKm: 3000 };
    expect(trailPlaceLabel(long, index.countries)).toBe('United States');
    expect(trailPlaceLabel({ ...long, countries: [] }, index.countries)).toBe('Vermont');
  });

  it('formats climb to the nearest 10', () => {
    expect(formatClimb(1847, 'metric')).toBe(`≈1${NB}850 m`);
    expect(formatClimb(1000, 'imperial')).toBe(`≈3${NB}280 ft`);
  });

  it('labels activities, stages and countries', () => {
    expect(activitiesLabel(['hiking', 'skiing'])).toBe('Hiking · Skiing');
    expect(stagesLabel(1)).toBe('1 stage');
    expect(stagesLabel(4)).toBe('4 stages');
    expect(countriesLabel(['FR', 'IT', 'XX'], index.countries)).toBe('France, Italy');
    expect(countriesLabel(['XX'], index.countries)).toBeNull();
  });

  it('says where a trail is', () => {
    expect(trailPlaceLabel(trailById(index, 'r416109'), index.countries)).toBe('Québec → Montréal');
    expect(trailPlaceLabel(trailById(index, 'r9454'), index.countries)).toBe(
      'France, Italy, Switzerland',
    );
    expect(trailPlaceLabel(trailById(index, 'r391736'), index.countries)).toBe('Vermont');
    const bare = { ...trailById(index, 'r391736'), region: undefined };
    expect(trailPlaceLabel(bare, index.countries)).toBe('United States');
  });

  it('builds the card and row meta lines', () => {
    expect(trailCardMeta(trailById(index, 'r8730405'), 'metric')).toBe(
      'Hiking · ≈43 km · 4 stages',
    );
    expect(trailListMeta(trailById(index, 'r391736'), index.countries, 'metric')).toBe(
      'Hiking · Vermont · ≈440 km',
    );
  });
});
