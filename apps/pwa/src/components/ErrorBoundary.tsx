import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Error boundary.
 *
 * Without one, a render-time exception unmounts the tree and React leaves a
 * blank white area behind — no message, nothing in the UI to act on. That is
 * exactly how a real bug hid here: after login the app held a profile object
 * missing its `subscriptions` list, Settings called `.map()` on `undefined`, and
 * the tab simply rendered nothing. It looked like "the tab doesn't work" rather
 * than "the app crashed", which is a far harder thing to report or diagnose.
 *
 * A crash should be loud.
 */
interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Render error:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="mx-auto max-w-md px-6 py-16">
        <h1 className="text-lg font-semibold text-red-700">Something broke</h1>
        <p className="mt-2 text-sm text-neutral-600">
          This screen failed to render. Reloading usually fixes it; if it keeps
          happening, the message below is what to report.
        </p>
        <pre className="mt-3 overflow-x-auto rounded border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-700">
          {error.message}
        </pre>
        <button
          onClick={() => location.reload()}
          className="mt-4 w-full rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white"
        >
          Reload
        </button>
      </div>
    );
  }
}
