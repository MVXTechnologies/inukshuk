import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { registerPhotoResizer } from './photoResizer';
import { createResizeHostController } from './resizeHostController';

/**
 * The hidden WebView that turns picked photos into the three copies (#587).
 * It loads the worker page (`resizeWorkerHtml()`, served from the loopback
 * server under `.photo-inbox/`, next to the staged photos, so page and image
 * share an origin) and forwards its messages to the resizer, which runs one
 * job at a time. The wiring lives in `createResizeHostController`.
 *
 * Mounted ONCE at the root, next to `PdfPrerenderWorker`. The inbox is
 * emptied at module load of the root layout (`clearPhotoInbox`), before this
 * mounts and before any import can start.
 */
export function PhotoResizeHost() {
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [host] = useState(() => createResizeHostController(setPageUrl));

  useEffect(() => {
    registerPhotoResizer(host.resizer);
    void host.start();
    return () => {
      registerPhotoResizer(null);
      host.stop();
    };
  }, [host]);

  if (pageUrl === null) return null;
  const processGone = () => {
    host.processGone();
    setGeneration((g) => g + 1);
  };
  return (
    <View style={styles.hidden} pointerEvents="none" collapsable={false}>
      <WebView
        key={generation}
        ref={(view) => host.attach(view)}
        source={{ uri: pageUrl }}
        originWhitelist={['*']}
        onMessage={(event) => host.resizer.handleMessage(event.nativeEvent.data)}
        // A (re)load starts: wait for the page's `ready` again.
        onLoadStart={() => host.resizer.reset()}
        // The OS killed the page's process (memory): mount a fresh WebView.
        onContentProcessDidTerminate={processGone}
        onRenderProcessGone={processGone}
        javaScriptEnabled
        // Self-contained page; it only ever talks to the app's own loopback server.
        allowFileAccess={false}
        allowUniversalAccessFromFileURLs={false}
        scalesPageToFit={false}
        cacheEnabled={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    left: -1000,
    top: -1000,
  },
});
