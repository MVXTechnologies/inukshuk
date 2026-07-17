import {
  UPLOAD_POLL_SCHEDULE_MS,
  buildUploadFields,
  classifyUploadResponse,
  describeUploadOutcome,
  nextPollDelayMs,
} from './upload';

describe('buildUploadFields', () => {
  it('names the activity after the trail and anchors a stable external id', () => {
    expect(buildUploadFields('Sunrise ridge', 'abc123')).toEqual({
      name: 'Sunrise ridge',
      data_type: 'gpx',
      external_id: 'inukshuk-abc123',
    });
  });
});

describe('classifyUploadResponse', () => {
  it('classifies a fresh upload as processing under its id', () => {
    expect(
      classifyUploadResponse({
        id: 16486788,
        external_id: 'inukshuk-x',
        error: null,
        status: 'Your activity is still being processed.',
        activity_id: null,
      }),
    ).toEqual({ kind: 'processing', uploadId: 16486788 });
  });

  it('classifies a finished upload by its activity id', () => {
    expect(
      classifyUploadResponse({
        id: 1,
        error: null,
        status: 'Your activity is ready.',
        activity_id: 987,
      }),
    ).toEqual({ kind: 'ready', activityId: 987 });
  });

  it('classifies a ready status without an activity id', () => {
    expect(
      classifyUploadResponse({ id: 1, error: null, status: 'Your activity is ready.' }),
    ).toEqual({ kind: 'ready', activityId: null });
  });

  it('classifies a duplicate error', () => {
    expect(
      classifyUploadResponse({
        id: 1,
        error: '4459994.gpx duplicate of activity 5464621',
        status: 'There was an error processing your activity.',
        activity_id: null,
      }),
    ).toEqual({ kind: 'duplicate' });
  });

  it('classifies other errors with their message', () => {
    expect(
      classifyUploadResponse({ id: 1, error: 'The file is malformed', activity_id: null }),
    ).toEqual({ kind: 'error', message: 'The file is malformed' });
  });

  it('classifies a deleted activity as an error', () => {
    expect(
      classifyUploadResponse({ id: 1, error: null, status: 'The created activity is deleted.' }),
    ).toEqual({ kind: 'error', message: 'Activity was deleted on Strava' });
  });

  it.each([
    ['null', null],
    ['a string', 'oops'],
    ['a body with no id', { error: null, status: 'Your activity is still being processed.' }],
  ])('classifies %s as an error, never throws', (_name, input) => {
    expect(classifyUploadResponse(input).kind).toBe('error');
  });
});

describe('nextPollDelayMs', () => {
  it('walks the schedule then stops', () => {
    UPLOAD_POLL_SCHEDULE_MS.forEach((delay, i) => {
      expect(nextPollDelayMs(i)).toBe(delay);
    });
    expect(nextPollDelayMs(UPLOAD_POLL_SCHEDULE_MS.length)).toBeNull();
  });

  it('waits ~16 s in total before giving up', () => {
    const total = UPLOAD_POLL_SCHEDULE_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(10_000);
    expect(total).toBeLessThanOrEqual(20_000);
  });
});

describe('describeUploadOutcome', () => {
  it('describes each outcome in one line', () => {
    expect(describeUploadOutcome({ kind: 'ready' }, 'Sunrise')).toBe('Pushed "Sunrise" to Strava');
    expect(describeUploadOutcome({ kind: 'duplicate' }, 'Sunrise')).toBe(
      'Strava already has this activity',
    );
    expect(describeUploadOutcome({ kind: 'timeout' }, 'Sunrise')).toBe(
      'Sent to Strava — still processing there',
    );
    expect(describeUploadOutcome({ kind: 'error', message: 'bad file' }, 'Sunrise')).toBe(
      'Strava upload failed: bad file',
    );
  });
});
