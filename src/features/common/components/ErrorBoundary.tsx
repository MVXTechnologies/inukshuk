import { reportError } from '@lib/errorReporting';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button, Text, useTheme } from 'react-native-paper';

/**
 * Top-level React error boundary: a render crash anywhere under the router
 * root shows a friendly recovery screen instead of a white screen / native
 * crash dialog, and the error (with its component stack) goes through the
 * error reporter.
 */

interface FallbackProps {
  error: Error;
  onRetry: () => void;
}

/** Function component so the paper theme hook works (light AND dark). */
function ErrorFallback({ error, onRetry }: FallbackProps) {
  const theme = useTheme();
  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.background }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text variant="headlineSmall" style={styles.title}>
          Something went wrong
        </Text>
        <Text variant="bodyMedium" style={styles.body}>
          Inukshuk hit an unexpected error. Your maps and recorded trails are safe. The error has
          been recorded and will be reported so it can be fixed.
        </Text>
        <Text
          variant="bodySmall"
          style={[styles.detail, { color: theme.colors.onSurfaceVariant }]}
          numberOfLines={4}
        >
          {error.message}
        </Text>
        <Button mode="contained" onPress={onRetry} style={styles.button}>
          Try again
        </Button>
      </ScrollView>
    </View>
  );
}

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    reportError(error, 'react-render', {
      isFatal: true,
      ...(typeof info.componentStack === 'string' ? { componentStack: info.componentStack } : {}),
    });
  }

  private readonly handleRetry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error !== null) {
      return <ErrorFallback error={this.state.error} onRetry={this.handleRetry} />;
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 16 },
  title: { textAlign: 'center' },
  body: { textAlign: 'center' },
  detail: { textAlign: 'center', fontStyle: 'italic' },
  button: { alignSelf: 'center', marginTop: 8 },
});
