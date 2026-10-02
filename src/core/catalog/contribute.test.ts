import {
  ORG_MAPS_CONTACT_EMAIL,
  ORG_MAPS_COPY,
  ORG_MAPS_ISSUE_BODY,
  ORG_MAPS_ISSUE_TITLE,
  orgMapsIssueUrl,
} from './contribute';

describe('orgMapsIssueUrl', () => {
  it('opens a new issue on the app repository', () => {
    expect(orgMapsIssueUrl()).toMatch(
      /^https:\/\/github\.com\/MVXTechnologies\/inukshuk\/issues\/new\?/,
    );
  });

  it('prefills a title and a body that round-trip', () => {
    const url = orgMapsIssueUrl();
    const query = url.slice(url.indexOf('?') + 1);
    const params = Object.fromEntries(
      query.split('&').map((pair) => {
        const [k = '', v = ''] = pair.split('=');
        return [k, decodeURIComponent(v)];
      }),
    );
    expect(params.title).toBe(ORG_MAPS_ISSUE_TITLE);
    expect(params.body).toBe(ORG_MAPS_ISSUE_BODY);
    // Encoded: no raw spaces or newlines in the URL.
    expect(url).not.toMatch(/[\s]/);
  });
});

describe('contact copy', () => {
  it('uses the company address', () => {
    expect(ORG_MAPS_CONTACT_EMAIL).toBe('marc-andre.vigneault@mvxtechnologies.com');
  });

  it('stays short', () => {
    expect(ORG_MAPS_COPY.title.length).toBeLessThanOrEqual(45);
    expect(ORG_MAPS_COPY.body.length).toBeLessThanOrEqual(100);
  });

  it('promises linking, never rehosting', () => {
    expect(ORG_MAPS_ISSUE_BODY).toMatch(/never rehosts/);
  });
});
