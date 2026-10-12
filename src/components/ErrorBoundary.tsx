import { Component, ErrorInfo, ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep details in the console for debugging without exposing them to users.
    console.error("Unhandled application render error:", error, info.componentStack);
  }

  private reload = () => window.location.reload();

  render() {
    if (this.state.hasError) {
      return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center text-foreground">
          <h1 className="text-2xl font-semibold">Something went wrong</h1>
          <p className="text-muted-foreground">The page ran into a problem. Reload to try again.</p>
          <button className="rounded-md bg-primary px-4 py-2 text-primary-foreground" onClick={this.reload}>
            Reload
          </button>
        </main>
      );
    }

    return this.props.children;
  }
}
