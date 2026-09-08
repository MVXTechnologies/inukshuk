import { reportError } from '@lib/errorReporting';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { ExpoWebGLRenderingContext } from 'expo-gl';
import React from 'react';
import { View } from 'react-native';
import * as THREE from 'three';
import { ManagedGLView, disposeGroup, runRenderLoop, type GlLifetime } from './glLifecycle';

jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));

jest.mock('expo-gl', () => ({ GLView: jest.requireActual('react-native').View }));

it('stops drawing and releases resources when only the GL child is removed', async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const raf = jest.spyOn(global, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.set(++frameId, cb);
    return frameId;
  });
  const cancel = jest.spyOn(global, 'cancelAnimationFrame').mockImplementation((id) => {
    if (typeof id === 'number') frames.delete(id);
  });
  const renderer = { render: jest.fn(), dispose: jest.fn() } as unknown as THREE.WebGLRenderer;
  const gl = { endFrameEXP: jest.fn() } as unknown as ExpoWebGLRenderingContext;
  function Harness({ visible }: { visible: boolean }) {
    return visible ? (
      <ManagedGLView
        testID="gl"
        onContextCreate={(_gl, lifetime) => {
          lifetime.onDispose(() => renderer.dispose());
          runRenderLoop({
            lifetime,
            gl,
            scene: new THREE.Scene(),
            camera: new THREE.Camera(),
            renderer,
            onFrame: () => {},
          });
        }}
      />
    ) : (
      <View testID="2d" />
    );
  }
  try {
    const view = await render(<Harness visible />);
    await fireEvent(view.getByTestId('gl'), 'contextCreate', gl);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    await view.rerender(<Harness visible={false} />);
    await act(() => {
      const queued = [...frames.values()];
      frames.clear();
      for (const frame of queued) frame(1);
    });
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    await view.unmount();
  } finally {
    raf.mockRestore();
    cancel.mockRestore();
  }
});

it('disposes a pending context immediately on replacement and rejects late resources', async () => {
  const lifetimes: GlLifetime[] = [];
  const disposers: jest.Mock[] = [];
  const view = await render(
    <ManagedGLView
      testID="gl"
      onContextCreate={(_gl, lifetime) => {
        lifetimes.push(lifetime);
        const dispose = jest.fn();
        disposers.push(dispose);
        lifetime.onDispose(dispose);
      }}
    />,
  );
  const gl = {} as ExpoWebGLRenderingContext;
  await fireEvent(view.getByTestId('gl'), 'contextCreate', gl);
  await fireEvent(view.getByTestId('gl'), 'contextCreate', gl);
  expect(disposers[0]).toHaveBeenCalledTimes(1);
  expect(disposers[1]).not.toHaveBeenCalled();
  expect(lifetimes[0]?.isCurrent()).toBe(false);
  expect(lifetimes[1]?.isCurrent()).toBe(true);
  const lateDispose = jest.fn();
  lifetimes[0]?.onDispose(lateDispose);
  expect(lateDispose).toHaveBeenCalledTimes(1);
  await view.unmount();
  expect(disposers[0]).toHaveBeenCalledTimes(1);
  expect(disposers[1]).toHaveBeenCalledTimes(1);
});

it('disposes resources during a failed frame and stops scheduling frames', async () => {
  const raf = jest.spyOn(global, 'requestAnimationFrame');
  const dispose = jest.fn();
  const renderer = {
    render: () => {
      throw new Error('context lost');
    },
  } as unknown as THREE.WebGLRenderer;
  const gl = {} as ExpoWebGLRenderingContext;
  let failure: unknown;
  const view = await render(
    <ManagedGLView
      testID="gl"
      onContextCreate={(_gl, lifetime) => {
        lifetime.onDispose(dispose);
        runRenderLoop({
          lifetime,
          gl,
          renderer,
          scene: new THREE.Scene(),
          camera: new THREE.Camera(),
          onFrame: () => {},
          onError: (error) => {
            failure = error;
          },
        });
      }}
    />,
  );
  try {
    await fireEvent(view.getByTestId('gl'), 'contextCreate', gl);
    expect(failure).toEqual(new Error('context lost'));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(raf).not.toHaveBeenCalled();
    await view.unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  } finally {
    raf.mockRestore();
  }
});

it('ignores a native context callback delivered after the GL child unmounts', async () => {
  const create = jest.fn();
  const view = await render(<ManagedGLView testID="gl" onContextCreate={create} />);
  const nativeCallback = view.getByTestId('gl').props.onContextCreate;
  await view.unmount();
  await act(() => nativeCallback({}));
  expect(create).not.toHaveBeenCalled();
});

