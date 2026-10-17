import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BLOCKED_ANDROID_PERMISSIONS,
  REMOVED_ANDROID_SERVICES,
  mediaPermissionProblems,
} from './mediaPermissions.mjs';

const CAMERA =
  'Inukshuk uses the camera to attach photos to trail notes and to scan team invite QR codes.';

/** @param {{ $: Record<string, string> }[]} [extra] */
function manifest(extra = []) {
  return {
    manifest: {
      'uses-permission': [
        { $: { 'android:name': 'android.permission.INTERNET' } },
        { $: { 'android:name': 'android.permission.CAMERA' } },
        ...BLOCKED_ANDROID_PERMISSIONS.map((name) => ({
          $: { 'android:name': name, 'tools:node': 'remove' },
        })),
        ...extra,
      ],
      application: [
        {
          service: REMOVED_ANDROID_SERVICES.map((name) => ({
            $: { 'android:name': name, 'tools:node': 'remove' },
          })),
        },
      ],
    },
  };
}

describe('mediaPermissionProblems (R-RTC-5)', () => {
  it('passes a data-only config that keeps our camera string', () => {
    assert.deepEqual(
      mediaPermissionProblems({
        infoPlist: { NSCameraUsageDescription: CAMERA },
        manifest: manifest(),
      }),
      [],
    );
  });

  it('flags a microphone purpose string and a generic camera string', () => {
    assert.deepEqual(
      mediaPermissionProblems({
        infoPlist: {
          NSMicrophoneUsageDescription: 'Allow $(PRODUCT_NAME) to access your microphone',
          NSCameraUsageDescription: 'Allow $(PRODUCT_NAME) to access your camera',
        },
        manifest: manifest(),
      }),
      [
        'iOS declares NSMicrophoneUsageDescription',
        'iOS NSCameraUsageDescription is a library default: "Allow $(PRODUCT_NAME) to access your camera"',
      ],
    );
  });

  it('flags a missing camera string (the QR scanner and note photos need it)', () => {
    assert.deepEqual(mediaPermissionProblems({ infoPlist: {}, manifest: manifest() }), [
      'iOS lacks NSCameraUsageDescription',
    ]);
  });

  it('flags RECORD_AUDIO requested next to its block', () => {
    const problems = mediaPermissionProblems({
      infoPlist: { NSCameraUsageDescription: CAMERA },
      manifest: manifest([{ $: { 'android:name': 'android.permission.RECORD_AUDIO' } }]),
    });
    assert.deepEqual(problems, ['Android requests android.permission.RECORD_AUDIO']);
  });

  it('requires every block and the service removal to be explicit', () => {
    const bare = { manifest: { 'uses-permission': [], application: [{}] } };
    const problems = mediaPermissionProblems({
      infoPlist: { NSCameraUsageDescription: CAMERA },
      manifest: bare,
    });
    assert.equal(problems.length, BLOCKED_ANDROID_PERMISSIONS.length + 1);
    assert.ok(
      problems.includes(
        'Android does not block android.permission.RECORD_AUDIO (tools:node="remove")',
      ),
    );
    assert.ok(
      problems.includes(
        'Android does not remove the com.oney.WebRTCModule.MediaProjectionService service',
      ),
    );
  });

  it('fails closed without a manifest', () => {
    assert.deepEqual(
      mediaPermissionProblems({
        infoPlist: { NSCameraUsageDescription: CAMERA },
        manifest: undefined,
      }),
      ['no Android manifest in the introspected config'],
    );
  });
});
