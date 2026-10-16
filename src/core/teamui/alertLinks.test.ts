import { rallyUrl, sosUrl, withTeam } from './alerts';

describe('alert links that name their team', () => {
  it('adds the team as a query parameter, escaped', () => {
    expect(withTeam(sosUrl('julie', 's1'), 'AbC-_9')).toBe('/team/sos/julie/s1?team=AbC-_9');
    expect(withTeam('/team/sos/a/b?x=1', 'a b')).toBe('/team/sos/a/b?x=1&team=a%20b');
  });

  it('leaves a link alone without a team', () => {
    expect(withTeam(rallyUrl('noe', 'r1'), '')).toBe('/team/rally/noe/r1');
  });
});