it('releases renderer resources while an async terrain build is still pending', async () => {
  const rendererDispose = jest.fn();
  const geometry = new THREE.BufferGeometry();
  const geometryDispose = jest.spyOn(geometry, 'dispose');
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
  let finishBuild: ((group: THREE.Group) => void) | undefined;
  const pending = new Promise<THREE.Group>((resolve) => {
    finishBuild = resolve;
  });
  let finished: Promise<void> | undefined;
  const view = await render(
    <ManagedGLView
      testID="gl"
      onContextCreate={(_gl, lifetime) => {
        lifetime.onDispose(rendererDispose);
        finished = pending.then((built) => {
          lifetime.onDispose(() => disposeGroup(built));
        });
      }}
    />,
  );
  await fireEvent(view.getByTestId('gl'), 'contextCreate', {});
  await view.unmount();
  expect(rendererDispose).toHaveBeenCalledTimes(1);
  expect(geometryDispose).not.toHaveBeenCalled();
  await act(async () => {
    finishBuild?.(group);
    await finished;
  });
  expect(geometryDispose).toHaveBeenCalledTimes(1);
  expect(rendererDispose).toHaveBeenCalledTimes(1);
});

it('continues cleanup and starts the replacement context when a disposer throws', async () => {
  const released = jest.fn();
  const lifetimes: GlLifetime[] = [];
  const cleanupFailure = new Error('native disposal failed');
  const view = await render(
    <ManagedGLView
      testID="gl"
      onContextCreate={(_gl, lifetime) => {
        lifetimes.push(lifetime);
        lifetime.onDispose(released);
        lifetime.onDispose(() => {
          throw cleanupFailure;
        });
      }}
    />,
  );
  await fireEvent(view.getByTestId('gl'), 'contextCreate', {});
  await fireEvent(view.getByTestId('gl'), 'contextCreate', {});
  expect(lifetimes).toHaveLength(2);
  expect(lifetimes[0]?.isCurrent()).toBe(false);
  expect(lifetimes[1]?.isCurrent()).toBe(true);
  expect(released).toHaveBeenCalledTimes(1);
  expect(reportError).toHaveBeenCalledWith(cleanupFailure, 'terrain3d-cleanup');
  expect(() =>
    lifetimes[0]?.onDispose(() => {
      throw cleanupFailure;
    }),
  ).not.toThrow();
  await view.unmount();
  expect(released).toHaveBeenCalledTimes(2);
});

it('releases other scene resources after one geometry disposer fails', () => {
  const group = new THREE.Group();
  const badGeometry = new THREE.BufferGeometry();
  const goodGeometry = new THREE.BufferGeometry();
  const material = new THREE.MeshBasicMaterial();
  const geometryDispose = jest.spyOn(goodGeometry, 'dispose');
  const materialDispose = jest.spyOn(material, 'dispose');
  const error = new Error('geometry disposal failed');
  jest.spyOn(badGeometry, 'dispose').mockImplementation(() => {
    throw error;
  });
  group.add(new THREE.Mesh(badGeometry, material));
  group.add(new THREE.Mesh(goodGeometry));
  expect(() => disposeGroup(group)).not.toThrow();
  expect(geometryDispose).toHaveBeenCalledTimes(1);
  expect(materialDispose).toHaveBeenCalledTimes(1);
  expect(reportError).toHaveBeenCalledWith(error, 'terrain3d-cleanup');
});

it('reports the original frame error even when releasing resources also fails', async () => {
  const frameFailure = new Error('frame failed');
  const onError = jest.fn();
  const view = await render(
    <ManagedGLView
      testID="gl"
      onContextCreate={(_gl, lifetime) => {
        lifetime.onDispose(() => {
          throw new Error('cleanup failed');
        });
        runRenderLoop({
          lifetime,
          gl: {} as ExpoWebGLRenderingContext,
          scene: new THREE.Scene(),
          camera: new THREE.Camera(),
          renderer: {
            render: () => {
              throw frameFailure;
            },
          } as unknown as THREE.WebGLRenderer,
          onFrame: () => {},
          onError,
        });
      }}
    />,
  );
  await fireEvent(view.getByTestId('gl'), 'contextCreate', {});
  expect(onError).toHaveBeenCalledWith(frameFailure);
  await view.unmount();
});
